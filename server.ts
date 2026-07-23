// MUST be first: populates process.env from .env.local before db.ts reads it.
import './src/load-env.js';
import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { GameState, Player, PlayerColor, WhotCard, CardSuit, GameLog, Transaction, UserProfile, AntiCheatAlert } from './src/types.js';
import {
  AdminConfig,
  loadAdminConfig, saveAdminConfig,
  loadProfile, persistProfile, recordTransaction, deleteProfile,
} from './src/db.js';

const PORT = Number(process.env.PORT) || 5174;
const app = express();
app.use(express.json());

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
      highestRoll: 0, tickets: 0, freeGameUsed: false, verificationStatus: 'unverified',
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

const adminConfig: AdminConfig = {
  arenaName: 'Neon Whot! Bet',
  defaultRoomId: 'Pine Arena',
  prizeMode: 'fixed',
  fixedSponsorName: 'IgniTech',
  fixedPrize: 100000,
  sponsorPool: [],
  prizeMin: 0,
  prizeMax: 0,
  ticketPackPrice: 300, // ₦ per ticket
  ticketPackSize: 1,
  freeGameEnabled: true,
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
    if (drawPile.length === 0) {
      // Recycle discard pile except top card
      if (room.discardPile.length > 1) {
        const topCard = room.discardPile.pop()!;
        const recycled = [...room.discardPile];
        room.discardPile = [topCard];

        // Shuffle recycled
        for (let k = recycled.length - 1; k > 0; k--) {
          const j = Math.floor(Math.random() * (k + 1));
          [recycled[k], recycled[j]] = [recycled[j], recycled[k]];
        }

        drawPile.push(...recycled);
        room.logs.push({
          id: 'log_recycle_' + Date.now(),
          message: `🔄 Discard pile was recycled and shuffled back into the Market draw pile!`,
          type: 'info',
          timestamp: new Date().toISOString(),
        });
      } else {
        // Fallback generate fresh deck
        const newDeck = createWhotDeck();
        drawPile.push(...newDeck);
      }
    }

    if (drawPile.length > 0) {
      drawn.push(drawPile.shift()!);
    }
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

// Fill remaining empty seats (up to the configured max) with opponents.
function fillSeatsWithBots(room: GameState) {
  if (!adminConfig.autoBotFill) return;
  const colors: PlayerColor[] = ['red', 'green', 'yellow', 'blue'];
  const cap = Math.min(Math.max(adminConfig.maxPlayers, 2), 4);
  while (room.players.length < cap) {
    const assigned = room.players.map(p => p.color).filter(Boolean) as PlayerColor[];
    const color = colors.find(c => !assigned.includes(c));
    if (!color) break;
    // Pick a human name not already seated at this table.
    const taken = new Set(room.players.map(p => p.name));
    const name = OPPONENT_NAMES.find(n => !taken.has(n))
      || OPPONENT_NAMES[Math.floor(Math.random() * OPPONENT_NAMES.length)];
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

// Broadcast game state to all clients in a room
function broadcastRoomState(roomId: string) {
  const state = gameRooms[roomId];
  if (!state) return;

  // Never reveal that a seat is a bot — to players every opponent is a human.
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

  room.status = 'finished';
  room.winnerPlayerId = winnerId;
  room.potWinnerId = winnerId;

  const winner = room.players.find(p => p.id === winnerId);
  const isTourney = tournamentTableIds.has(roomId);
  const prizeAmount = room.sponsorPrize;
  const sponsor = room.sponsorName || 'Tournament Sponsor';

  room.logs.push({
    id: 'log_end_' + Date.now(),
    message: `🏆 ${winner ? winner.name : 'Unknown'} played all cards and won the table!`,
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
      method: `${sponsor} Tournament Prize`,
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
const TOURNAMENT_TABLE_MAX_MS = 45000; // 45s hard cap per table game

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
  startWhotGameSession(gameRooms[roomId]);
}

// Partition entrant ids into tables of up to 4. A leftover group of exactly one
// gets a bye (auto-advance). Groups of 2-3 play a short table (valid in Whot).
function buildRound(entrantIds: string[], roundIndex: number): TournamentRound {
  const shuffled = shuffle([...entrantIds]);
  const tables: TournamentTable[] = [];
  const byes: string[] = [];
  chunk(shuffled, 4).forEach((group, i) => {
    if (group.length === 1) { byes.push(group[0]); return; }
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
  if (round.tables.every(t => t.status === 'finished')) {
    advanceTournament([...round.tables.map(t => t.winnerId!), ...round.byes]);
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
  for (let i = 0; i < n; i++) {
    const name = OPPONENT_NAMES[(base + i) % OPPONENT_NAMES.length] + '-' + (base + i + 1);
    tournament.entrants.push({ id: `sim_${base + i}_${Math.random().toString(36).slice(2, 6)}`, name, isBot: true });
  }
  return { ok: true };
}

function startTournamentRun(): { ok?: true; error?: string } {
  if (!tournament || tournament.status !== 'registering') return { error: 'No tournament open for registration.' };
  if (tournament.entrants.length < 2) return { error: 'Need at least 2 entrants to start.' };
  tournament.status = 'running';
  tournament.currentRound = 1;
  const round = buildRound(tournament.entrants.map(e => e.id), 1);
  tournament.rounds = [round];
  if (round.tables.length === 0) advanceTournament(round.byes);
  return { ok: true };
}

function resetTournament() {
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

  // Victory check
  if (activeP.cardsCount === 0) {
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
  if (drawn.length > 0) {
    activeP.hand.push(...drawn);
    activeP.cardsCount = activeP.hand.length;

    room.logs.push({
      id: 'log_draw_' + Date.now(),
      message: `📥 ${activeP.name} draws 1 card from the Market.`,
      type: 'roll',
      timestamp: new Date().toISOString(),
    });
  }

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
    message: `🚀 ${room.sponsorName || 'Sponsored'} Tournament started! Each player has 5 cards. Cash prize: ₦${room.sponsorPrize.toLocaleString('en-NG')}.`,
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

// 2. POST Simulated Payment Deposit
app.post('/api/profile/deposit', async (req, res) => {
  const { email, amount, method } = req.body;

  if (!email || !amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid deposit details' });
  }

  const profile = await ensureProfile(email);
  const txId = generateHash();
  const txHash = 'tx_chain_' + Math.random().toString(36).substring(2, 10);

  const newTx: Transaction = {
    id: txId,
    type: 'deposit',
    amount: parseFloat(amount),
    status: 'completed',
    timestamp: new Date().toISOString(),
    method: method || 'Credit Card',
    txHash: txHash,
    balanceAfter: profile.balance + parseFloat(amount),
  };

  profile.balance += parseFloat(amount);
  addTransaction(email, newTx);
  saveProfile(email);

  res.json({ success: true, transaction: newTx, balance: profile.balance });
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

  res.json({ success: true, tickets: profile.tickets, balance: profile.balance, transaction: newTx });
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
  res.json({ success: true, config: editable });
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
  res.json({ success: true, config: editable });
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
  res.json({ success: true, status: tournamentStatus() });
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

// Read-only bracket snapshot for the admin dashboard poller.
app.get('/api/tournament/status', (req, res) => {
  const email = (req.query.email as string) || '';
  if (!isAdminEmail(email)) return res.status(401).json({ error: 'Admin only.' });
  res.json(tournamentStatus());
});

// Live spectator snapshot of a single tournament table (admin-only). Hands are
// omitted — only public game state (counts, top card, turn, recent log).
app.get('/api/tournament/table', (req, res) => {
  const email = (req.query.email as string) || '';
  const roomId = (req.query.roomId as string) || '';
  if (!isAdminEmail(email)) return res.status(401).json({ error: 'Admin only.' });
  if (!tournamentTableIds.has(roomId) || !gameRooms[roomId]) return res.json({ exists: false });
  const room = gameRooms[roomId];
  const top = room.discardPile[room.discardPile.length - 1] || null;
  const winner = room.winnerPlayerId ? room.players.find(p => p.id === room.winnerPlayerId) : null;
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

  if (!pin || pin !== '1234') {
    return res.status(401).json({ error: 'Invalid Transaction Security PIN. Default secure PIN is 1234.' });
  }

  if (profile.balance < parseFloat(amount)) {
    return res.status(400).json({ error: 'Insufficient ledger balance.' });
  }

  const txId = generateHash();
  const txHash = 'tx_chain_' + Math.random().toString(36).substring(2, 10);

  profile.balance -= parseFloat(amount);

  const newTx: Transaction = {
    id: txId,
    type: 'withdrawal',
    amount: parseFloat(amount),
    status: 'completed',
    timestamp: new Date().toISOString(),
    method: method || 'Bank Transfer',
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
  // Everyone plays in the single admin-controlled arena room; the client's
  // roomId is ignored so all players share one consistent table.
  const userRoomId = adminConfig.defaultRoomId;

  // No tournament configured → no entry for players. Admins may always connect
  // so they can reach the dashboard and announce the next tournament.
  if (!isTournamentActive() && !isAdminEmail(userEmail)) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'No tournaments available right now. Please check back soon.',
    }));
    ws.close();
    return;
  }

  const connId = `${userEmail}_${Date.now()}`;
  activeConnections[connId] = { ws, email: userEmail, roomId: userRoomId };

  const profile = await ensureProfile(userEmail);
  const state = getOrCreateRoom(userRoomId);

  let playerObj = state.players.find(p => p.id === userEmail);
  if (!playerObj) {
    if (state.players.length >= Math.min(Math.max(adminConfig.maxPlayers, 2), 4)) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'This tournament table is full. Please try again shortly.'
      }));
      delete activeConnections[connId];
      ws.close();
      return;
    }

    const assignedColors: PlayerColor[] = state.players.map(p => p.color).filter(Boolean) as PlayerColor[];
    const allColors: PlayerColor[] = ['red', 'green', 'yellow', 'blue'];
    const availableColor = allColors.find(c => !assignedColors.includes(c)) || null;

    playerObj = {
      id: userEmail,
      name: userName,
      color: availableColor,
      isBot: false,
      balance: profile.balance,
      currentBet: 0,
      ready: false,
      cardsCount: 0,
      hand: [],
      isConnected: true,
      highestRollInRound: 0,
      totalRollsCount: 0,
    };
    state.players.push(playerObj);

    state.logs.push({
      id: 'log_join_' + Date.now(),
      message: `👤 ${userName} seated on the ${availableColor?.toUpperCase()} seat!`,
      type: 'info',
      timestamp: new Date().toISOString(),
    });
  } else {
    playerObj.isConnected = true;
    playerObj.name = userName;
    state.logs.push({
      id: 'log_reconnect_' + Date.now(),
      message: `⚡ ${userName} reconnected.`,
      type: 'info',
      timestamp: new Date().toISOString(),
    });
  }

  broadcastRoomState(userRoomId);

  ws.on('message', (messageStr: string) => {
    let msg: any;
    try {
      msg = JSON.parse(messageStr);
    } catch (e) {
      return;
    }

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

      case 'chat-message': {
        const chatMsg = msg.message;
        if (!chatMsg) return;

        const chatPayload = JSON.stringify({
          type: 'chat-received',
          message: {
            id: 'chat_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
            senderName: actionPlayer.name,
            senderColor: actionPlayer.color,
            message: chatMsg.substring(0, 150),
            timestamp: new Date().toISOString(),
          }
        });

        Object.keys(activeConnections).forEach(connId => {
          const conn = activeConnections[connId];
          if (conn.roomId === userRoomId && conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.send(chatPayload);
          }
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    delete activeConnections[connId];
    
    const currentRoom = gameRooms[userRoomId];
    if (currentRoom) {
      const p = currentRoom.players.find(p => p.id === userEmail);
      if (p) {
        p.isConnected = false;
        
        currentRoom.logs.push({
          id: 'log_leave_' + Date.now(),
          message: `⚠️ ${p.name} left the seat. They can re-seat by entering the same table ID.`,
          type: 'info',
          timestamp: new Date().toISOString(),
        });

        const anyHumans = currentRoom.players.some(p => !p.isBot && p.isConnected);
        if (!anyHumans) {
          currentRoom.logs.push({
            id: 'log_empty_' + Date.now(),
            message: `Table "${userRoomId}" is now empty. Room state resetting.`,
            type: 'system',
            timestamp: new Date().toISOString(),
          });
          delete gameRooms[userRoomId];
        } else {
          broadcastRoomState(userRoomId);
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
