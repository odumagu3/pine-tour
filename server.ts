// MUST be first: populates process.env from .env.local before db.ts reads it.
import './src/load-env.js';
import express from 'express';
import type { Request as ExpressRequest } from 'express';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { GameState, Player, PlayerColor, WhotCard, CardSuit, GameLog, Transaction, UserProfile, AntiCheatAlert, ReferralSummary } from './src/types.js';
import {
  AdminConfig,
  loadAdminConfig, saveAdminConfig,
  loadProfile, persistProfile, recordTransaction, deleteProfile,
  ensureReferralCode, normalizeReferralCode, findEmailByReferralCode,
  createReferral, getPendingReferralFor, claimReferralReward, referralStats,
  createPayment, getPayment, creditPayment, markPaymentFailed,
  getWithdrawalPinHash, setWithdrawalPinHash,
} from './src/db.js';

const PORT = Number(process.env.PORT) || 5174;
const app = express();
// Keep the raw body around. Paystack signs webhooks as an HMAC over the exact
// bytes it sent, so re-serializing the parsed object would break verification
// on any key ordering or whitespace difference.
app.use(express.json({
  verify: (req, _res, buf) => { (req as any).rawBody = buf; },
}));

// CORS — in Option B the frontend (Vercel) and this backend (Render) are on
// different origins. FRONTEND_ORIGIN is a comma-separated allowlist; it defaults
// to '*' so local dev and same-origin serving keep working unchanged.
const allowedOrigins = (process.env.FRONTEND_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (allowedOrigins.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Create HTTP server
const server = http.createServer(app);

// In-memory caches. Supabase is the source of truth; profiles are loaded on
// demand and written through on every mutation. Live game rooms are intentionally
// ephemeral — an in-progress hand is not meant to survive a server restart.
const profileCache: Record<string, UserProfile> = {};
const gameRooms: Record<string, GameState> = {};
const activeConnections: Record<string, { ws: WebSocket; email: string; roomId: string }> = {};

// Helper to generate secure-looking hashes
function generateHash(): string {
  return 'tx_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Async: load a profile from Supabase into the cache if not already present.
// Call this from REST handlers and on WebSocket connect.
async function ensureProfile(email: string): Promise<UserProfile> {
  const cleanEmail = email.toLowerCase().trim();
  if (!profileCache[cleanEmail]) {
    profileCache[cleanEmail] = await loadProfile(cleanEmail);
  }
  return profileCache[cleanEmail];
}

// Synchronous cache accessor for hot game-loop paths. Humans are always loaded
// via ensureProfile() when they connect, so they are present here. If somehow
// missing, returns a fresh object and kicks off an async reload.
function getProfile(email: string): UserProfile {
  const cleanEmail = email.toLowerCase().trim();
  if (!profileCache[cleanEmail]) {
    profileCache[cleanEmail] = {
      email: cleanEmail, balance: 0, totalEarnings: 0, gamesPlayed: 0, gamesWon: 0,
      highestRoll: 0, tickets: 0, freeGameUsed: false, referralCode: '',
      hasWithdrawalPin: false, verificationStatus: 'unverified',
      verificationDetails: null, history: [],
    };
    ensureProfile(cleanEmail).catch(() => {});
  }
  return profileCache[cleanEmail];
}

// Fire-and-forget write-through of a cached profile to Supabase.
function saveProfile(email: string): void {
  const p = profileCache[email.toLowerCase().trim()];
  if (p) persistProfile(p).catch(err => console.error('saveProfile:', err));
}

// Append a ledger entry to the cached history AND persist it to Supabase.
function addTransaction(email: string, tx: Transaction): void {
  const p = profileCache[email.toLowerCase().trim()];
  if (p) p.history.unshift(tx);
  recordTransaction(email, tx).catch(err => console.error('addTransaction:', err));
}

// -----------------------------------------------------------------------------
// REFERRALS
//
// A signed-in player shares …/?ref=CODE. Whoever opens it while logged out has
// the code stashed on their device; it rides through sign-up and is claimed via
// POST /api/referral/claim. Nothing is paid out at that point — the referrer
// only earns their free ticket once that invitee actually BUYS tickets, and
// only up to REFERRAL_REWARD_CAP rewards in total.
//
// This is additive: the lifetime free game every new player already gets
// (freeGameEnabled / freeGameUsed) is untouched.
// -----------------------------------------------------------------------------
const REFERRAL_REWARD_TICKETS = 1;  // free tickets per qualifying referral
// The cap is admin-configurable (adminConfig.referralRewardCap, set in the
// panel's Ticket Economy section); 0 turns referral rewards off entirely.
// This constant is only the pre-load default, mirrored into adminConfig below.
const DEFAULT_REFERRAL_REWARD_CAP = 10;

// Where the shareable link points. PUBLIC_APP_URL wins (set it to the Vercel
// origin on Render); otherwise fall back to the caller's origin, then to the
// CORS allowlist. May be '' — the client fills in its own origin in that case.
function appBaseUrl(req: ExpressRequest): string {
  const explicit = (process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const origin = String(req.headers.origin || '').trim().replace(/\/+$/, '');
  if (origin) return origin;
  const allowed = allowedOrigins.find(o => o && o !== '*');
  return allowed ? allowed.replace(/\/+$/, '') : '';
}

// Tell a referrer, live, that they just earned a ticket (if they're connected).
function notifyReferralReward(email: string, tickets: number): void {
  const target = email.toLowerCase().trim();
  const message = tickets === 1
    ? 'Referral reward — someone you invited bought tickets. You earned 1 free ticket!'
    : `Referral reward — you earned ${tickets} free tickets!`;
  for (const cid of Object.keys(activeConnections)) {
    const c = activeConnections[cid];
    if (c.email.toLowerCase() === target && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(JSON.stringify({ type: 'referral-reward', tickets, message }));
    }
  }
}

// Credit the referrer when someone they invited buys tickets. Safe to call after
// every purchase: the pending referral row is consumed by the first qualifying
// call and ignored forever after.
async function awardReferralIfEligible(referredEmail: string): Promise<void> {
  const pending = await getPendingReferralFor(referredEmail);
  if (!pending) return; // not referred, or already paid out

  const referrer = pending.referrerEmail;
  const { rewarded } = await referralStats(referrer);
  if (rewarded >= adminConfig.referralRewardCap) {
    // Blocked by the cap — but the cap is admin-tunable, so leave the row
    // PENDING rather than burning it. Setting the cap to 0 has to be a pause,
    // not a permanent write-off: if the admin raises it again, this referral
    // is still eligible the next time the invitee buys.
    return;
  }

  // Compare-and-swap on the ledger row: only the caller that flips
  // pending → rewarded goes on to credit the ticket, so a double purchase
  // landing at the same instant can never pay out twice.
  const won = await claimReferralReward(pending.id);
  if (!won) return;

  const referrerProfile = await ensureProfile(referrer);
  referrerProfile.tickets += REFERRAL_REWARD_TICKETS;
  addTransaction(referrer, {
    id: generateHash(),
    type: 'ticket',
    amount: 0, // free — no money moved
    status: 'completed',
    timestamp: new Date().toISOString(),
    method: `Referral reward — ${REFERRAL_REWARD_TICKETS} free ticket${REFERRAL_REWARD_TICKETS === 1 ? '' : 's'}`,
    txHash: 'tx_ref_' + pending.id.slice(0, 8),
    balanceAfter: referrerProfile.balance,
  });
  saveProfile(referrer);
  notifyReferralReward(referrer, REFERRAL_REWARD_TICKETS);
}

// -----------------------------------------------------------------------------
// ADMIN CONFIGURATION (in-memory cache; Supabase is the source of truth).
// Loaded from Supabase at boot and written through on every admin save. These
// defaults are used before the first load and if persistence is unavailable.
// Controls arena, sponsor/prize, ticket economy and gameplay rules.
//
// Money model notes:
//   • The single active tournament reuses `fixedSponsorName` + `fixedPrize`.
//     A tournament is "active" only when BOTH are set (name non-empty, prize > 0).
//     Clear the sponsor name to show players "no tournaments available".
//   • `ticketPackPrice` is the PRICE PER TICKET; players buy any quantity between
//     MIN_TICKETS and MAX_TICKETS. `ticketPackSize`/`prizeMode`/`sponsorPool`/
//     `prizeMin`/`prizeMax` are legacy columns kept only for schema compatibility.
// -----------------------------------------------------------------------------
const MIN_TICKETS = 4;   // fewest tickets a player may buy at once
const MAX_TICKETS = 64;  // most tickets a player may buy at once
// Tournament field size (seats a bracket fills to with AI). Admin-configurable;
// clamped to [MIN, MAX] and used rounded to a multiple of 4 (full tables).
const DEFAULT_FIELD_SIZE = 16;
const MIN_FIELD_SIZE = 4;
const MAX_FIELD_SIZE = 128;

const adminConfig: AdminConfig = {
  arenaName: 'Neon Whot! Bet',
  defaultRoomId: 'Pine Arena',
  prizeMode: 'fixed',
  fixedSponsorName: 'IgniTech',
  fixedPrize: 100000,
  botRoster: [],
  prizeMin: 0,
  prizeMax: 0,
  ticketPackPrice: 300, // ₦ per ticket
  tournamentFieldSize: DEFAULT_FIELD_SIZE,
  freeGameEnabled: true,
  referralRewardCap: DEFAULT_REFERRAL_REWARD_CAP,
  turnTimerSeconds: 20,
  maxPlayers: 4,
  autoBotFill: true,
  adminEmails: ['hudozit@gmail.com'],
  adminPasscode: 'whot-admin',
};

function isAdminEmail(email: string): boolean {
  return adminConfig.adminEmails.map(e => e.toLowerCase()).includes((email || '').toLowerCase().trim());
}

// A tournament is only "active" when the admin has set BOTH a sponsor name and
// a positive cash prize. Otherwise players are shown "no tournaments available".
function isTournamentActive(): boolean {
  return adminConfig.fixedSponsorName.trim().length > 0 && adminConfig.fixedPrize > 0;
}

// The single, admin-controlled tournament (no random sponsors). When inactive,
// returns an empty sponsor and zero prize.
function currentTournament(): { sponsorName: string; prize: number; active: boolean } {
  const active = isTournamentActive();
  return {
    sponsorName: active ? adminConfig.fixedSponsorName.trim() : '',
    prize: active ? adminConfig.fixedPrize : 0,
    active,
  };
}

// Public-safe view of the config (never leaks the passcode). Exposes clean,
// purpose-named fields the frontend consumes; adminEmails only for admins.
function publicConfig(email?: string) {
  const admin = email ? isAdminEmail(email) : false;
  const t = currentTournament();
  const base = {
    arenaName: adminConfig.arenaName,
    roomName: adminConfig.defaultRoomId,
    tournamentActive: t.active,
    sponsorName: t.sponsorName,
    sponsorPrize: t.prize,
    ticketPrice: adminConfig.ticketPackPrice,
    minTickets: MIN_TICKETS,
    maxTickets: MAX_TICKETS,
    freeGameEnabled: adminConfig.freeGameEnabled,
    turnTimerSeconds: adminConfig.turnTimerSeconds,
    maxPlayers: adminConfig.maxPlayers,
    autoBotFill: adminConfig.autoBotFill,
    isAdmin: admin,
  };
  return admin ? { ...base, adminEmails: adminConfig.adminEmails } : base;
}

// Generate standard 54-card Whot! Deck
function createWhotDeck(): WhotCard[] {
  const deck: WhotCard[] = [];
  const suits: { suit: CardSuit; values: number[] }[] = [
    { suit: 'circle', values: [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14] },
    { suit: 'triangle', values: [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14] },
    { suit: 'cross', values: [1, 2, 3, 5, 7, 10, 11, 13, 14] },
    { suit: 'square', values: [1, 2, 3, 5, 7, 10, 11, 13, 14] },
    { suit: 'star', values: [1, 2, 3, 4, 5, 7, 8] },
  ];

  // Add suit cards
  suits.forEach(({ suit, values }) => {
    values.forEach((val, index) => {
      deck.push({
        id: `${suit}_${val}_${index}`,
        suit,
        value: val,
      });
    });
  });

  // Add 5 Whot (20) wildcard cards
  for (let i = 0; i < 5; i++) {
    deck.push({
      id: `whot_20_${i}`,
      suit: 'whot',
      value: 20,
    });
  }

  // Shuffle deck
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

// Helper to draw count cards from Market
function drawCardsFromMarket(room: GameState, count: number): WhotCard[] {
  const drawPile: WhotCard[] = (room as any).drawPile || [];
  const drawn: WhotCard[] = [];

  for (let i = 0; i < count; i++) {
    // The draw pile is a FINITE 54-card deck — no recycling of the discard.
    // When it empties, the market has "finished": the caller then runs the
    // elimination round (highest card total is knocked out). This keeps hands
    // bounded and makes the draw pile actually run out as intended.
    if (drawPile.length === 0) break;
    drawn.push(drawPile.shift()!);
  }

  room.drawPileCount = drawPile.length;
  return drawn;
}

// Initialize a default room or return existing
function getOrCreateRoom(roomId: string): GameState {
  if (!gameRooms[roomId]) {
    const sponsored = currentTournament();
    gameRooms[roomId] = {
      roomId,
      status: 'waiting',
      players: [],
      pot: sponsored.prize,
      activePlayerIndex: 0,
      logs: [
        {
          id: 'log_' + Date.now(),
          message: sponsored.active
            ? `🎟️ ${sponsored.sponsorName} Tournament open at "${roomId}" — ₦${sponsored.prize.toLocaleString('en-NG')} cash prize. Enter to play!`
            : `🎟️ Arena "${roomId}" is open. Waiting for the next tournament to be announced.`,
          type: 'system',
          timestamp: new Date().toISOString(),
        }
      ],
      turnTimeLeft: adminConfig.turnTimerSeconds,
      winnerPlayerId: null,
      potWinnerId: null,
      antiCheatLog: [],
      sponsorName: sponsored.sponsorName,
      sponsorPrize: sponsored.prize,
      drawPileCount: 0,
      discardPile: [],
      requestedSuit: null,
      turnDirection: 1,
    };
  }
  return gameRooms[roomId];
}

// Human-sounding opponent names. Bots are an implementation detail — to players
// these seats look and read exactly like other people at the table.
const OPPONENT_NAMES = [
  'Chidi', 'Amara', 'Tunde', 'Zainab', 'Emeka', 'Ngozi', 'Bola', 'Sadiq',
  'Ifeanyi', 'Yemi', 'Uche', 'Kemi', 'David', 'Grace', 'Musa', 'Chioma',
  'Damilola', 'Femi', 'Aisha', 'Obinna',
];

// The admin-chosen bot names (which bots may be seated). Falls back to defaults.
function botNamePool(): string[] {
  return adminConfig.botRoster.length ? adminConfig.botRoster : OPPONENT_NAMES;
}
// TEST: a bot name that wins any CASUAL "Enter Arena" game (bracket uses the
// per-entrant force-winner instead). In-memory only.
let casualForcedWinnerName = '';

// Fill remaining empty seats (up to the configured max) with opponents.
function fillSeatsWithBots(room: GameState) {
  if (!adminConfig.autoBotFill) return;
  const colors: PlayerColor[] = ['red', 'green', 'yellow', 'blue'];
  const cap = Math.min(Math.max(adminConfig.maxPlayers, 2), 4);
  const pool = botNamePool();
  while (room.players.length < cap) {
    const assigned = room.players.map(p => p.color).filter(Boolean) as PlayerColor[];
    const color = colors.find(c => !assigned.includes(c));
    if (!color) break;
    // Pick a bot name not already seated; seat the forced-winner bot first so
    // it's guaranteed a seat.
    const taken = new Set(room.players.map(p => p.name));
    const name = (casualForcedWinnerName && !taken.has(casualForcedWinnerName))
      ? casualForcedWinnerName
      : (pool.find(n => !taken.has(n)) || pool[Math.floor(Math.random() * pool.length)]);
    room.players.push({
      id: 'bot_' + color,
      name,
      color,
      isBot: true,
      balance: 0,
      currentBet: 0,
      ready: true,
      cardsCount: 0,
      hand: [],
      isConnected: true,
      highestRollInRound: 0,
      totalRollsCount: 0,
    });
    room.logs.push({
      id: 'log_join_' + Date.now() + '_' + Math.random().toString(36).substring(2, 5),
      message: `👤 ${name} seated on the ${color.toUpperCase()} seat!`,
      type: 'info',
      timestamp: new Date().toISOString(),
    });
  }
}

// When all seated humans have entered and there are at least 2 players, fill bots and deal.
function autoFillAndStartIfReady(room: GameState): boolean {
  const realPlayers = room.players.filter(p => !p.isBot);
  const allRealReady = realPlayers.length > 0 && realPlayers.every(p => p.ready);
  if (allRealReady && room.players.length >= 2) {
    fillSeatsWithBots(room);
    room.pot = room.sponsorPrize;
    startWhotGameSession(room);
    return true;
  }
  return false;
}

// Reset a finished room back to an open lobby for a brand-new tournament.
function resetRoomForNewTournament(room: GameState) {
  room.status = 'waiting';
  room.winnerPlayerId = null;
  room.potWinnerId = null;
  room.requestedSuit = null;
  room.turnDirection = 1;
  room.turnTimeLeft = adminConfig.turnTimerSeconds;
  room.activePlayerIndex = 0;
  room.discardPile = [];
  (room as any).drawPile = [];
  room.drawPileCount = 0;
  room.antiCheatLog = [];
  // Re-lock the current admin tournament for the new round.
  const sponsored = currentTournament();
  room.sponsorName = sponsored.sponsorName;
  room.sponsorPrize = sponsored.prize;
  room.pot = sponsored.prize;
  // Drop bots so seats reopen; reset seated humans.
  room.players = room.players.filter(p => !p.isBot);
  room.players.forEach(p => {
    p.ready = false;
    p.currentBet = 0;
    p.hand = [];
    p.cardsCount = 0;
  });
  room.logs.push({
    id: 'log_reset_' + Date.now(),
    message: sponsored.active
      ? `🔄 New ${sponsored.sponsorName} Tournament open — ₦${sponsored.prize.toLocaleString('en-NG')} cash prize. Enter to play!`
      : `🔄 Tournament ended. Waiting for the next one to be announced.`,
    type: 'system',
    timestamp: new Date().toISOString(),
  });
}

// Is this player the SILENT preselected winner for this room? Bracket tables use
// the per-tournament pick; All Hands uses allHandsForcedWinnerName; casual games
// use casualForcedWinnerName. All match by the relevant key. This is admin-only
// knowledge — it is never sent to clients, logged, or announced anywhere.
function isForcedWinner(roomId: string, p: Player): boolean {
  if (tournamentTableIds.has(roomId)) return !!tournament && tournament.forcedWinnerId === p.id;
  if (roomId === ALL_HANDS_ROOM) return !!allHandsForcedWinnerName && p.name === allHandsForcedWinnerName;
  return !!casualForcedWinnerName && p.name === casualForcedWinnerName;
}
function forcedPlayerInRoom(roomId: string, room: GameState): Player | undefined {
  return room.players.find(p => isForcedWinner(roomId, p));
}

// Broadcast game state to all clients in a room
function broadcastRoomState(roomId: string) {
  const state = gameRooms[roomId];
  if (!state) return;

  // Never reveal that a seat is a bot — to players every opponent is a human.
  // The preselected winner is NEVER flagged: no mark leaves the server, so the
  // rigged seat looks exactly like every other seat.
  const safeState = {
    ...state,
    players: state.players.map(p => ({ ...p, isBot: false })),
  };
  const payload = JSON.stringify({ type: 'state-sync', state: safeState });
  Object.keys(activeConnections).forEach(connId => {
    const conn = activeConnections[connId];
    if (conn.roomId === roomId && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(payload);
    }
  });
}

// End game logic
function endWhotGame(roomId: string, winnerId: string) {
  const room = gameRooms[roomId];
  if (!room || room.status !== 'playing') return;

  // TEST feature: if a silently preselected winner is at this table (All Hands
  // pick, bracket pick or casual forced winner), they win it — no announcement,
  // the result reads like any other win.
  const forcedWin = forcedPlayerInRoom(roomId, room);
  if (forcedWin) winnerId = forcedWin.id;

  room.status = 'finished';
  room.winnerPlayerId = winnerId;
  room.potWinnerId = winnerId;

  const winner = room.players.find(p => p.id === winnerId);
  const isTourney = tournamentTableIds.has(roomId);
  const isAllHands = room.mode === 'all-hands';
  const prizeAmount = room.sponsorPrize;
  const sponsor = room.sponsorName || 'Tournament Sponsor';

  room.logs.push({
    id: 'log_end_' + Date.now(),
    message: isAllHands
      ? `🏆 ${winner ? winner.name : 'Unknown'} is the last player standing and wins All Hands on Deck!`
      : `🏆 ${winner ? winner.name : 'Unknown'} played all cards and won the table!`,
    type: 'win',
    timestamp: new Date().toISOString(),
  });

  room.logs.push({
    id: 'log_pot_' + Date.now(),
    message: isTourney
      ? `➡️ ${winner ? winner.name : 'Unknown'} advances to the next round!`
      : `💰 ${winner ? winner.name : 'Unknown'} wins the ₦${prizeAmount.toLocaleString('en-NG')} cash prize sponsored by ${sponsor}!`,
    type: 'win',
    timestamp: new Date().toISOString(),
  });

  // Casual tables pay the sponsor prize to the winner. Tournament tables do NOT
  // — only the bracket CHAMPION is paid, and that's handled by the tournament
  // layer (finishTournament) so the prize is awarded exactly once.
  if (winner && !winner.isBot && !isTourney) {
    const profile = getProfile(winner.id);
    profile.balance += prizeAmount;
    profile.totalEarnings += prizeAmount;
    profile.gamesWon += 1;
    addTransaction(winner.id, {
      id: generateHash(),
      type: 'win',
      amount: prizeAmount,
      status: 'completed',
      timestamp: new Date().toISOString(),
      method: isAllHands ? `${sponsor} All Hands on Deck Prize` : `${sponsor} Tournament Prize`,
      txHash: 'hash_win_' + Math.random().toString(36).substring(2, 9),
      balanceAfter: profile.balance,
    });
    saveProfile(winner.id);
  }

  // Update stats for all players
  room.players.forEach(p => {
    if (!p.isBot) {
      const profile = getProfile(p.id);
      profile.gamesPlayed += 1;
      saveProfile(p.id);
    }
  });

  broadcastRoomState(roomId);

  // Notify the bracket so the winner can advance / the champion be crowned.
  if (isTourney) onTournamentTableEnd(roomId, winnerId);

  // All Hands: tell everyone still subscribed (winner + spectating eliminees)
  // who took the prize so clients can show the last-player-standing result.
  if (isAllHands) {
    broadcastEventToRoom(ALL_HANDS_ROOM, {
      type: 'all-hands-winner',
      winnerName: winner ? winner.name : 'Unknown',
      winnerId,
      prize: prizeAmount,
      sponsorName: sponsor,
    });
  }
}

// A star card counts DOUBLE its face value; Whot (20) counts as 20.
function cardHandValue(card: WhotCard): number {
  if (card.value === 20 || card.suit === 'whot') return 20;
  return card.suit === 'star' ? card.value * 2 : card.value;
}

// Called when the market is fully exhausted with no winner: sum each hand's card
// values, eliminate the highest total, and redeal a fresh round to the
// survivors. Repeats through play until someone empties their hand (checks out)
// or one player is left standing.
function resolveMarketExhausted(roomId: string) {
  const room = gameRooms[roomId];
  if (!room || room.status !== 'playing') return;
  const isTourney = tournamentTableIds.has(roomId);
  const isAllHands = room.mode === 'all-hands';

  // The silently preselected winner (test feature) is never eliminated.
  const forcedWin = forcedPlayerInRoom(roomId, room);

  // Highest total card value is eliminated (ties broken by seat order); the
  // forced winner is skipped so they survive to win.
  let elim: Player | null = null;
  let maxSum = -1;
  const totals = room.players.map(p => {
    const sum = p.hand.reduce((s, c) => s + cardHandValue(c), 0);
    if (p.id !== forcedWin?.id && sum > maxSum) { maxSum = sum; elim = p; }
    return `${p.name} ${sum}`;
  });
  // Everyone left is protected (only the forced winner) → they win.
  if (!elim) {
    const survivor = forcedWin || room.players[0];
    if (survivor) endWhotGame(roomId, survivor.id);
    return;
  }
  const eliminated: Player = elim;

  room.logs.push({
    id: 'log_market_end_' + Date.now(),
    message: `🃏 Market emptied with no winner. Card totals — ${totals.join(', ')}.`,
    type: 'system',
    timestamp: new Date().toISOString(),
  });
  room.logs.push({
    id: 'log_market_elim_' + Date.now(),
    message: `❌ ${eliminated.name} had the highest total (${maxSum}) and is eliminated!`,
    type: 'system',
    timestamp: new Date().toISOString(),
  });

  // All Hands showdown: reveal every hand total and who's knocked out so clients
  // can play the count-up + elimination moment. Sent before removal so the
  // payload includes the eliminated player.
  if (isAllHands) {
    broadcastEventToRoom(ALL_HANDS_ROOM, {
      type: 'all-hands-showdown',
      eliminatedName: eliminated.name,
      maxSum,
      remaining: room.players.length - 1,
      totals: room.players.map(p => ({
        name: p.name,
        total: p.hand.reduce((s, c) => s + cardHandValue(c), 0),
        eliminated: p.id === eliminated.id,
      })),
    });
  }

  // All Hands: keep the knocked-out player on a persistent rail (name, seat
  // colour, and the card count they held) so everyone can see who's out.
  if (isAllHands) {
    if (!room.eliminated) room.eliminated = [];
    room.eliminated.push({ name: eliminated.name, color: eliminated.color, cardsCount: eliminated.hand.length });
  }

  // Remove the eliminated player from the table.
  room.players = room.players.filter(p => p.id !== eliminated.id);

  // Let an eliminated human know. Tournament → elimination screen. All Hands →
  // keep them subscribed to the table so they can spectate the rest. Otherwise a
  // plain notice.
  if (!eliminated.isBot) {
    if (isTourney) {
      setConnRoomForEmail(eliminated.id, TOURNEY_OUT);
      sendToEmail(eliminated.id, { type: 'tournament-eliminated', round: tournament?.currentRound });
    } else if (isAllHands) {
      setConnRoomForEmail(eliminated.id, ALL_HANDS_ROOM);
      sendToEmail(eliminated.id, { type: 'all-hands-eliminated', total: maxSum, remaining: room.players.length });
    } else {
      sendToEmail(eliminated.id, { type: 'warning', message: `Market emptied — you had the highest card total (${maxSum}) and were eliminated.` });
    }
  }

  // One player left → they win the table (last man standing).
  if (room.players.length <= 1) {
    if (room.players.length === 1) endWhotGame(roomId, room.players[0].id);
    return;
  }

  // Otherwise redeal a fresh round to the survivors and continue.
  startWhotGameSession(room);
}

// =============================================================================
// KNOCKOUT TOURNAMENT ORCHESTRATOR
// A single tournament runs at a time. Entrants (real players and/or simulated
// AI, for testing) are seeded into tables of 4; each table plays a normal Whot
// game and the winner advances. Rounds repeat until one CHAMPION remains, who is
// paid the sponsor prize exactly once. Reuses the existing per-room game engine.
// =============================================================================
interface TournamentEntrant { id: string; name: string; isBot: boolean; }
interface TournamentTable { roomId: string; entrantIds: string[]; winnerId: string | null; status: 'playing' | 'finished'; }
interface TournamentRound { index: number; tables: TournamentTable[]; byes: string[]; }
interface Tournament {
  id: string;
  status: 'registering' | 'running' | 'finished';
  sponsorName: string;
  prize: number;
  aiEligible: boolean;              // may AI entrants win the prize? (test mode)
  forcedWinnerId: string | null;    // TEST: silent preselected winner (admin-only)
  entrants: TournamentEntrant[];
  rounds: TournamentRound[];
  currentRound: number;             // 1-based
  championId: string | null;
  createdAt: string;
}

let tournament: Tournament | null = null;
const tournamentTableIds = new Set<string>();
// When a table must be decided by (ms epoch). Guards against deadlocked games,
// stalls, and disconnects so a single table can never freeze the whole bracket.
const tableDeadlines = new Map<string, number>();
const TOURNAMENT_TABLE_MAX_MS = 90000; // 90s hard cap per table (allows redeals)

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function entrantById(id: string): TournamentEntrant | undefined {
  return tournament?.entrants.find(e => e.id === id);
}

// Remove all rooms this tournament created.
function clearTournamentTables() {
  tournamentTableIds.forEach(roomId => { delete gameRooms[roomId]; });
  tournamentTableIds.clear();
  tableDeadlines.clear();
}

// Decide a stuck/expired table: fewest cards wins (ties broken by seat order).
function forceResolveTournamentTable(roomId: string) {
  const room = gameRooms[roomId];
  if (!room || room.status !== 'playing') return;
  let winner = room.players[0];
  room.players.forEach(p => { if (p.cardsCount < winner.cardsCount) winner = p; });
  room.logs.push({
    id: 'log_timecap_' + Date.now(),
    message: `⏱️ Time cap reached — ${winner.name} advances on fewest cards.`,
    type: 'system',
    timestamp: new Date().toISOString(),
  });
  endWhotGame(roomId, winner.id); // triggers onTournamentTableEnd → advance
}

// Seat a set of entrants at a fresh table room and start the game immediately.
function seatTournamentTable(roomId: string, entrants: TournamentEntrant[]) {
  const colors: PlayerColor[] = ['red', 'green', 'yellow', 'blue'];
  const players: Player[] = entrants.map((e, i) => ({
    id: e.id,
    name: e.name,
    color: colors[i] ?? null,
    isBot: e.isBot,
    balance: 0,
    currentBet: 0,
    ready: true,
    cardsCount: 0,
    hand: [],
    isConnected: true,
    highestRollInRound: 0,
    totalRollsCount: 0,
  }));
  gameRooms[roomId] = {
    roomId,
    status: 'waiting',
    players,
    pot: tournament?.prize ?? 0,
    activePlayerIndex: 0,
    logs: [],
    turnTimeLeft: adminConfig.turnTimerSeconds,
    winnerPlayerId: null,
    potWinnerId: null,
    antiCheatLog: [],
    sponsorName: tournament?.sponsorName ?? '',
    sponsorPrize: tournament?.prize ?? 0,
    drawPileCount: 0,
    discardPile: [],
    requestedSuit: null,
    turnDirection: 1,
  };
  tournamentTableIds.add(roomId);
  tableDeadlines.set(roomId, Date.now() + TOURNAMENT_TABLE_MAX_MS);
  // Move each human entrant's connection to this table so they receive the game
  // and can play; then start (which broadcasts the opening state to them).
  entrants.forEach(e => {
    if (!e.isBot) {
      setConnRoomForEmail(e.id, roomId);
      sendToEmail(e.id, { type: 'tournament-seated', round: tournament?.currentRound ?? 1 });
    }
  });
  startWhotGameSession(gameRooms[roomId]);
}

// Partition entrant ids into tables of up to 4. A leftover group of exactly one
// gets a bye (auto-advance). Groups of 2-3 play a short table (valid in Whot).
function buildRound(entrantIds: string[], roundIndex: number): TournamentRound {
  const shuffled = shuffle([...entrantIds]);
  const tables: TournamentTable[] = [];
  const byes: string[] = [];
  chunk(shuffled, 4).forEach((group, i) => {
    if (group.length === 1) {
      byes.push(group[0]);
      const e = entrantById(group[0]);
      if (e && !e.isBot) {
        setConnRoomForEmail(e.id, TOURNEY_WAIT);
        sendToEmail(e.id, { type: 'tournament-advanced', bye: true, round: roundIndex });
      }
      return;
    }
    const roomId = `__t_r${roundIndex}_${i}`;
    tables.push({ roomId, entrantIds: group, winnerId: null, status: 'playing' });
    seatTournamentTable(roomId, group.map(id => entrantById(id)!).filter(Boolean) as TournamentEntrant[]);
  });
  return { index: roundIndex, tables, byes };
}

// Pay the sponsor prize to a human champion (bots have no wallet) and close out.
function finishTournament(championId: string | null) {
  if (!tournament) return;
  tournament.status = 'finished';
  tournament.championId = championId;
  const champ = championId ? entrantById(championId) : null;
  if (champ && !champ.isBot) {
    const profile = getProfile(champ.id);
    profile.balance += tournament.prize;
    profile.totalEarnings += tournament.prize;
    profile.gamesWon += 1;
    addTransaction(champ.id, {
      id: generateHash(),
      type: 'win',
      amount: tournament.prize,
      status: 'completed',
      timestamp: new Date().toISOString(),
      method: `${tournament.sponsorName} Tournament — Champion`,
      txHash: 'hash_champ_' + Math.random().toString(36).substring(2, 9),
      balanceAfter: profile.balance,
    });
    saveProfile(champ.id);
  }
  // Crown the champion on their screen (if human).
  if (champ && !champ.isBot) {
    setConnRoomForEmail(champ.id, TOURNEY_OUT);
    sendToEmail(champ.id, { type: 'tournament-champion', prize: tournament.prize, sponsorName: tournament.sponsorName });
  }
  // Tell every other connected human the tournament is over (so spectators —
  // eliminated players watching — see who won and can stop watching).
  const championName = champ?.name ?? null;
  tournament.entrants.forEach(e => {
    if (!e.isBot && e.id !== championId) sendToEmail(e.id, { type: 'tournament-over', championName });
  });
  console.log(`🏆 Tournament ${tournament.id} finished. Champion: ${champ?.name ?? 'none'} (${champ?.isBot ? 'AI' : 'human'}).`);
}

// Take the set of round winners (+ byes) and either crown a champion or seed the
// next round.
function advanceTournament(winnerIds: string[]) {
  if (!tournament) return;
  const winners = winnerIds.filter(Boolean);
  if (winners.length <= 1) { finishTournament(winners[0] ?? null); return; }
  const nextIndex = tournament.currentRound + 1;
  const round = buildRound(winners, nextIndex);
  tournament.rounds.push(round);
  tournament.currentRound = nextIndex;
  // If everyone got a bye (no tables), keep collapsing until we get a game/champ.
  if (round.tables.length === 0) advanceTournament(round.byes);
}

// Called from endWhotGame when a tournament table finishes.
function onTournamentTableEnd(roomId: string, winnerId: string) {
  if (!tournament || tournament.status !== 'running') return;
  const round = tournament.rounds[tournament.currentRound - 1];
  if (!round) return;
  const table = round.tables.find(t => t.roomId === roomId);
  if (!table || table.status === 'finished') return;
  tableDeadlines.delete(roomId);
  table.status = 'finished';
  table.winnerId = winnerId;

  // Tell the humans at this table whether they advanced or were knocked out.
  table.entrantIds.forEach(id => {
    const e = entrantById(id);
    if (!e || e.isBot) return;
    if (id === winnerId) {
      setConnRoomForEmail(id, TOURNEY_WAIT);
      sendToEmail(id, { type: 'tournament-advanced', round: tournament!.currentRound });
    } else {
      setConnRoomForEmail(id, TOURNEY_OUT);
      sendToEmail(id, { type: 'tournament-eliminated', round: tournament!.currentRound });
    }
  });

  if (round.tables.every(t => t.status === 'finished')) {
    // Brief pause so winners see they advanced before the next round is seeded.
    const winners = [...round.tables.map(t => t.winnerId!), ...round.byes];
    setTimeout(() => advanceTournament(winners), ROUND_GAP_MS);
  }
}

// --- lifecycle actions (invoked by the admin REST endpoints) ---
function createTournament(): { ok?: true; error?: string } {
  const t = currentTournament();
  if (!t.active) return { error: 'Set a sponsor name and prize (Tournament section) before creating a tournament.' };
  clearTournamentTables();
  tournament = {
    id: 'tny_' + Date.now().toString(36),
    status: 'registering',
    sponsorName: t.sponsorName,
    prize: t.prize,
    aiEligible: true, // test mode: AI may fill and win. Set false when going live.
    forcedWinnerId: null,
    entrants: [],
    rounds: [],
    currentRound: 0,
    championId: null,
    createdAt: new Date().toISOString(),
  };
  return { ok: true };
}

function simulateEntrants(count: number): { ok?: true; error?: string } {
  if (!tournament || tournament.status !== 'registering') return { error: 'No tournament open for registration.' };
  const n = Math.max(1, Math.min(200, Math.floor(count)));
  const base = tournament.entrants.length;
  const pool = botNamePool();
  for (let i = 0; i < n; i++) {
    const name = pool[(base + i) % pool.length] + '-' + (base + i + 1);
    tournament.entrants.push({ id: `sim_${base + i}_${Math.random().toString(36).slice(2, 6)}`, name, isBot: true });
  }
  return { ok: true };
}

function startTournamentRun(): { ok?: true; error?: string } {
  if (!tournament || tournament.status !== 'registering') return { error: 'No tournament open for registration.' };
  // Auto-fill remaining seats with AI so every registered human gets a full
  // table. The field is topped up to at least the admin-set size and always a
  // multiple of 4 (e.g. 5 humans → +11 AI → 16 seats).
  const current = tournament.entrants.length;
  const desired = Math.max(tournamentTargetSize(), Math.ceil(current / 4) * 4);
  if (desired > current) simulateEntrants(desired - current);
  if (tournament.entrants.length < 2) return { error: 'Need at least 1 registered player to start.' };
  tournament.status = 'running';
  tournament.currentRound = 1;
  const round = buildRound(tournament.entrants.map(e => e.id), 1);
  tournament.rounds = [round];
  if (round.tables.length === 0) advanceTournament(round.byes);
  return { ok: true };
}

function resetTournament() {
  // Let any connected humans know the tournament was cleared.
  tournament?.entrants.forEach(e => {
    if (!e.isBot) {
      setConnRoomForEmail(e.id, TOURNEY_LOBBY);
      sendToEmail(e.id, { type: 'tournament-cancelled' });
    }
  });
  clearTournamentTables();
  tournament = null;
}

// Admin-facing snapshot of the bracket (safe to show bot/human in this view).
function tournamentStatus() {
  if (!tournament) return { exists: false };
  const nameOf = (id: string | null) => (id ? (entrantById(id)?.name ?? '—') : '—');
  return {
    exists: true,
    id: tournament.id,
    status: tournament.status,
    sponsorName: tournament.sponsorName,
    prize: tournament.prize,
    entrantCount: tournament.entrants.length,
    currentRound: tournament.currentRound,
    totalRounds: tournament.rounds.length,
    championId: tournament.championId,
    championName: tournament.championId ? nameOf(tournament.championId) : null,
    championIsBot: tournament.championId ? !!entrantById(tournament.championId)?.isBot : null,
    forcedWinnerId: tournament.forcedWinnerId,
    forcedWinnerName: tournament.forcedWinnerId ? nameOf(tournament.forcedWinnerId) : null,
    // Full entrant roster (bot names shown) so the admin can pick a winner.
    entrants: tournament.entrants.map(e => ({ id: e.id, name: e.name, isBot: e.isBot })),
    rounds: tournament.rounds.map(r => ({
      index: r.index,
      byes: r.byes.map(nameOf),
      tables: r.tables.map(tb => ({
        roomId: tb.roomId,
        players: tb.entrantIds.map(id => ({ name: nameOf(id), isBot: !!entrantById(id)?.isBot })),
        winner: nameOf(tb.winnerId),
        done: tb.status === 'finished',
      })),
    })),
  };
}

// =============================================================================
// PHASE 2 — human participation in the bracket
// Pseudo-rooms for participants who aren't currently seated at a game table.
// =============================================================================
const TOURNEY_LOBBY = '__t_lobby'; // registered, waiting for the tournament to start
const TOURNEY_WAIT = '__t_wait';   // won their table, waiting for the next round
const TOURNEY_OUT = '__t_out';     // eliminated
const ROUND_GAP_MS = 5000;         // pause between rounds so winners see they advanced

// The admin-configured field size, clamped and rounded to a multiple of 4.
function tournamentTargetSize(): number {
  const raw = adminConfig.tournamentFieldSize || DEFAULT_FIELD_SIZE;
  const clamped = Math.max(MIN_FIELD_SIZE, Math.min(MAX_FIELD_SIZE, raw));
  return Math.max(4, Math.round(clamped / 4) * 4);
}

// =============================================================================
// ALL HANDS ON DECK — survival segment
// A single self-contained table (2–4 seats), independent of the bracket. There
// is NO checkout win: play continues until the market's draw pile is exhausted,
// then every hand is totalled and the highest total is knocked out. Survivors
// are redealt and it repeats until one player is left standing, who takes the
// sponsor prize. Reuses the core Whot engine; only the win/elimination rules
// differ (branched on room.mode === 'all-hands').
// =============================================================================
const ALL_HANDS_ROOM = '__all_hands'; // the single live All Hands table
const ALL_HANDS_LOBBY = '__ah_lobby'; // connected, choosing to enter

// Starting seat count (2–4). In-memory only for now (no schema migration); the
// prize/sponsor are taken from the arena's configured fixed prize.
let allHandsSize = 4;
function clampAllHandsSize(n: number): number {
  return Math.max(2, Math.min(4, Math.round(n) || 4));
}

// TEST: preselected winner for All Hands on Deck (by name — a bot roster name or
// a seated human's nickname). SILENT: never marked, logged or announced to
// players; in-memory only and visible to the admin dashboard alone. When set to
// a bot name, that bot is guaranteed a seat (see fillAllHandsBots).
let allHandsForcedWinnerName = '';

// All Hands is available whenever the arena has a sponsor + positive prize set.
function allHandsPrizeInfo(): { sponsorName: string; prize: number; active: boolean } {
  const sponsorName = adminConfig.fixedSponsorName.trim();
  const prize = adminConfig.fixedPrize;
  return { sponsorName, prize, active: sponsorName.length > 0 && prize > 0 };
}

// Send an arbitrary event to every connection currently in a room.
function broadcastEventToRoom(roomId: string, obj: any) {
  const payload = JSON.stringify(obj);
  Object.keys(activeConnections).forEach(connId => {
    const conn = activeConnections[connId];
    if (conn.roomId === roomId && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(payload);
    }
  });
}

function getOrCreateAllHandsRoom(): GameState {
  let room = gameRooms[ALL_HANDS_ROOM];
  if (!room) {
    const { sponsorName, prize } = allHandsPrizeInfo();
    room = gameRooms[ALL_HANDS_ROOM] = {
      roomId: ALL_HANDS_ROOM,
      status: 'waiting',
      mode: 'all-hands',
      players: [],
      pot: prize,
      activePlayerIndex: 0,
      logs: [{
        id: 'log_ah_' + Date.now(),
        message: `🃏 All Hands on Deck is open — last player standing wins ₦${prize.toLocaleString('en-NG')}. Enter to play!`,
        type: 'system',
        timestamp: new Date().toISOString(),
      }],
      turnTimeLeft: adminConfig.turnTimerSeconds,
      winnerPlayerId: null,
      potWinnerId: null,
      antiCheatLog: [],
      sponsorName,
      sponsorPrize: prize,
      drawPileCount: 0,
      discardPile: [],
      requestedSuit: null,
      turnDirection: 1,
      eliminated: [],
    };
  }
  return room;
}

// Fill empty seats with bots up to the configured All Hands size (2–4).
function fillAllHandsBots(room: GameState) {
  const colors: PlayerColor[] = ['red', 'green', 'yellow', 'blue'];
  const cap = clampAllHandsSize(allHandsSize);
  const pool = botNamePool();
  while (room.players.length < cap) {
    const assigned = room.players.map(p => p.color).filter(Boolean) as PlayerColor[];
    const color = colors.find(c => !assigned.includes(c));
    if (!color) break;
    const taken = new Set(room.players.map(p => p.name));
    // Seat the preselected-winner bot first so it's guaranteed a seat (test rig).
    const name = (allHandsForcedWinnerName && !taken.has(allHandsForcedWinnerName))
      ? allHandsForcedWinnerName
      : (pool.find(n => !taken.has(n)) || pool[Math.floor(Math.random() * pool.length)]);
    room.players.push({
      id: 'bot_' + color,
      name,
      color,
      isBot: true,
      balance: 0,
      currentBet: 0,
      ready: true,
      cardsCount: 0,
      hand: [],
      isConnected: true,
      highestRollInRound: 0,
      totalRollsCount: 0,
    });
    room.logs.push({
      id: 'log_ah_join_' + Date.now() + '_' + Math.random().toString(36).substring(2, 5),
      message: `👤 ${name} takes the ${color.toUpperCase()} seat!`,
      type: 'info',
      timestamp: new Date().toISOString(),
    });
  }
}

// Seat a human into the All Hands table (idempotent). Returns null if full.
function seatAllHandsHuman(room: GameState, email: string, name: string): Player | null {
  const existing = room.players.find(x => x.id === email);
  if (existing) { existing.ready = true; existing.isConnected = true; existing.name = name; return existing; }
  const colors: PlayerColor[] = ['red', 'green', 'yellow', 'blue'];
  const assigned = room.players.map(x => x.color).filter(Boolean) as PlayerColor[];
  const color = colors.find(c => !assigned.includes(c));
  if (!color) return null; // table full
  const p: Player = {
    id: email,
    name,
    color,
    isBot: false,
    balance: getProfile(email).balance,
    currentBet: 0,
    ready: true,
    cardsCount: 0,
    hand: [],
    isConnected: true,
    highestRollInRound: 0,
    totalRollsCount: 0,
  };
  room.players.push(p);
  room.logs.push({
    id: 'log_ah_seat_' + Date.now(),
    message: `🎮 ${name} joined the All Hands table on the ${color.toUpperCase()} seat!`,
    type: 'info',
    timestamp: new Date().toISOString(),
  });
  return p;
}

// Fill any empty seats with bots and deal the first round.
function startAllHands(room: GameState) {
  fillAllHandsBots(room);
  room.pot = room.sponsorPrize;
  room.eliminated = []; // fresh game — clear the knocked-out rail
  startWhotGameSession(room);
}

// Reset a finished All Hands table back to an open lobby for a fresh game.
function resetAllHandsRoom(room: GameState) {
  const { sponsorName, prize } = allHandsPrizeInfo();
  room.status = 'waiting';
  room.mode = 'all-hands';
  room.winnerPlayerId = null;
  room.potWinnerId = null;
  room.requestedSuit = null;
  room.turnDirection = 1;
  room.turnTimeLeft = adminConfig.turnTimerSeconds;
  room.activePlayerIndex = 0;
  room.discardPile = [];
  (room as any).drawPile = [];
  room.drawPileCount = 0;
  room.antiCheatLog = [];
  room.sponsorName = sponsorName;
  room.sponsorPrize = prize;
  room.pot = prize;
  room.eliminated = []; // clear the knocked-out rail
  room.players = []; // everyone re-enters for a fresh game
  room.logs.push({
    id: 'log_ah_reset_' + Date.now(),
    message: `🔄 New All Hands table open — ₦${prize.toLocaleString('en-NG')} to the last player standing. Enter to play!`,
    type: 'system',
    timestamp: new Date().toISOString(),
  });
}

// Casual banter the AI opponents drop into the arena chat so tables feel human.
const BOT_CHAT_LINES = [
  'Good luck everyone! 🍀', "Let's go 🔥", 'This prize is mine 😎', 'Who else is nervous 😅',
  'Nice one!', 'Ahh so close', 'Whot! 🃏', 'Shuffle up 🎴', 'May the best player win 🙏',
  'That was a bold move', 'I felt that one 😩', 'Bring it on!', 'gg wp', 'Anyone from Lagos? 🇳🇬',
  'My cards are trash today 😂', 'One more win 💪', 'Respect ✊', 'Big money on the line 💰',
];

// Broadcast a chat message. During a live tournament everyone in the arena sees
// it (a single shared chat room across all tables); otherwise it's per-room.
function broadcastArenaChat(messageObj: any, fromRoomId: string) {
  const payload = JSON.stringify({ type: 'chat-received', message: messageObj });
  const bracketLive = !!tournament && (tournament.status === 'running' || tournament.status === 'registering');
  Object.keys(activeConnections).forEach(cid => {
    const c = activeConnections[cid];
    if (c.ws.readyState !== WebSocket.OPEN) return;
    const inArena = typeof c.roomId === 'string' && c.roomId.startsWith('__t');
    if (bracketLive ? inArena : c.roomId === fromRoomId) c.ws.send(payload);
  });
}

// Send a JSON message to every open connection for an email.
function sendToEmail(email: string, obj: any) {
  const payload = JSON.stringify(obj);
  Object.keys(activeConnections).forEach(cid => {
    const c = activeConnections[cid];
    if (c.email === email && c.ws.readyState === WebSocket.OPEN) c.ws.send(payload);
  });
}
// Re-point a player's connection(s) to a room (a real table or a pseudo-room).
function setConnRoomForEmail(email: string, roomId: string) {
  Object.keys(activeConnections).forEach(cid => {
    if (activeConnections[cid].email === email) activeConnections[cid].roomId = roomId;
  });
}
function isEntrant(email: string): boolean {
  return !!tournament?.entrants.find(e => e.id === email);
}
// Public (non-admin) view for the lobby.
function tournamentPublicState() {
  if (!tournament) return { exists: false, open: false };
  return {
    exists: true,
    open: tournament.status === 'registering',
    status: tournament.status,
    sponsorName: tournament.sponsorName,
    prize: tournament.prize,
    entrantCount: tournament.entrants.length,
  };
}
function sendLobbyTo(email: string) {
  sendToEmail(email, { type: 'tournament-lobby', ...tournamentPublicState(), registered: isEntrant(email) });
}
function broadcastLobby() {
  tournament?.entrants.forEach(e => { if (!e.isBot) sendLobbyTo(e.id); });
}
// Register a human, charging the buy-in (lifetime free game first, else a ticket).
function registerHumanEntrant(email: string, name: string): { ok?: true; error?: string } {
  if (!tournament || tournament.status !== 'registering') return { error: 'Registration is closed.' };
  if (isEntrant(email)) return { ok: true };
  const profile = getProfile(email);
  if (adminConfig.freeGameEnabled && !profile.freeGameUsed) {
    profile.freeGameUsed = true;
  } else if (profile.tickets > 0) {
    profile.tickets -= 1;
  } else {
    return { error: 'You have no tickets left. Buy tickets in the Cashier to register.' };
  }
  saveProfile(email);
  tournament.entrants.push({ id: email, name, isBot: false });
  return { ok: true };
}
// The live table a still-playing entrant belongs to this round (for reconnects).
function entrantCurrentTable(email: string): string | null {
  if (!tournament || tournament.status !== 'running') return null;
  const round = tournament.rounds[tournament.currentRound - 1];
  const t = round?.tables.find(tb => tb.status === 'playing' && tb.entrantIds.includes(email));
  return t ? t.roomId : null;
}

// Bot automated Whot action
function runBotWhotAction(roomId: string, bot: Player) {
  const room = gameRooms[roomId];
  if (!room || room.status !== 'playing') return;

  const activeP = room.players[room.activePlayerIndex];
  if (!activeP || activeP.id !== bot.id) return;

  setTimeout(() => {
    const freshRoom = gameRooms[roomId];
    if (!freshRoom || freshRoom.status !== 'playing') return;
    const curP = freshRoom.players[freshRoom.activePlayerIndex];
    if (!curP || curP.id !== bot.id) return;

    // Find playable cards
    const topCard = freshRoom.discardPile[freshRoom.discardPile.length - 1];
    const playable = curP.hand.filter(c => {
      if (c.value === 20) return true;
      if (freshRoom.requestedSuit) {
        return c.suit === freshRoom.requestedSuit;
      }
      return c.suit === topCard.suit || c.value === topCard.value;
    });

    if (playable.length > 0) {
      // AI Heuristic: prioritize action cards (1, 2, 5, 8, 14), then standard, then Whot (20)
      const actionCards = playable.filter(c => [1, 2, 5, 8, 14].includes(c.value));
      const wilds = playable.filter(c => c.value === 20);
      const standard = playable.filter(c => ![1, 2, 5, 8, 14, 20].includes(c.value));

      let selectedCard = playable[0];
      if (actionCards.length > 0) {
        selectedCard = actionCards[Math.floor(Math.random() * actionCards.length)];
      } else if (standard.length > 0) {
        selectedCard = standard[Math.floor(Math.random() * standard.length)];
      } else if (wilds.length > 0) {
        selectedCard = wilds[Math.floor(Math.random() * wilds.length)];
      }

      executeWhotPlayCard(roomId, curP.id, selectedCard.id);
    } else {
      executeWhotDrawCard(roomId, curP.id);
    }
  }, 1400);
}

// Execute play card
function executeWhotPlayCard(roomId: string, playerId: string, cardId: string) {
  const room = gameRooms[roomId];
  if (!room || room.status !== 'playing') return;

  const activeP = room.players[room.activePlayerIndex];
  if (activeP.id !== playerId) return;

  const cardIndex = activeP.hand.findIndex(c => c.id === cardId);
  if (cardIndex === -1) return;

  const card = activeP.hand[cardIndex];
  const topCard = room.discardPile[room.discardPile.length - 1];

  let isLegal = false;
  if (card.value === 20) {
    isLegal = true;
  } else if (room.requestedSuit) {
    isLegal = card.suit === room.requestedSuit;
  } else {
    isLegal = card.suit === topCard.suit || card.value === topCard.value;
  }

  if (!isLegal) {
    room.antiCheatLog.push({
      id: 'cheat_' + Date.now(),
      timestamp: new Date().toISOString(),
      playerId,
      playerName: activeP.name,
      type: 'illegal_card_play',
      severity: 'high',
      details: `Attempted to play [${card.suit.toUpperCase()} ${card.value}] on top card [${topCard.suit.toUpperCase()} ${topCard.value}]. Blocked.`,
    });
    return;
  }

  // Play card
  activeP.hand.splice(cardIndex, 1);
  activeP.cardsCount = activeP.hand.length;
  room.discardPile.push(card);
  activeP.totalRollsCount++; // Card plays statistic

  // Clear requested suit unless new wildcard is played
  if (card.value !== 20) {
    room.requestedSuit = null;
  }

  room.logs.push({
    id: 'log_play_' + Date.now(),
    message: `🎴 ${activeP.name} played [${card.suit.toUpperCase()} ${card.value}]! (${activeP.cardsCount} cards remaining)`,
    type: 'move',
    timestamp: new Date().toISOString(),
  });

  // Victory check. In All Hands on Deck there is no checkout win — emptying your
  // hand just gives you a 0 total (safe at the next showdown) and play continues;
  // you'll draw on your next turn if you still have no playable card. In every
  // other mode, emptying your hand wins the table outright.
  if (activeP.cardsCount === 0 && room.mode !== 'all-hands') {
    endWhotGame(roomId, activeP.id);
    return;
  }

  // Handle special card rules
  let nextPlayerIndex = (room.activePlayerIndex + room.turnDirection + room.players.length) % room.players.length;

  if (card.value === 1) {
    // 1 (Hold On): plays again!
    room.logs.push({
      id: 'log_special_1_' + Date.now(),
      message: `⏸️ [HOLD ON]: ${activeP.name} earns an immediate extra turn!`,
      type: 'info',
      timestamp: new Date().toISOString(),
    });
    room.turnTimeLeft = adminConfig.turnTimerSeconds;
    broadcastRoomState(roomId);
    if (activeP.isBot) {
      runBotWhotAction(roomId, activeP);
    }
    return;
  }

  if (card.value === 2) {
    // 2 (Pick Two)
    const nextP = room.players[nextPlayerIndex];
    const drawn = drawCardsFromMarket(room, 2);
    nextP.hand.push(...drawn);
    nextP.cardsCount = nextP.hand.length;

    room.logs.push({
      id: 'log_special_2_' + Date.now(),
      message: `🃏 [PICK TWO]: ${nextP.name} must draw 2 cards and skip their turn!`,
      type: 'info',
      timestamp: new Date().toISOString(),
    });

    nextPlayerIndex = (nextPlayerIndex + room.turnDirection + room.players.length) % room.players.length;
  } else if (card.value === 5) {
    // 5 (Send Three)
    const nextP = room.players[nextPlayerIndex];
    const drawn = drawCardsFromMarket(room, 3);
    nextP.hand.push(...drawn);
    nextP.cardsCount = nextP.hand.length;

    room.logs.push({
      id: 'log_special_5_' + Date.now(),
      message: `🃏 [SEND THREE]: ${nextP.name} must draw 3 cards and skip their turn!`,
      type: 'info',
      timestamp: new Date().toISOString(),
    });

    nextPlayerIndex = (nextPlayerIndex + room.turnDirection + room.players.length) % room.players.length;
  } else if (card.value === 8) {
    // 8 (Suspension)
    const nextP = room.players[nextPlayerIndex];
    room.logs.push({
      id: 'log_special_8_' + Date.now(),
      message: `🚫 [SUSPENSION]: ${nextP.name} skips their turn!`,
      type: 'info',
      timestamp: new Date().toISOString(),
    });
    nextPlayerIndex = (nextPlayerIndex + room.turnDirection + room.players.length) % room.players.length;
  } else if (card.value === 14) {
    // 14 (General Market)
    room.logs.push({
      id: 'log_special_14_' + Date.now(),
      message: `🛒 [GENERAL MARKET]: All players draw 1 card except ${activeP.name}!`,
      type: 'info',
      timestamp: new Date().toISOString(),
    });

    room.players.forEach(p => {
      if (p.id !== activeP.id) {
        const drawn = drawCardsFromMarket(room, 1);
        p.hand.push(...drawn);
        p.cardsCount = p.hand.length;
      }
    });
  }

  // Whot wildcard (20)
  if (card.value === 20) {
    if (activeP.isBot) {
      // Bot auto-declares
      const suitsCount: Record<string, number> = {};
      activeP.hand.forEach(c => {
        if (c.suit !== 'whot') {
          suitsCount[c.suit] = (suitsCount[c.suit] || 0) + 1;
        }
      });
      let bestSuit: CardSuit = 'circle';
      let maxCount = -1;
      Object.keys(suitsCount).forEach(s => {
        if (suitsCount[s] > maxCount) {
          maxCount = suitsCount[s];
          bestSuit = s as CardSuit;
        }
      });
      room.requestedSuit = bestSuit;
      room.logs.push({
        id: 'log_bot_whot_declare_' + Date.now(),
        message: `🌟 ${activeP.name} declares the next suit to be [${bestSuit.toUpperCase()}]!`,
        type: 'info',
        timestamp: new Date().toISOString(),
      });

      // Pass turn to next player
      room.activePlayerIndex = nextPlayerIndex;
      room.turnTimeLeft = adminConfig.turnTimerSeconds;
      const nextActiveP = room.players[room.activePlayerIndex];
      room.logs.push({
        id: 'log_next_turn_' + Date.now(),
        message: `👉 It is now ${nextActiveP.name}'s turn!`,
        type: 'info',
        timestamp: new Date().toISOString(),
      });
      broadcastRoomState(roomId);
      if (nextActiveP.isBot) {
        runBotWhotAction(roomId, nextActiveP);
      }
    } else {
      // Human played 20. Wait for 'declare-suit' event.
      room.logs.push({
        id: 'log_whot_wait_' + Date.now(),
        message: `⏳ Waiting for ${activeP.name} to choose the next suit...`,
        type: 'info',
        timestamp: new Date().toISOString(),
      });
      broadcastRoomState(roomId);
    }
    return;
  }

  // Pass turn normally
  room.activePlayerIndex = nextPlayerIndex;
  room.turnTimeLeft = adminConfig.turnTimerSeconds;
  const nextActiveP = room.players[room.activePlayerIndex];
  room.logs.push({
    id: 'log_next_turn_' + Date.now(),
    message: `👉 It is now ${nextActiveP.name}'s turn!`,
    type: 'info',
    timestamp: new Date().toISOString(),
  });

  broadcastRoomState(roomId);
  if (nextActiveP.isBot) {
    runBotWhotAction(roomId, nextActiveP);
  }
}

// Execute card draw
function executeWhotDrawCard(roomId: string, playerId: string) {
  const room = gameRooms[roomId];
  if (!room || room.status !== 'playing') return;

  const activeP = room.players[room.activePlayerIndex];
  if (activeP.id !== playerId) return;

  const drawn = drawCardsFromMarket(room, 1);
  if (drawn.length === 0) {
    // The market is fully exhausted (whole 54-card deck is in hands) and nobody
    // has won. Resolve by eliminating the player with the highest card total.
    resolveMarketExhausted(roomId);
    return;
  }
  activeP.hand.push(...drawn);
  activeP.cardsCount = activeP.hand.length;

  room.logs.push({
    id: 'log_draw_' + Date.now(),
    message: `📥 ${activeP.name} draws 1 card from the Market.`,
    type: 'roll',
    timestamp: new Date().toISOString(),
  });

  // Pass turn
  const nextPlayerIndex = (room.activePlayerIndex + room.turnDirection + room.players.length) % room.players.length;
  room.activePlayerIndex = nextPlayerIndex;
  room.turnTimeLeft = adminConfig.turnTimerSeconds;

  const nextActiveP = room.players[room.activePlayerIndex];
  room.logs.push({
    id: 'log_next_turn_' + Date.now(),
    message: `👉 It is now ${nextActiveP.name}'s turn!`,
    type: 'info',
    timestamp: new Date().toISOString(),
  });

  broadcastRoomState(roomId);
  if (nextActiveP.isBot) {
    runBotWhotAction(roomId, nextActiveP);
  }
}

// Start Whot game
function startWhotGameSession(room: GameState) {
  room.status = 'playing';
  room.activePlayerIndex = 0;
  room.winnerPlayerId = null;
  room.potWinnerId = null;
  room.antiCheatLog = [];
  room.requestedSuit = null;
  room.turnDirection = 1;
  room.turnTimeLeft = adminConfig.turnTimerSeconds;

  // Create & shuffle deck
  const fullDeck = createWhotDeck();

  // Deal 5 cards
  room.players.forEach(p => {
    p.hand = fullDeck.splice(0, 5);
    p.cardsCount = 5;
    p.totalRollsCount = 0; // Plays count
    p.highestRollInRound = 5; // keep tracking cards remaining
  });

  // Start discard with non-wildcard
  let startIndex = fullDeck.findIndex(c => c.value !== 20 && c.suit !== 'whot');
  if (startIndex === -1) startIndex = 0;
  const startCard = fullDeck.splice(startIndex, 1)[0];

  room.discardPile = [startCard];
  (room as any).drawPile = fullDeck;
  room.drawPileCount = fullDeck.length;

  room.logs.push({
    id: 'log_start_' + Date.now(),
    message: room.mode === 'all-hands'
      ? `🚀 All Hands on Deck! Each player has 5 cards. When the market runs dry, the highest hand is out. Last standing wins ₦${room.sponsorPrize.toLocaleString('en-NG')}.`
      : `🚀 ${room.sponsorName || 'Sponsored'} Tournament started! Each player has 5 cards. Cash prize: ₦${room.sponsorPrize.toLocaleString('en-NG')}.`,
    type: 'system',
    timestamp: new Date().toISOString(),
  });

  room.logs.push({
    id: 'log_first_card_' + Date.now(),
    message: `🎴 The opening card is [${startCard.suit.toUpperCase()} ${startCard.value}]!`,
    type: 'info',
    timestamp: new Date().toISOString(),
  });

  const activeP = room.players[room.activePlayerIndex];
  room.logs.push({
    id: 'log_first_turn_' + Date.now(),
    message: `👉 It is ${activeP.name}'s turn!`,
    type: 'info',
    timestamp: new Date().toISOString(),
  });

  broadcastRoomState(room.roomId);

  if (activeP.isBot) {
    runBotWhotAction(room.roomId, activeP);
  }
}


// -----------------------------------------------------------------------------
// REST API ENDPOINTS
// -----------------------------------------------------------------------------

// 1. GET User Profile
app.get('/api/profile', async (req, res) => {
  const email = (req.query.email as string) || 'hudozit@gmail.com';
  const profile = await ensureProfile(email);
  res.json(profile);
});

// 2. RETIRED: the old simulated deposit.
//
// This endpoint used to credit any wallet by any amount for anyone who could
// reach the API — no payment, no authentication, no verification. That was
// survivable while the whole economy was fake. It is not survivable now that
// deposits are real and winnings can be withdrawn, so it is closed permanently.
//
// The ONLY route from money to wallet balance is now:
//   /api/paystack/initialize → Paystack → /api/paystack/verify or the webhook
// which credits solely on the amount Paystack itself reports.
app.post('/api/profile/deposit', (_req, res) => {
  res.status(410).json({
    error: 'This endpoint has been retired. Deposits now go through Paystack checkout.',
  });
});

// -----------------------------------------------------------------------------
// PAYSTACK — real payment gateway (deposits).
//
//   Deposit  = initialize (server, secret key) → Paystack Inline popup (client)
//              → verify (server) and/or webhook → wallet credited.
//   Withdraw = still simulated; see /api/profile/withdraw.
//
// Two rules this code exists to enforce:
//   1. The AMOUNT IS NEVER TRUSTED FROM THE CLIENT at credit time. We record
//      what we asked Paystack to charge, then credit only what Paystack says
//      was actually paid, and only if the two agree.
//   2. A deposit is credited EXACTLY ONCE. Both /verify and the webhook report
//      the same payment (and the webhook retries for hours), so both funnel
//      through creditDeposit(), which compare-and-swaps the payments row.
// -----------------------------------------------------------------------------
const PAYSTACK_SECRET_KEY = (process.env.PAYSTACK_SECRET_KEY || '').trim();
const PAYSTACK_API = 'https://api.paystack.co';
const paystackEnabled = !!PAYSTACK_SECRET_KEY;
const MIN_DEPOSIT_NAIRA = 100;

if (!paystackEnabled) {
  console.warn('⚠️  PAYSTACK_SECRET_KEY not set — deposits are disabled.');
} else if (!PAYSTACK_SECRET_KEY.startsWith('sk_')) {
  console.warn('⚠️  PAYSTACK_SECRET_KEY does not look like a secret key (expected sk_test_… or sk_live_…).');
} else if (PAYSTACK_SECRET_KEY.startsWith('sk_live_')) {
  console.warn('🔴 Paystack is in LIVE mode — real money will move.');
} else {
  console.log('✅ Paystack test mode enabled.');
}

// -----------------------------------------------------------------------------
// Withdrawal PIN — PBKDF2-SHA256, per-user salt, no new dependencies.
// Format: pbkdf2$<iterations>$<salt-hex>$<derived-hex>, so the iteration count
// can be raised later without invalidating PINs already set.
// -----------------------------------------------------------------------------
const PIN_ITERATIONS = 120000;

function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.pbkdf2Sync(pin, salt, PIN_ITERATIONS, 32, 'sha256').toString('hex');
  return `pbkdf2$${PIN_ITERATIONS}$${salt}$${derived}`;
}

function verifyPin(pin: string, stored: string): boolean {
  const parts = (stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;
  const derived = crypto.pbkdf2Sync(pin, parts[2], iterations, 32, 'sha256').toString('hex');
  const a = Buffer.from(derived, 'utf8');
  const b = Buffer.from(parts[3], 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 4 digits, and not something an attacker would guess in their first handful of
// tries. Rejecting these costs the player nothing and removes the worst PINs.
const BANNED_PINS = new Set(['0000', '1111', '1234', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '4321', '1212', '0123']);

function pinProblem(pin: string): string | null {
  if (!/^\d{4}$/.test(pin)) return 'PIN must be exactly 4 digits.';
  if (BANNED_PINS.has(pin)) return 'That PIN is too easy to guess. Choose a less obvious one.';
  return null;
}

// Our own reference. Namespaced so this app's transactions are identifiable in
// a Paystack dashboard that may carry traffic from more than one product.
function genPaystackRef(): string {
  return 'PINE_' + Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');
}

async function paystackGet(path: string): Promise<any> {
  const res = await fetch(`${PAYSTACK_API}${path}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
  });
  return res.json();
}

async function paystackPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${PAYSTACK_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

// The single path by which a Paystack payment ever becomes wallet balance.
// Called from BOTH /verify and the webhook; safe to call any number of times.
// `paidKobo` is what Paystack reported, not what the client claimed.
async function creditDeposit(
  reference: string, paidKobo: number, channel: string, currency: string,
): Promise<{ credited: boolean; reason?: string }> {
  const payment = await getPayment(reference);
  if (!payment) {
    // A charge for a reference we never issued. Should be impossible — log it
    // loudly rather than swallowing it.
    console.error(`Paystack ${reference}: charge for an unknown reference — ignored.`);
    return { credited: false, reason: 'unknown-reference' };
  }
  if (payment.status === 'credited') return { credited: false, reason: 'already-credited' };

  const paidNaira = paidKobo / 100;

  // Guard against a charge that doesn't match what we initialized. Underpayment
  // is rejected outright; overpayment credits only what we asked for, and is
  // logged loudly because it should be impossible.
  if (currency && currency.toUpperCase() !== 'NGN') {
    console.error(`Paystack ${reference}: unexpected currency ${currency}`);
    return { credited: false, reason: 'currency-mismatch' };
  }
  if (paidNaira + 0.001 < payment.amount) {
    console.error(`Paystack ${reference}: underpaid — expected ₦${payment.amount}, got ₦${paidNaira}`);
    return { credited: false, reason: 'amount-mismatch' };
  }
  if (paidNaira > payment.amount + 0.001) {
    console.error(`Paystack ${reference}: OVERPAID — expected ₦${payment.amount}, got ₦${paidNaira}. Crediting the expected amount.`);
  }

  // Compare-and-swap: only the caller that flips pending → credited pays out,
  // so /verify and a retrying webhook can both fire without double-crediting.
  const won = await creditPayment(reference, paidNaira, channel || 'unknown');
  if (!won) return { credited: false, reason: 'already-credited' };

  const profile = await ensureProfile(payment.email);
  profile.balance += payment.amount;
  addTransaction(payment.email, {
    id: generateHash(),
    type: 'deposit',
    amount: payment.amount,
    status: 'completed',
    timestamp: new Date().toISOString(),
    method: channel ? `Paystack · ${channel}` : 'Paystack',
    txHash: reference,
    balanceAfter: profile.balance,
  });
  saveProfile(payment.email);
  console.log(`Paystack ${reference}: credited ₦${payment.amount} to ${payment.email}`);
  return { credited: true };
}

// Initialize a deposit — returns the access code the Inline popup resumes.
app.post('/api/paystack/initialize', async (req, res) => {
  if (!paystackEnabled) {
    return res.status(503).json({ status: false, error: 'Payments are not configured yet.' });
  }
  const { email, amount } = req.body;
  const amt = parseFloat(amount);
  const cleanEmail = String(email || '').toLowerCase().trim();
  if (!cleanEmail || isNaN(amt) || amt <= 0) {
    return res.status(400).json({ status: false, error: 'Enter a valid amount to fund.' });
  }
  if (amt < MIN_DEPOSIT_NAIRA) {
    return res.status(400).json({ status: false, error: `Minimum deposit is ₦${MIN_DEPOSIT_NAIRA}.` });
  }

  await ensureProfile(cleanEmail);
  const reference = genPaystackRef();

  // Record what we intend to charge BEFORE talking to Paystack, so a payment
  // can never arrive for a reference we have no expected amount for.
  const recorded = await createPayment(reference, cleanEmail, amt);
  if (!recorded) {
    return res.status(500).json({ status: false, error: 'Could not start the payment. Please try again.' });
  }

  try {
    const out = await paystackPost('/transaction/initialize', {
      email: cleanEmail,
      amount: Math.round(amt * 100), // Paystack works in kobo
      currency: 'NGN',
      reference,
    });
    if (!out?.status || !out?.data?.access_code) {
      await markPaymentFailed(reference);
      console.error('Paystack initialize failed:', out?.message);
      return res.status(502).json({ status: false, error: out?.message || 'Could not reach Paystack.' });
    }
    res.json({
      status: true,
      reference,
      access_code: out.data.access_code,
      authorization_url: out.data.authorization_url,
      amount_kobo: Math.round(amt * 100),
    });
  } catch (e) {
    await markPaymentFailed(reference);
    console.error('Paystack initialize error:', e);
    res.status(502).json({ status: false, error: 'Could not reach Paystack. Please try again.' });
  }
});

// Verify a deposit — asks Paystack what actually happened, then credits.
// The client calls this when the popup closes; the webhook is the safety net.
app.post('/api/paystack/verify', async (req, res) => {
  if (!paystackEnabled) {
    return res.status(503).json({ status: false, error: 'Payments are not configured yet.' });
  }
  const reference = String(req.body?.reference || '').trim();
  if (!reference) return res.status(400).json({ status: false, error: 'Missing transaction reference.' });

  const payment = await getPayment(reference);
  if (!payment) return res.status(404).json({ status: false, error: 'Unknown transaction reference.' });

  try {
    const out = await paystackGet(`/transaction/verify/${encodeURIComponent(reference)}`);
    const data = out?.data;
    if (!out?.status || !data) {
      return res.status(502).json({ status: false, error: out?.message || 'Could not verify with Paystack.' });
    }

    if (data.status !== 'success') {
      // Deliberately NOT marked failed. 'abandoned' means "not paid yet" — the
      // player can still finish this same reference by transfer or USSD, and
      // the webhook must be able to credit them when they do.
      return res.json({ status: false, data: { status: data.status }, error: `Payment ${data.status}.` });
    }

    const result = await creditDeposit(reference, Number(data.amount), String(data.channel || ''), String(data.currency || ''));
    const profile = await ensureProfile(payment.email);

    // 'already-credited' is a success from the player's point of view — the
    // webhook simply got there first.
    const ok = result.credited || result.reason === 'already-credited';
    if (!ok) return res.status(400).json({ status: false, error: 'Payment could not be applied. Support has been notified.' });

    res.json({ status: true, data: { status: 'success', reference }, balance: profile.balance });
  } catch (e) {
    console.error('Paystack verify error:', e);
    res.status(502).json({ status: false, error: 'Could not reach Paystack. Your payment is safe — refresh in a moment.' });
  }
});

// Paystack webhook — the authoritative notification. Bank transfer and USSD
// settle asynchronously and may never come back through the popup at all, so
// without this those deposits would silently never land.
app.post('/api/paystack/webhook', async (req, res) => {
  if (!paystackEnabled) return res.sendStatus(503);

  const signature = String(req.headers['x-paystack-signature'] || '');
  const raw: Buffer | undefined = (req as any).rawBody;
  if (!raw || !signature) return res.sendStatus(400);

  // HMAC SHA512 over the EXACT bytes Paystack sent.
  const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(raw).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.warn('Paystack webhook: bad signature — ignored.');
    return res.sendStatus(401);
  }

  // Acknowledge immediately. Paystack retries anything that isn't a 200, and
  // we never want a slow database write to trigger a storm of retries.
  res.sendStatus(200);

  try {
    const event = req.body;
    if (event?.event === 'charge.success' && event?.data?.reference) {
      const d = event.data;
      await creditDeposit(String(d.reference), Number(d.amount), String(d.channel || ''), String(d.currency || ''));
    }
  } catch (e) {
    console.error('Paystack webhook handling error:', e);
  }
});

// Resolve a bank account (for withdrawals) — returns the account holder's name.
const NG_NAME_POOL = ['CHIDI OKAFOR', 'AMARA NWOSU', 'TUNDE ADEYEMI', 'ZAINAB BELLO', 'EMEKA ELEZE', 'NGOZI EZE', 'YUSUF IBRAHIM', 'FUNKE ADEBAYO', 'MUSA ALIYU', 'BLESSING OKON'];
app.post('/api/paystack/resolve-account', (req, res) => {
  const { accountNumber, bank } = req.body;
  const acct = String(accountNumber || '').replace(/\D/g, '');
  if (acct.length !== 10) return res.status(400).json({ status: false, error: 'Account number must be 10 digits.' });
  // Deterministic pseudo-name so the same number always resolves the same way.
  const name = NG_NAME_POOL[parseInt(acct.slice(-2), 10) % NG_NAME_POOL.length];
  res.json({ status: true, data: { account_number: acct, account_name: name, bank_name: bank || '' } });
});

// 2b. POST Buy tournament tickets — any quantity between MIN_TICKETS and
// MAX_TICKETS, priced per ticket and debited from the wallet.
app.post('/api/profile/buy-tickets', async (req, res) => {
  const { email, quantity } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Missing account email.' });
  }

  // Validate quantity: integer within [MIN_TICKETS, MAX_TICKETS].
  const qty = Math.floor(Number(quantity));
  if (isNaN(qty) || qty < MIN_TICKETS || qty > MAX_TICKETS) {
    return res.status(400).json({
      error: `Choose between ${MIN_TICKETS} and ${MAX_TICKETS} tickets.`,
    });
  }

  const profile = await ensureProfile(email);
  const unitPrice = adminConfig.ticketPackPrice; // price per ticket
  const cost = unitPrice * qty;

  if (profile.balance < cost) {
    return res.status(400).json({
      error: `Insufficient balance. ${qty} tickets cost ₦${cost.toLocaleString('en-NG')}. Add funds first.`,
    });
  }

  profile.balance -= cost;
  profile.tickets += qty;

  const newTx: Transaction = {
    id: generateHash(),
    type: 'ticket',
    amount: cost,
    status: 'completed',
    timestamp: new Date().toISOString(),
    method: `Tournament Tickets ×${qty}`,
    txHash: 'tx_tkt_' + Math.random().toString(36).substring(2, 10),
    balanceAfter: profile.balance,
  };
  addTransaction(email, newTx);
  saveProfile(email);

  // If this buyer arrived through someone's referral link, that referrer has now
  // earned their free ticket. A referral hiccup must never fail the purchase.
  await awardReferralIfEligible(email).catch(err => console.error('referral reward:', err));

  res.json({ success: true, tickets: profile.tickets, balance: profile.balance, transaction: newTx });
});

// 2a-i. POST set or change the withdrawal PIN.
// Changing an existing PIN requires the current one, so a hijacked session
// can't quietly swap the PIN and then drain the wallet.
app.post('/api/profile/set-pin', async (req, res) => {
  const { email, newPin, currentPin } = req.body || {};
  const cleanEmail = String(email || '').toLowerCase().trim();
  if (!cleanEmail) return res.status(400).json({ error: 'Missing account email.' });

  const problem = pinProblem(String(newPin || ''));
  if (problem) return res.status(400).json({ error: problem });

  await ensureProfile(cleanEmail);
  const existing = await getWithdrawalPinHash(cleanEmail);
  if (existing && !verifyPin(String(currentPin || ''), existing)) {
    return res.status(401).json({ error: 'Current PIN is incorrect.' });
  }

  const ok = await setWithdrawalPinHash(cleanEmail, hashPin(String(newPin)));
  if (!ok) return res.status(500).json({ error: 'Could not save your PIN. Please try again.' });

  const profile = await ensureProfile(cleanEmail);
  profile.hasWithdrawalPin = true; // keep the cached profile in step
  res.json({ success: true });
});

// 2b-i. GET this player's referral code, shareable link and reward progress.
app.get('/api/referral', async (req, res) => {
  const email = String(req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Missing account email.' });

  const profile = await ensureProfile(email);
  const code = await ensureReferralCode(email);
  profile.referralCode = code; // keep the cached profile in step

  const stats = await referralStats(email);
  const base = appBaseUrl(req);
  const summary: ReferralSummary = {
    code,
    link: code && base ? `${base}/?ref=${code}` : '',
    invited: stats.invited,
    rewarded: stats.rewarded,
    cap: adminConfig.referralRewardCap,
    remaining: Math.max(0, adminConfig.referralRewardCap - stats.rewarded),
    rewardTickets: REFERRAL_REWARD_TICKETS,
  };
  res.json(summary);
});

// 2b-ii. POST claim a referral code that was captured before sign-up.
// Attribution is one-shot and first-link-wins — it is never reassigned, and it
// pays out nothing here. The reward fires later, when this account buys tickets.
app.post('/api/referral/claim', async (req, res) => {
  const { email, code } = req.body || {};
  const cleanEmail = String(email || '').toLowerCase().trim();
  const cleanCode = normalizeReferralCode(String(code || ''));
  if (!cleanEmail || !cleanCode) {
    return res.status(400).json({ error: 'Missing account email or referral code.' });
  }

  // Creates the invitee's profile row if this is their very first request —
  // the referrals FK requires it to exist.
  const profile = await ensureProfile(cleanEmail);

  // The reward is for bringing in NEW players, so only an account that has done
  // nothing yet can be attributed. This stops an established player from being
  // farmed as somebody's referral.
  if (profile.history.length > 0 || profile.gamesPlayed > 0) {
    return res.json({ attached: false, reason: 'not-a-new-account' });
  }

  const referrerEmail = await findEmailByReferralCode(cleanCode);
  if (!referrerEmail) return res.json({ attached: false, reason: 'unknown-code' });
  if (referrerEmail.toLowerCase() === cleanEmail) {
    return res.json({ attached: false, reason: 'self-referral' });
  }

  const row = await createReferral(referrerEmail, cleanEmail, cleanCode);
  res.json({ attached: !!row, reason: row ? '' : 'already-referred' });
});

// 2c. GET public app config (includes isAdmin flag for the given email)
app.get('/api/config', (req, res) => {
  const email = (req.query.email as string) || '';
  res.json(publicConfig(email));
});

// 2d. POST verify admin credentials → returns the editable config
app.post('/api/admin/verify', (req, res) => {
  const { email, passcode } = req.body;
  if (!isAdminEmail(email) || passcode !== adminConfig.adminPasscode) {
    return res.status(401).json({ error: 'Invalid admin email or passcode.' });
  }
  const { adminPasscode, ...editable } = adminConfig;
  res.json({ success: true, config: { ...editable, casualForcedWinner: casualForcedWinnerName, allHandsForcedWinner: allHandsForcedWinnerName } });
});

// 2e. POST update admin config (email + passcode required)
app.post('/api/admin/config', async (req, res) => {
  const { email, passcode, config } = req.body;
  if (!isAdminEmail(email) || passcode !== adminConfig.adminPasscode) {
    return res.status(401).json({ error: 'Invalid admin email or passcode.' });
  }
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'Missing config payload.' });
  }

  const str = (v: any, fb: string) => (typeof v === 'string' && v.trim() ? v.trim() : fb);
  const num = (v: any, fb: number, min: number, max: number) => {
    const n = Number(v);
    return isNaN(n) ? fb : Math.min(Math.max(n, min), max);
  };

  // Arena & room (accept new `roomName` key, fall back to legacy `defaultRoomId`).
  adminConfig.arenaName = str(config.arenaName, adminConfig.arenaName);
  adminConfig.defaultRoomId = str(config.roomName ?? config.defaultRoomId, adminConfig.defaultRoomId);

  // Single tournament: sponsor name + cash prize. The sponsor MAY be cleared
  // (empty string) to deactivate the tournament, so set it directly when a
  // string is provided rather than falling back to the previous value.
  adminConfig.prizeMode = 'fixed';
  const sponsorIn = config.sponsorName ?? config.fixedSponsorName;
  if (typeof sponsorIn === 'string') adminConfig.fixedSponsorName = sponsorIn.trim();
  adminConfig.fixedPrize = num(config.sponsorPrize ?? config.fixedPrize, adminConfig.fixedPrize, 0, 100000000);

  // Ticket economy: `ticketPrice` is the price per ticket.
  adminConfig.ticketPackPrice = num(config.ticketPrice ?? config.ticketPackPrice, adminConfig.ticketPackPrice, 0, 100000000);
  if (typeof config.freeGameEnabled === 'boolean') adminConfig.freeGameEnabled = config.freeGameEnabled;
  // Referral rewards: most free tickets one player can earn. 0 pauses payouts
  // (links keep working, pending referrals stay queued for a later raise).
  adminConfig.referralRewardCap = Math.round(
    num(config.referralRewardCap, adminConfig.referralRewardCap, 0, 1000),
  );

  // Tournament field size (seats the bracket auto-fills to). Stored rounded to a
  // multiple of 4 so tables are always full.
  const fieldRaw = num(config.tournamentFieldSize, adminConfig.tournamentFieldSize, MIN_FIELD_SIZE, MAX_FIELD_SIZE);
  adminConfig.tournamentFieldSize = Math.max(4, Math.round(fieldRaw / 4) * 4);
  // Gameplay
  adminConfig.turnTimerSeconds = num(config.turnTimerSeconds, adminConfig.turnTimerSeconds, 5, 120);
  adminConfig.maxPlayers = num(config.maxPlayers, adminConfig.maxPlayers, 2, 4);
  if (typeof config.autoBotFill === 'boolean') adminConfig.autoBotFill = config.autoBotFill;
  // Access control
  if (Array.isArray(config.adminEmails)) {
    const cleaned = config.adminEmails.map((s: any) => String(s).toLowerCase().trim()).filter(Boolean);
    if (cleaned.length) adminConfig.adminEmails = cleaned;
  }
  if (typeof config.adminPasscode === 'string' && config.adminPasscode.trim()) {
    adminConfig.adminPasscode = config.adminPasscode.trim();
  }

  // Bots (TEST): which bot names may be seated (casual + bracket), and which bot
  // wins CASUAL games. casualForcedWinner is in-memory only (test rig).
  if (Array.isArray(config.botRoster)) {
    adminConfig.botRoster = config.botRoster.map((s: any) => String(s).trim()).filter(Boolean).slice(0, 100);
  }
  if (typeof config.casualForcedWinner === 'string') {
    casualForcedWinnerName = config.casualForcedWinner.trim();
  }
  if (typeof config.allHandsForcedWinner === 'string') {
    allHandsForcedWinnerName = config.allHandsForcedWinner.trim();
  }

  // Write the updated config through to Supabase so it survives restarts.
  await saveAdminConfig(adminConfig);

  // Apply the current tournament live to any open (not-yet-started) table and
  // push it to every connected client so all devices stay in sync immediately.
  const t = currentTournament();
  Object.keys(gameRooms).forEach(roomId => {
    const room = gameRooms[roomId];
    if (room && (room.status === 'waiting' || room.status === 'betting')) {
      room.sponsorName = t.sponsorName;
      room.sponsorPrize = t.prize;
      room.pot = t.prize;
      broadcastRoomState(roomId);
    }
  });

  const { adminPasscode, ...editable } = adminConfig;
  res.json({ success: true, config: { ...editable, casualForcedWinner: casualForcedWinnerName, allHandsForcedWinner: allHandsForcedWinnerName } });
});

// -----------------------------------------------------------------------------
// KNOCKOUT TOURNAMENT — admin control endpoints (email + passcode required).
// -----------------------------------------------------------------------------
function requireAdmin(req: any, res: any): boolean {
  const { email, passcode } = req.body || {};
  if (!isAdminEmail(email) || passcode !== adminConfig.adminPasscode) {
    res.status(401).json({ error: 'Invalid admin email or passcode.' });
    return false;
  }
  return true;
}

app.post('/api/tournament/create', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const r = createTournament();
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ success: true, status: tournamentStatus() });
});

app.post('/api/tournament/simulate', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const r = simulateEntrants(Number(req.body.count) || 0);
  if (r.error) return res.status(400).json({ error: r.error });
  broadcastLobby(); // keep registered humans' player counts fresh
  res.json({ success: true, status: tournamentStatus() });
});

// Public (no-auth) bracket summary for the lobby's "Register" state.
app.get('/api/tournament/public', (_req, res) => {
  res.json(tournamentPublicState());
});

app.post('/api/tournament/start', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const r = startTournamentRun();
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ success: true, status: tournamentStatus() });
});

app.post('/api/tournament/reset', (req, res) => {
  if (!requireAdmin(req, res)) return;
  resetTournament();
  res.json({ success: true, status: tournamentStatus() });
});

// TEST: set the casual-game preselected winner (a bot name) instantly, so it
// doesn't need a settings save. Silent — players are never told.
app.post('/api/tournament/casual-winner', (req, res) => {
  if (!requireAdmin(req, res)) return;
  casualForcedWinnerName = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const casualRoom = adminConfig.defaultRoomId;
  if (gameRooms[casualRoom]) broadcastRoomState(casualRoom); // update the mark live
  res.json({ success: true, casualForcedWinner: casualForcedWinnerName });
});

// TEST: set the All Hands on Deck preselected winner (a bot name or a seated
// human's nickname) instantly. Silent: nothing is broadcast, marked or announced
// — the pick only changes who survives to the end. In-memory only.
app.post('/api/all-hands/force-winner', (req, res) => {
  if (!requireAdmin(req, res)) return;
  allHandsForcedWinnerName = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  res.json({ success: true, allHandsForcedWinner: allHandsForcedWinnerName });
});

// TEST: silently pick a winner (or clear with entrantId=null). Nothing is
// announced or marked — players only ever see the normal result.
app.post('/api/tournament/force-winner', (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!tournament) return res.status(400).json({ error: 'No tournament.' });
  const entrantId: string | null = req.body.entrantId || null;
  if (entrantId && !tournament.entrants.find(e => e.id === entrantId)) {
    return res.status(400).json({ error: 'That entrant is not in this tournament.' });
  }
  tournament.forcedWinnerId = entrantId;
  // No arena-chat announcement and no per-table mark: the pick stays admin-only.
  res.json({ success: true, status: tournamentStatus() });
});

// Read-only bracket snapshot for the admin dashboard poller.
app.get('/api/tournament/status', (req, res) => {
  const email = (req.query.email as string) || '';
  if (!isAdminEmail(email)) return res.status(401).json({ error: 'Admin only.' });
  res.json(tournamentStatus());
});

// Player-safe bracket for eliminated spectators (names only — no bot flags/ids).
app.get('/api/tournament/spectate', (_req, res) => {
  if (!tournament) return res.json({ exists: false });
  const nameOf = (id: string | null) => (id ? (entrantById(id)?.name ?? '—') : '—');
  res.json({
    exists: true,
    status: tournament.status,
    currentRound: tournament.currentRound,
    totalRounds: tournament.rounds.length,
    championName: tournament.championId ? nameOf(tournament.championId) : null,
    // forcedWinnerName is deliberately NOT exposed here — spectators must never
    // be able to tell who was preselected.
    rounds: tournament.rounds.map(r => ({
      index: r.index,
      byes: r.byes.map(nameOf),
      tables: r.tables.map(tb => ({
        roomId: tb.roomId,
        players: tb.entrantIds.map(nameOf),
        winner: nameOf(tb.winnerId),
        done: tb.status === 'finished',
      })),
    })),
  });
});

// Live snapshot of a single tournament table. Hands are omitted — only public
// game state (counts, top card, turn, recent log) — so it's safe for eliminated
// players to spectate too, not just admins.
app.get('/api/tournament/table', (req, res) => {
  const roomId = (req.query.roomId as string) || '';
  if (!tournamentTableIds.has(roomId) || !gameRooms[roomId]) return res.json({ exists: false });
  const room = gameRooms[roomId];
  const top = room.discardPile[room.discardPile.length - 1] || null;
  const winner = room.winnerPlayerId ? room.players.find(p => p.id === room.winnerPlayerId) : null;

  // A full, spectator-SAFE GameState the client can render with the real
  // GameBoard — so watching looks exactly like playing. Hidden info is stripped:
  // player hands are emptied (opponents render face-down from cardsCount) and the
  // draw pile order is never sent (only its count). The discard pile is public.
  const specState = {
    roomId: room.roomId,
    status: room.status,
    players: room.players.map(p => ({
      ...p,
      isBot: false,              // never reveal bots, same as broadcastRoomState
      hand: [],                  // hide hands from spectators
    })),                         // and never reveal the preselected winner
    pot: room.pot,
    activePlayerIndex: room.activePlayerIndex,
    logs: room.logs.slice(-40),
    turnTimeLeft: room.turnTimeLeft,
    winnerPlayerId: room.winnerPlayerId,
    potWinnerId: room.potWinnerId,
    antiCheatLog: [],
    sponsorName: room.sponsorName,
    sponsorPrize: room.sponsorPrize,
    drawPileCount: room.drawPileCount,
    discardPile: room.discardPile,
    requestedSuit: room.requestedSuit,
    turnDirection: room.turnDirection,
  };

  res.json({
    exists: true,
    roomId,
    status: room.status,
    topCard: top ? { suit: top.suit, value: top.value } : null,
    requestedSuit: room.requestedSuit,
    drawPileCount: room.drawPileCount,
    winnerName: winner ? winner.name : null,
    players: room.players.map((p, i) => ({
      name: p.name,
      color: p.color,
      cardsCount: p.cardsCount,
      active: room.status === 'playing' && i === room.activePlayerIndex,
    })),
    logs: room.logs.slice(-30).map(l => ({ message: l.message, type: l.type, timestamp: l.timestamp })),
    state: specState,
  });
});

// 3. POST Simulated Withdrawal Portal (For verified users)
app.post('/api/profile/withdraw', async (req, res) => {
  const { email, amount, method, pin } = req.body;

  if (!email || !amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid withdrawal details' });
  }

  const profile = await ensureProfile(email);

  if (profile.verificationStatus !== 'verified') {
    return res.status(403).json({ error: 'Verification Required: Please submit your KYC documents in the portal before making a withdrawal.' });
  }

  const storedPin = await getWithdrawalPinHash(email);
  if (!storedPin) {
    return res.status(403).json({ error: 'Set a withdrawal PIN in the cashier before making a withdrawal.', needsPin: true });
  }
  if (!pin || !verifyPin(String(pin), storedPin)) {
    return res.status(401).json({ error: 'Incorrect withdrawal PIN.' });
  }

  if (profile.balance < parseFloat(amount)) {
    return res.status(400).json({ error: 'Insufficient ledger balance.' });
  }

  const txId = generateHash();
  // Paystack transfer references start with TRF_.
  const txHash = 'TRF_' + Math.random().toString(36).substring(2, 12);

  profile.balance -= parseFloat(amount);

  const newTx: Transaction = {
    id: txId,
    type: 'withdrawal',
    amount: parseFloat(amount),
    status: 'completed',
    timestamp: new Date().toISOString(),
    method: method || 'Paystack Transfer',
    txHash: txHash,
    balanceAfter: profile.balance,
  };

  addTransaction(email, newTx);
  saveProfile(email);

  res.json({ success: true, transaction: newTx, balance: profile.balance });
});

// 4. POST Simulated ID Verification submission (KYC)
app.post('/api/profile/verify', async (req, res) => {
  const { email, fullName, idType, idNumber } = req.body;

  if (!email || !fullName || !idType || !idNumber) {
    return res.status(400).json({ error: 'All verification fields are required' });
  }

  const profile = await ensureProfile(email);
  profile.verificationStatus = 'verified';
  profile.verificationDetails = {
    fullName,
    idType,
    idNumber: idNumber.replace(/.(?=.{4})/g, '*'),
    submittedAt: new Date().toISOString(),
  };
  saveProfile(email);

  res.json({ success: true, status: 'verified', details: profile.verificationDetails });
});

// 5. POST Export User Profile (GDPR compliance)
app.post('/api/profile/export', async (req, res) => {
  const { email } = req.body;
  const profile = await ensureProfile(email);
  res.json({ success: true, profileData: profile });
});

// 6. POST Delete/Purge User Profile (GDPR compliance Right to be Forgotten)
app.post('/api/profile/delete', async (req, res) => {
  const { email } = req.body;
  const cleanEmail = (email || '').toLowerCase().trim();
  delete profileCache[cleanEmail];
  await deleteProfile(cleanEmail);
  res.json({ success: true, message: 'All personal data associated with your email has been fully purged from database aggregates.' });
});


// -----------------------------------------------------------------------------
// WEBSOCKET SERVER IMPLEMENTATION
// -----------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', async (ws: WebSocket, req) => {
  const urlParams = new URLSearchParams(req.url?.split('?')[1] || '');
  const userEmail = (urlParams.get('email') || 'hudozit@gmail.com').toLowerCase().trim();
  const userName = urlParams.get('name') || 'VoltGamer';
  const connId = `${userEmail}_${Date.now()}`;
  // Keepalive: browsers auto-reply to ping with pong; we mark the socket alive so
  // the heartbeat below can drop truly dead connections.
  (ws as any).isAlive = true;
  ws.on('pong', () => { (ws as any).isAlive = true; });
  await ensureProfile(userEmail); // load into cache

  // All Hands on Deck is the ONLY game now — everyone connects straight to the
  // survival table. (The bracket/tournament engine is retired; its code is left
  // dormant/unreachable.) Reconnecting seated players resume; everyone else lands
  // in the table view (lobby if waiting, spectating if a game is already running).
  const ahRoom = getOrCreateAllHandsRoom();
  const seated = ahRoom.players.find(x => x.id === userEmail);
  if (seated) { seated.isConnected = true; seated.name = userName; }
  activeConnections[connId] = { ws, email: userEmail, roomId: ALL_HANDS_ROOM };
  broadcastRoomState(ALL_HANDS_ROOM);

  ws.on('message', (messageStr: string) => {
    let msg: any;
    try {
      msg = JSON.parse(messageStr);
    } catch (e) {
      return;
    }

    // Register for the bracket (needs no room yet).
    if (msg.type === 'tournament-register') {
      const r = registerHumanEntrant(userEmail, userName);
      if (r.error) {
        ws.send(JSON.stringify({ type: 'error', message: r.error }));
      } else {
        setConnRoomForEmail(userEmail, TOURNEY_LOBBY);
        broadcastLobby();
      }
      return;
    }

    // Join the All Hands on Deck table (handled before the room guard because the
    // player isn't seated yet). Auto-starts once enough humans join to fill it.
    if (msg.type === 'enter-all-hands') {
      const room = getOrCreateAllHandsRoom();
      if (room.status === 'finished') resetAllHandsRoom(room);
      if (room.status === 'playing') {
        setConnRoomForEmail(userEmail, ALL_HANDS_ROOM);
        ws.send(JSON.stringify({ type: 'warning', message: 'A game is already in progress — you can watch, then join the next one.' }));
        broadcastRoomState(ALL_HANDS_ROOM);
        return;
      }
      if (!allHandsPrizeInfo().active) {
        ws.send(JSON.stringify({ type: 'error', message: 'All Hands on Deck is not available right now.' }));
        return;
      }
      const seat = seatAllHandsHuman(room, userEmail, userName);
      if (!seat) {
        ws.send(JSON.stringify({ type: 'warning', message: 'The All Hands table is full.' }));
        return;
      }
      room.status = 'betting';
      setConnRoomForEmail(userEmail, ALL_HANDS_ROOM);
      // Auto-start once humans alone fill the configured table size.
      if (room.players.filter(p => !p.isBot).length >= clampAllHandsSize(allHandsSize)) {
        startAllHands(room);
      }
      broadcastRoomState(ALL_HANDS_ROOM);
      return;
    }

    // Fill remaining seats with bots and deal immediately (the "Play now" button).
    if (msg.type === 'start-all-hands') {
      const room = gameRooms[ALL_HANDS_ROOM];
      if (!room || room.status === 'playing' || room.status === 'finished') return;
      if (!room.players.some(p => p.id === userEmail && !p.isBot)) {
        ws.send(JSON.stringify({ type: 'warning', message: 'Join the table before starting.' }));
        return;
      }
      startAllHands(room);
      broadcastRoomState(ALL_HANDS_ROOM);
      return;
    }

    // Arena chat works from anywhere in the tournament (playing / waiting /
    // lobby), so handle it before the game-room guard.
    if (msg.type === 'chat-message') {
      const chatMsg = (msg.message || '').toString();
      if (!chatMsg.trim()) return;
      const roomId = activeConnections[connId]?.roomId || '';
      const seat = gameRooms[roomId]?.players.find(p => p.id === userEmail);
      const senderName = seat?.name || entrantById(userEmail)?.name || userName;
      broadcastArenaChat({
        id: 'chat_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
        senderName,
        senderColor: seat?.color ?? null,
        message: chatMsg.substring(0, 150),
        timestamp: new Date().toISOString(),
      }, roomId);
      return;
    }

    // The player's current room (a game table) — dynamic so it follows them
    // across bracket rounds. Pseudo-rooms (lobby/wait/out) have no gameRoom.
    const userRoomId = activeConnections[connId]?.roomId || '';
    const currentRoom = gameRooms[userRoomId];
    if (!currentRoom) return;

    const actionPlayer = currentRoom.players.find(p => p.id === userEmail);
    if (!actionPlayer) return;

    // Player is already loaded into the cache from the connect handler.
    const freshProfile = getProfile(userEmail);
    actionPlayer.balance = freshProfile.balance;

    switch (msg.type) {
      // Enter the current sponsored tournament (free game first, then 1 ticket each).
      // 'place-bet' is kept as a legacy alias from the older betting model.
      case 'enter-tournament':
      case 'place-bet': {
        // A finished tournament reopens fresh on the next entry.
        if (currentRoom.status === 'finished') {
          resetRoomForNewTournament(currentRoom);
        }

        if (currentRoom.status !== 'waiting' && currentRoom.status !== 'betting') {
          ws.send(JSON.stringify({ type: 'warning', message: 'Entries are closed for this active tournament.' }));
          return;
        }

        if (actionPlayer.ready) {
          ws.send(JSON.stringify({ type: 'warning', message: 'You have already entered this tournament.' }));
          return;
        }

        // A tournament must be active to enter.
        const active = currentTournament();
        if (!active.active) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'No tournaments available right now. Please check back soon.',
          }));
          return;
        }
        // Lock the current sponsor/prize onto the room.
        currentRoom.sponsorName = active.sponsorName;
        currentRoom.sponsorPrize = active.prize;
        currentRoom.pot = active.prize;

        // Entry cost: lifetime free game first (if enabled), then consume a ticket.
        let entryMethod: string;
        if (adminConfig.freeGameEnabled && !freshProfile.freeGameUsed) {
          freshProfile.freeGameUsed = true;
          entryMethod = 'Free Game';
        } else if (freshProfile.tickets > 0) {
          freshProfile.tickets -= 1;
          entryMethod = `Ticket (${freshProfile.tickets} left)`;
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'You have no tickets left. Buy tickets in the Cashier to enter tournaments.',
          }));
          return;
        }

        actionPlayer.currentBet = 0;
        actionPlayer.balance = freshProfile.balance;
        actionPlayer.ready = true;
        currentRoom.status = 'betting';
        // Persist the consumed free game / ticket so it survives a restart.
        saveProfile(userEmail);

        currentRoom.logs.push({
          id: 'log_entry_' + Date.now(),
          message: `🎟️ ${actionPlayer.name} entered the ${currentRoom.sponsorName} tournament via ${entryMethod}!`,
          type: 'bet',
          timestamp: new Date().toISOString(),
        });

        autoFillAndStartIfReady(currentRoom);
        broadcastRoomState(userRoomId);
        break;
      }

      case 'add-bots-manually': {
        if (currentRoom.status !== 'waiting' && currentRoom.status !== 'betting') {
          // Silently return so client-scheduled timeouts don't trigger fatal disconnections.
          return;
        }

        if (currentRoom.players.length >= Math.min(Math.max(adminConfig.maxPlayers, 2), 4)) {
          ws.send(JSON.stringify({ type: 'warning', message: 'Table seating is full.' }));
          return;
        }

        // Fill the remaining seats with bots; deal immediately if the table is ready.
        fillSeatsWithBots(currentRoom);
        if (!autoFillAndStartIfReady(currentRoom)) {
          currentRoom.pot = currentRoom.sponsorPrize;
        }
        broadcastRoomState(userRoomId);
        break;
      }

      // Whot specific Card handlers
      case 'draw-card': {
        executeWhotDrawCard(userRoomId, userEmail);
        break;
      }

      case 'play-card': {
        executeWhotPlayCard(userRoomId, userEmail, msg.cardId);
        break;
      }

      case 'declare-suit': {
        const declaredSuit = msg.suit as CardSuit;
        if (currentRoom.status !== 'playing') return;

        const activeP = currentRoom.players[currentRoom.activePlayerIndex];
        if (activeP.id !== userEmail) return;

        const lastPlayed = currentRoom.discardPile[currentRoom.discardPile.length - 1];
        if (lastPlayed.value !== 20) return; // Must be wild play

        currentRoom.requestedSuit = declaredSuit;
        currentRoom.logs.push({
          id: 'log_whot_declared_' + Date.now(),
          message: `🌟 ${activeP.name} declared the next suit to be [${declaredSuit.toUpperCase()}]!`,
          type: 'info',
          timestamp: new Date().toISOString(),
        });

        // Pass turn
        const nextPlayerIndex = (currentRoom.activePlayerIndex + currentRoom.turnDirection + currentRoom.players.length) % currentRoom.players.length;
        currentRoom.activePlayerIndex = nextPlayerIndex;
        currentRoom.turnTimeLeft = adminConfig.turnTimerSeconds;

        const nextActiveP = currentRoom.players[currentRoom.activePlayerIndex];
        currentRoom.logs.push({
          id: 'log_next_turn_' + Date.now(),
          message: `👉 It is now ${nextActiveP.name}'s turn!`,
          type: 'info',
          timestamp: new Date().toISOString(),
        });

        broadcastRoomState(userRoomId);

        if (nextActiveP.isBot) {
          runBotWhotAction(userRoomId, nextActiveP);
        }
        break;
      }

      // Graceful Legacy Support
      case 'roll-dice': {
        // Map legacy dice roll to drawing card if it is user's turn
        executeWhotDrawCard(userRoomId, userEmail);
        break;
      }

      case 'move-token': {
        // Map legacy token moves to playing a matching card if possible
        const activeP = currentRoom.players[currentRoom.activePlayerIndex];
        if (activeP.id === userEmail) {
          const topCard = currentRoom.discardPile[currentRoom.discardPile.length - 1];
          const playable = activeP.hand.find(c => {
            if (c.value === 20) return true;
            if (currentRoom.requestedSuit) return c.suit === currentRoom.requestedSuit;
            return c.suit === topCard.suit || c.value === topCard.value;
          });
          if (playable) {
            executeWhotPlayCard(userRoomId, userEmail, playable.id);
          } else {
            executeWhotDrawCard(userRoomId, userEmail);
          }
        }
        break;
      }

    }
  });

  ws.on('close', () => {
    const roomId = activeConnections[connId]?.roomId;
    delete activeConnections[connId];

    const currentRoom = roomId ? gameRooms[roomId] : undefined;
    if (currentRoom) {
      const p = currentRoom.players.find(p => p.id === userEmail);
      if (p) {
        p.isConnected = false;

        currentRoom.logs.push({
          id: 'log_leave_' + Date.now(),
          message: `⚠️ ${p.name} left the seat.`,
          type: 'info',
          timestamp: new Date().toISOString(),
        });

        // Tournament tables keep running (bots + watchdog decide it); never
        // delete them on a human disconnect. Only casual rooms auto-clean.
        if (tournamentTableIds.has(roomId!)) {
          broadcastRoomState(roomId!);
        } else {
          const anyHumans = currentRoom.players.some(p => !p.isBot && p.isConnected);
          if (!anyHumans) {
            delete gameRooms[roomId!];
          } else {
            broadcastRoomState(roomId!);
          }
        }
      }
    }
  });
});

// Periodic turn timer tick (1 second intervals)
setInterval(() => {
  Object.keys(gameRooms).forEach(roomId => {
    const state = gameRooms[roomId];
    if (state && state.status === 'playing') {
      if (state.turnTimeLeft > 1) {
        state.turnTimeLeft--;
      } else {
        // Player timed out! Force a card draw to proceed
        const activePlayer = state.players[state.activePlayerIndex];
        
        state.logs.push({
          id: 'log_timeout_' + Date.now(),
          message: `⏰ Turn timeout! ${activePlayer.name}'s turn timed out. Forced market draw.`,
          type: 'cheat',
          timestamp: new Date().toISOString(),
        });

        state.antiCheatLog.push({
          id: 'stalling_' + Date.now(),
          timestamp: new Date().toISOString(),
          playerId: activePlayer.id,
          playerName: activePlayer.name,
          type: 'turn_stalling',
          severity: 'low',
          details: 'User failed to play or draw within the authorized 20-second window.',
        });

        executeWhotDrawCard(roomId, activePlayer.id);
      }
    }
  });

  // Tournament watchdog: force-resolve any table that ran past its time cap so a
  // deadlocked/stalled game can never freeze the bracket.
  if (tableDeadlines.size > 0) {
    const now = Date.now();
    for (const [roomId, deadline] of tableDeadlines) {
      if (now >= deadline) forceResolveTournamentTable(roomId);
    }
  }
}, 1000);

// WebSocket keepalive: ping every 25s so idle connections aren't dropped by the
// hosting proxy mid-game, and terminate any that stop responding (dead sockets).
setInterval(() => {
  wss.clients.forEach((ws) => {
    if ((ws as any).isAlive === false) { ws.terminate(); return; }
    (ws as any).isAlive = false;
    try { ws.ping(); } catch { /* socket already closing */ }
  });
}, 25000);

// AI opponents drop occasional banter into the shared arena chat so it feels
// like a room full of people.
setInterval(() => {
  if (!tournament || tournament.status !== 'running') return;
  const bots = tournament.entrants.filter(e => e.isBot);
  if (!bots.length || Math.random() > 0.55) return;
  const bot = bots[Math.floor(Math.random() * bots.length)];
  const line = BOT_CHAT_LINES[Math.floor(Math.random() * BOT_CHAT_LINES.length)];
  const colors: PlayerColor[] = ['red', 'green', 'yellow', 'blue'];
  broadcastArenaChat({
    id: 'chat_bot_' + Date.now() + '_' + Math.random().toString(36).substring(2, 5),
    senderName: bot.name,
    senderColor: colors[Math.floor(Math.random() * colors.length)],
    message: line,
    timestamp: new Date().toISOString(),
  }, '');
}, 9000);


// -----------------------------------------------------------------------------
// VITE DEV SERVER MIDDLEWARE & STATIC SERVING FOR PRODUCTION
// -----------------------------------------------------------------------------
async function startServer() {
  // Load the authoritative admin config from Supabase into the in-memory cache.
  try {
    const loaded = await loadAdminConfig();
    if (loaded) {
      Object.assign(adminConfig, loaded);
      console.log('✅ Admin config loaded from Supabase.');
    } else {
      console.log('ℹ️  Using default admin config (Supabase not loaded).');
    }
  } catch (e) {
    console.error('Admin config load failed; using defaults.', e);
  }

  if (process.env.NODE_ENV !== 'production') {
    // Vite is a dev-only dependency; load it lazily so production never requires it.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Whot Card Server running at http://localhost:${PORT}`);
  });
}

startServer();
