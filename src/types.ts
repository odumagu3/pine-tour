export type PlayerColor = 'red' | 'green' | 'yellow' | 'blue';

export type CardSuit = 'circle' | 'triangle' | 'cross' | 'square' | 'star' | 'whot';

export interface WhotCard {
  id: string; // unique identifier
  suit: CardSuit;
  value: number; // numbers like 1,2,3,4,5,7,8,10,11,12,13,14, or 20 (whot)
}

export interface Player {
  id: string;
  name: string;
  color: PlayerColor | null; // Table seating color accent
  isBot: boolean;
  balance: number;
  currentBet: number;
  ready: boolean;
  cardsCount: number;
  hand: WhotCard[];
  isConnected: boolean;
  highestRollInRound: number; // kept for dashboard statistics and ledger calculation compatibility
  totalRollsCount: number; // kept for statistics (e.g. card plays)
  predestined?: boolean; // marked (openly) as the predetermined winner — test feature
}

export interface GameState {
  roomId: string;
  status: 'waiting' | 'betting' | 'playing' | 'finished';
  // Which segment this table belongs to. 'tournament' = normal Whot (empty your
  // hand to win). 'all-hands' = All Hands on Deck survival mode (no checkout win;
  // when the market runs dry the highest hand total is eliminated, last standing
  // wins). Absent/undefined is treated as 'tournament' for backward compatibility.
  mode?: 'tournament' | 'all-hands';
  players: Player[];
  pot: number;
  activePlayerIndex: number;
  logs: GameLog[];
  turnTimeLeft: number; // seconds
  winnerPlayerId: string | null;
  potWinnerId: string | null;
  antiCheatLog: AntiCheatAlert[];

  // Tournament sponsorship
  sponsorName: string | null; // Brand sponsoring this tournament's prize
  sponsorPrize: number; // Cash prize (₦) put up by the sponsor, awarded to the winner

  // Whot! specific state
  drawPileCount: number;
  discardPile: WhotCard[];
  requestedSuit: CardSuit | null; // Set when 20 (Whot) is played
  turnDirection: number; // 1 or -1

  // All Hands on Deck: players knocked out this game, in elimination order, with
  // the card count they held when they went out. Shown in a corner of the arena
  // so everyone can see who's out (and who's still playing). Absent in other modes.
  eliminated?: { name: string; color: PlayerColor | null; cardsCount: number }[];
}

export interface GameLog {
  id: string;
  message: string;
  type: 'info' | 'roll' | 'move' | 'bet' | 'cheat' | 'win' | 'system';
  timestamp: string;
  signature?: string;
}

export interface AntiCheatAlert {
  id: string;
  timestamp: string;
  playerId: string;
  playerName: string;
  type: string;
  severity: 'low' | 'medium' | 'high';
  details: string;
}

export interface Transaction {
  id: string;
  type: 'deposit' | 'withdrawal' | 'bet' | 'win' | 'refund' | 'ticket';
  amount: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  timestamp: string;
  method: string;
  txHash: string;
  balanceAfter: number;
}

export interface UserProfile {
  email: string;
  balance: number; // ₦ wallet balance (starts at 0)
  totalEarnings: number;
  gamesPlayed: number;
  gamesWon: number;
  highestRoll: number; // Repurposed for statistical achievements
  tickets: number; // Tournament tickets available (each = 1 entry)
  freeGameUsed: boolean; // Whether the lifetime free tournament entry has been consumed
  verificationStatus: 'unverified' | 'pending' | 'verified';
  verificationDetails: {
    fullName: string;
    idNumber: string;
    idType: string;
    submittedAt?: string;
  } | null;
  history: Transaction[];
}

// Public app config the frontend consumes (served by /api/config).
export interface PublicConfig {
  arenaName: string;
  roomName: string;           // the single arena room name (admin-controlled)
  tournamentActive: boolean;  // false → show "no tournaments available"
  sponsorName: string;        // current tournament sponsor ('' when inactive)
  sponsorPrize: number;       // current cash prize (0 when inactive)
  ticketPrice: number;        // price per ticket (₦)
  minTickets: number;         // fewest tickets buyable at once
  maxTickets: number;         // most tickets buyable at once
  freeGameEnabled: boolean;
  turnTimerSeconds: number;
  maxPlayers: number;
  autoBotFill: boolean;
  isAdmin?: boolean;
  adminEmails?: string[]; // only present in admin-authenticated responses
}

export interface ChatMessage {
  id: string;
  senderName: string;
  senderColor?: PlayerColor;
  message: string;
  timestamp: string;
  isSystem?: boolean;
}
