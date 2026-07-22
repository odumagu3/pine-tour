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
}

export interface GameState {
  roomId: string;
  status: 'waiting' | 'betting' | 'playing' | 'finished';
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

export interface PublicConfig {
  arenaName: string;
  defaultRoomId: string;
  prizeMode: 'fixed' | 'random';
  fixedSponsorName: string;
  fixedPrize: number;
  sponsorPool: string[];
  prizeMin: number;
  prizeMax: number;
  ticketPackPrice: number;
  ticketPackSize: number;
  freeGameEnabled: boolean;
  turnTimerSeconds: number;
  maxPlayers: number;
  autoBotFill: boolean;
  isAdmin?: boolean;
  adminEmails?: string[]; // only present in admin-authenticated responses
  adminPasscode?: string; // never returned by the server; used client-side only when editing
}

export interface ChatMessage {
  id: string;
  senderName: string;
  senderColor?: PlayerColor;
  message: string;
  timestamp: string;
  isSystem?: boolean;
}
