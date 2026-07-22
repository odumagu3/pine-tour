import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { GameState, Player, PlayerColor, WhotCard, CardSuit, GameLog, Transaction, UserProfile, AntiCheatAlert } from './src/types.js';

const PORT = Number(process.env.PORT) || 5174;
const app = express();
app.use(express.json());

// Create HTTP server
const server = http.createServer(app);

// In-Memory Database for User Profiles and Game Rooms
const userProfiles: Record<string, UserProfile> = {};
const gameRooms: Record<string, GameState> = {};
const activeConnections: Record<string, { ws: WebSocket; email: string; roomId: string }> = {};

// Helper to generate secure-looking hashes
function generateHash(): string {
  return 'tx_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Helper to initialize a profile
function getOrCreateProfile(email: string): UserProfile {
  const cleanEmail = email.toLowerCase().trim();
  if (!userProfiles[cleanEmail]) {
    userProfiles[cleanEmail] = {
      email: cleanEmail,
      balance: 0, // New players start at ₦0
      totalEarnings: 0,
      gamesPlayed: 0,
      gamesWon: 0,
      highestRoll: 0,
      tickets: 0, // No tickets yet — first tournament entry is free
      freeGameUsed: false, // Lifetime free game not yet claimed
      verificationStatus: 'unverified',
      verificationDetails: null,
      history: [],
    };
  }
  return userProfiles[cleanEmail];
}

// -----------------------------------------------------------------------------
// ADMIN CONFIGURATION (authoritative, in-memory)
// Controls arena, sponsor/prize, ticket economy and gameplay rules.
// -----------------------------------------------------------------------------
interface AdminConfig {
  // Arena / room
  arenaName: string;
  defaultRoomId: string;
  // Sponsor & prize
  prizeMode: 'fixed' | 'random';
  fixedSponsorName: string;
  fixedPrize: number;
  sponsorPool: string[];
  prizeMin: number;
  prizeMax: number;
  // Ticket economy
  ticketPackPrice: number;
  ticketPackSize: number;
  freeGameEnabled: boolean;
  // Gameplay
  turnTimerSeconds: number;
  maxPlayers: number;
  autoBotFill: boolean;
  // Access control
  adminEmails: string[];
  adminPasscode: string;
}

const adminConfig: AdminConfig = {
  arenaName: 'Neon Whot! Bet',
  defaultRoomId: 'VaporSuite',
  prizeMode: 'random',
  fixedSponsorName: 'IgniTech',
  fixedPrize: 100000,
  sponsorPool: [
    'MTN Naija', 'Glo Mobile', 'Airtel Africa', 'Dangote Group',
    'GTBank', 'Jumia', 'Paystack', 'Bet9ja', 'Flutterwave', 'Indomie',
  ],
  prizeMin: 25000,
  prizeMax: 200000,
  ticketPackPrice: 3800,
  ticketPackSize: 8,
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

// Public-safe view of the config (never leaks the passcode; adminEmails only for admins).
function publicConfig(email?: string) {
  const admin = email ? isAdminEmail(email) : false;
  const { adminPasscode, adminEmails, ...rest } = adminConfig;
  return {
    ...rest,
    isAdmin: admin,
    ...(admin ? { adminEmails } : {}),
  };
}

// Generate a sponsored tournament honoring the admin's prize mode + values.
function generateSponsoredTournament(): { sponsorName: string; prize: number } {
  if (adminConfig.prizeMode === 'fixed') {
    return { sponsorName: adminConfig.fixedSponsorName, prize: adminConfig.fixedPrize };
  }
  const pool = adminConfig.sponsorPool.length ? adminConfig.sponsorPool : ['Sponsor'];
  const sponsorName = pool[Math.floor(Math.random() * pool.length)];
  const min = Math.min(adminConfig.prizeMin, adminConfig.prizeMax);
  const max = Math.max(adminConfig.prizeMin, adminConfig.prizeMax);
  const raw = min + Math.random() * (max - min);
  const prize = Math.round(raw / 5000) * 5000;
  return { sponsorName, prize };
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
    const sponsored = generateSponsoredTournament();
    gameRooms[roomId] = {
      roomId,
      status: 'waiting',
      players: [],
      pot: sponsored.prize,
      activePlayerIndex: 0,
      logs: [
        {
          id: 'log_' + Date.now(),
          message: `🎟️ ${sponsored.sponsorName} Tournament open at table "${roomId}" — ₦${sponsored.prize.toLocaleString('en-NG')} cash prize. Enter to play!`,
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

// Fill remaining empty seats (up to the configured max) with AI bots.
function fillSeatsWithBots(room: GameState) {
  if (!adminConfig.autoBotFill) return;
  const colors: PlayerColor[] = ['red', 'green', 'yellow', 'blue'];
  const botNames = ['CardMatrix', 'WhotEngine', 'VaporDealer', 'DeckShuffler'];
  const cap = Math.min(Math.max(adminConfig.maxPlayers, 2), 4);
  while (room.players.length < cap) {
    const assigned = room.players.map(p => p.color).filter(Boolean) as PlayerColor[];
    const color = colors.find(c => !assigned.includes(c));
    if (!color) break;
    const name = botNames[room.players.length] || `Bot_${room.players.length}`;
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
      id: 'log_bot_join_' + Date.now() + '_' + Math.random().toString(36).substring(2, 5),
      message: `🤖 ${name} seated to fill the tournament table.`,
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
  // Fresh sponsor + prize for the new tournament.
  const sponsored = generateSponsoredTournament();
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
    message: `🔄 New ${sponsored.sponsorName} Tournament open — ₦${sponsored.prize.toLocaleString('en-NG')} cash prize. Enter to play!`,
    type: 'system',
    timestamp: new Date().toISOString(),
  });
}

// Broadcast game state to all clients in a room
function broadcastRoomState(roomId: string) {
  const state = gameRooms[roomId];
  if (!state) return;

  const payload = JSON.stringify({ type: 'state-sync', state });
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
  const prizeAmount = room.sponsorPrize;
  const sponsor = room.sponsorName || 'Tournament Sponsor';

  room.logs.push({
    id: 'log_end_' + Date.now(),
    message: `🏆 Tournament Finished! ${winner ? winner.name : 'Unknown'} played all cards and won!`,
    type: 'win',
    timestamp: new Date().toISOString(),
  });

  room.logs.push({
    id: 'log_pot_' + Date.now(),
    message: `💰 ${winner ? winner.name : 'Unknown'} wins the ₦${prizeAmount.toLocaleString('en-NG')} cash prize sponsored by ${sponsor}!`,
    type: 'win',
    timestamp: new Date().toISOString(),
  });

  // Credit winner profile with the sponsor's cash prize
  if (winner && !winner.isBot) {
    const profile = getOrCreateProfile(winner.id);
    profile.balance += prizeAmount;
    profile.totalEarnings += prizeAmount;
    profile.gamesWon += 1;
    profile.history.unshift({
      id: generateHash(),
      type: 'win',
      amount: prizeAmount,
      status: 'completed',
      timestamp: new Date().toISOString(),
      method: `${sponsor} Tournament Prize`,
      txHash: 'hash_win_' + Math.random().toString(36).substring(2, 9),
      balanceAfter: profile.balance,
    });
  }

  // Update stats for all players
  room.players.forEach(p => {
    if (!p.isBot) {
      const profile = getOrCreateProfile(p.id);
      profile.gamesPlayed += 1;
    }
  });

  broadcastRoomState(roomId);
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
app.get('/api/profile', (req, res) => {
  const email = (req.query.email as string) || 'hudozit@gmail.com';
  const profile = getOrCreateProfile(email);
  res.json(profile);
});

// 2. POST Simulated Payment Deposit
app.post('/api/profile/deposit', (req, res) => {
  const { email, amount, method } = req.body;
  
  if (!email || !amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid deposit details' });
  }

  const profile = getOrCreateProfile(email);
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
  profile.history.unshift(newTx);

  res.json({ success: true, transaction: newTx, balance: profile.balance });
});

// 2b. POST Buy a tournament ticket pack (8 tickets for ₦3,800, debited from wallet)
app.post('/api/profile/buy-tickets', (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Missing account email.' });
  }

  const profile = getOrCreateProfile(email);
  const packPrice = adminConfig.ticketPackPrice;
  const packSize = adminConfig.ticketPackSize;

  if (profile.balance < packPrice) {
    return res.status(400).json({
      error: `Insufficient balance. A ticket pack costs ₦${packPrice.toLocaleString('en-NG')}. Add funds first.`,
    });
  }

  profile.balance -= packPrice;
  profile.tickets += packSize;

  const newTx: Transaction = {
    id: generateHash(),
    type: 'ticket',
    amount: packPrice,
    status: 'completed',
    timestamp: new Date().toISOString(),
    method: `Tournament Ticket Pack ×${packSize}`,
    txHash: 'tx_pack_' + Math.random().toString(36).substring(2, 10),
    balanceAfter: profile.balance,
  };
  profile.history.unshift(newTx);

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
app.post('/api/admin/config', (req, res) => {
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

  // Arena
  adminConfig.arenaName = str(config.arenaName, adminConfig.arenaName);
  adminConfig.defaultRoomId = str(config.defaultRoomId, adminConfig.defaultRoomId);
  // Sponsor & prize
  if (config.prizeMode === 'fixed' || config.prizeMode === 'random') adminConfig.prizeMode = config.prizeMode;
  adminConfig.fixedSponsorName = str(config.fixedSponsorName, adminConfig.fixedSponsorName);
  adminConfig.fixedPrize = num(config.fixedPrize, adminConfig.fixedPrize, 0, 100000000);
  if (Array.isArray(config.sponsorPool)) {
    const cleaned = config.sponsorPool.map((s: any) => String(s).trim()).filter(Boolean);
    if (cleaned.length) adminConfig.sponsorPool = cleaned;
  }
  adminConfig.prizeMin = num(config.prizeMin, adminConfig.prizeMin, 0, 100000000);
  adminConfig.prizeMax = num(config.prizeMax, adminConfig.prizeMax, 0, 100000000);
  // Ticket economy
  adminConfig.ticketPackPrice = num(config.ticketPackPrice, adminConfig.ticketPackPrice, 0, 100000000);
  adminConfig.ticketPackSize = num(config.ticketPackSize, adminConfig.ticketPackSize, 1, 1000);
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

  // Apply new sponsor/prize live to any open (not-yet-started) tables.
  Object.keys(gameRooms).forEach(roomId => {
    const room = gameRooms[roomId];
    if (room && (room.status === 'waiting' || room.status === 'betting')) {
      const t = generateSponsoredTournament();
      room.sponsorName = t.sponsorName;
      room.sponsorPrize = t.prize;
      room.pot = t.prize;
      broadcastRoomState(roomId);
    }
  });

  const { adminPasscode, ...editable } = adminConfig;
  res.json({ success: true, config: editable });
});

// 3. POST Simulated Withdrawal Portal (For verified users)
app.post('/api/profile/withdraw', (req, res) => {
  const { email, amount, method, pin } = req.body;

  if (!email || !amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid withdrawal details' });
  }

  const profile = getOrCreateProfile(email);

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

  profile.history.unshift(newTx);

  res.json({ success: true, transaction: newTx, balance: profile.balance });
});

// 4. POST Simulated ID Verification submission (KYC)
app.post('/api/profile/verify', (req, res) => {
  const { email, fullName, idType, idNumber } = req.body;

  if (!email || !fullName || !idType || !idNumber) {
    return res.status(400).json({ error: 'All verification fields are required' });
  }

  const profile = getOrCreateProfile(email);
  profile.verificationStatus = 'verified';
  profile.verificationDetails = {
    fullName,
    idType,
    idNumber: idNumber.replace(/.(?=.{4})/g, '*'),
    submittedAt: new Date().toISOString(),
  };

  res.json({ success: true, status: 'verified', details: profile.verificationDetails });
});

// 5. POST Export User Profile (GDPR compliance)
app.post('/api/profile/export', (req, res) => {
  const { email } = req.body;
  const profile = getOrCreateProfile(email);
  res.json({ success: true, profileData: profile });
});

// 6. POST Delete/Purge User Profile (GDPR compliance Right to be Forgotten)
app.post('/api/profile/delete', (req, res) => {
  const { email } = req.body;
  const cleanEmail = (email || '').toLowerCase().trim();
  if (userProfiles[cleanEmail]) {
    delete userProfiles[cleanEmail];
  }
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

wss.on('connection', (ws: WebSocket, req) => {
  const urlParams = new URLSearchParams(req.url?.split('?')[1] || '');
  const userEmail = (urlParams.get('email') || 'hudozit@gmail.com').toLowerCase().trim();
  const userName = urlParams.get('name') || 'VoltGamer';
  const userRoomId = urlParams.get('roomId') || 'VaporSuite';

  const connId = `${userEmail}_${Date.now()}`;
  activeConnections[connId] = { ws, email: userEmail, roomId: userRoomId };

  const profile = getOrCreateProfile(userEmail);
  const state = getOrCreateRoom(userRoomId);

  let playerObj = state.players.find(p => p.id === userEmail);
  if (!playerObj) {
    if (state.players.length >= Math.min(Math.max(adminConfig.maxPlayers, 2), 4)) {
      ws.send(JSON.stringify({
        type: 'error', 
        message: 'Table is full. Max 4 players allowed. Try joining another custom Table Room Name!' 
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

    const freshProfile = getOrCreateProfile(userEmail);
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

        // Safety: ensure a sponsor/prize is locked in for this tournament.
        if (!currentRoom.sponsorName) {
          const t = generateSponsoredTournament();
          currentRoom.sponsorName = t.sponsorName;
          currentRoom.sponsorPrize = t.prize;
          currentRoom.pot = t.prize;
        }

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
            message: 'No tickets left. Buy a ticket pack (8 for ₦3,800) in the Cashier to enter tournaments.',
          }));
          return;
        }

        actionPlayer.currentBet = 0;
        actionPlayer.balance = freshProfile.balance;
        actionPlayer.ready = true;
        currentRoom.status = 'betting';

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
}, 1000);


// -----------------------------------------------------------------------------
// VITE DEV SERVER MIDDLEWARE & STATIC SERVING FOR PRODUCTION
// -----------------------------------------------------------------------------
async function startServer() {
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
