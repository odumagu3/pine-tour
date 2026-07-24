// Server-side Supabase access layer for Pine Tour.
// Uses the service_role key (bypasses RLS) — this module must only ever run on
// the backend (Render), never in the browser.
import { createClient } from '@supabase/supabase-js';
import { UserProfile, Transaction } from './types.js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  // Fail loud at boot rather than silently running against no database.
  console.warn('⚠️  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — persistence is disabled.');
}

export const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const persistenceEnabled = !!(SUPABASE_URL && SERVICE_ROLE_KEY);

const HISTORY_LIMIT = 50;

// -----------------------------------------------------------------------------
// Admin config (single pinned row, id = 1)
// -----------------------------------------------------------------------------
export interface AdminConfig {
  arenaName: string;
  defaultRoomId: string;
  prizeMode: 'fixed' | 'random';
  fixedSponsorName: string;
  fixedPrize: number;
  botRoster: string[]; // stored in the legacy sponsor_pool column
  prizeMin: number;
  prizeMax: number;
  ticketPackPrice: number;
  tournamentFieldSize: number; // stored in the legacy ticket_pack_size column
  freeGameEnabled: boolean;
  turnTimerSeconds: number;
  maxPlayers: number;
  autoBotFill: boolean;
  adminEmails: string[];
  adminPasscode: string;
}

function rowToAdminConfig(r: any): AdminConfig {
  return {
    arenaName: r.arena_name,
    defaultRoomId: r.default_room_id,
    prizeMode: r.prize_mode === 'fixed' ? 'fixed' : 'random',
    fixedSponsorName: r.fixed_sponsor_name,
    fixedPrize: Number(r.fixed_prize),
    botRoster: r.sponsor_pool ?? [],
    prizeMin: Number(r.prize_min),
    prizeMax: Number(r.prize_max),
    ticketPackPrice: Number(r.ticket_pack_price),
    tournamentFieldSize: Number(r.ticket_pack_size) || 16,
    freeGameEnabled: !!r.free_game_enabled,
    turnTimerSeconds: Number(r.turn_timer_seconds),
    maxPlayers: Number(r.max_players),
    autoBotFill: !!r.auto_bot_fill,
    adminEmails: r.admin_emails ?? [],
    adminPasscode: r.admin_passcode,
  };
}

export async function loadAdminConfig(): Promise<AdminConfig | null> {
  if (!persistenceEnabled) return null;
  const { data, error } = await supabase.from('admin_config').select('*').eq('id', 1).single();
  if (error) { console.error('loadAdminConfig failed:', error.message); return null; }
  return rowToAdminConfig(data);
}

export async function saveAdminConfig(c: AdminConfig): Promise<void> {
  if (!persistenceEnabled) return;
  const { error } = await supabase.from('admin_config').update({
    arena_name: c.arenaName,
    default_room_id: c.defaultRoomId,
    prize_mode: c.prizeMode,
    fixed_sponsor_name: c.fixedSponsorName,
    fixed_prize: c.fixedPrize,
    sponsor_pool: c.botRoster,
    prize_min: c.prizeMin,
    prize_max: c.prizeMax,
    ticket_pack_price: c.ticketPackPrice,
    ticket_pack_size: c.tournamentFieldSize,
    free_game_enabled: c.freeGameEnabled,
    turn_timer_seconds: c.turnTimerSeconds,
    max_players: c.maxPlayers,
    auto_bot_fill: c.autoBotFill,
    admin_emails: c.adminEmails,
    admin_passcode: c.adminPasscode,
  }).eq('id', 1);
  if (error) console.error('saveAdminConfig failed:', error.message);
}

// -----------------------------------------------------------------------------
// Profiles + transactions
// -----------------------------------------------------------------------------
function rowToTransaction(r: any): Transaction {
  return {
    id: r.id,
    type: r.type,
    amount: Number(r.amount),
    status: r.status,
    timestamp: r.created_at,
    method: r.method,
    txHash: r.tx_hash,
    balanceAfter: r.balance_after == null ? 0 : Number(r.balance_after),
  };
}

function rowToProfile(r: any, history: Transaction[]): UserProfile {
  return {
    email: r.email,
    balance: Number(r.balance),
    totalEarnings: Number(r.total_earnings),
    gamesPlayed: Number(r.games_played),
    gamesWon: Number(r.games_won),
    highestRoll: Number(r.highest_roll),
    tickets: Number(r.tickets),
    freeGameUsed: !!r.free_game_used,
    verificationStatus: r.verification_status,
    verificationDetails: r.verification_details ?? null,
    history,
  };
}

function defaultProfile(email: string): UserProfile {
  return {
    email,
    balance: 0,
    totalEarnings: 0,
    gamesPlayed: 0,
    gamesWon: 0,
    highestRoll: 0,
    tickets: 0,
    freeGameUsed: false,
    verificationStatus: 'unverified',
    verificationDetails: null,
    history: [],
  };
}

// Load a profile from Supabase, creating the row if it does not exist yet.
export async function loadProfile(email: string): Promise<UserProfile> {
  const cleanEmail = email.toLowerCase().trim();
  if (!persistenceEnabled) return defaultProfile(cleanEmail);

  const { data: row, error } = await supabase
    .from('profiles').select('*').eq('email', cleanEmail).maybeSingle();
  if (error) { console.error('loadProfile failed:', error.message); return defaultProfile(cleanEmail); }

  if (!row) {
    const fresh = defaultProfile(cleanEmail);
    const { error: insErr } = await supabase.from('profiles').insert({ email: cleanEmail });
    if (insErr && insErr.code !== '23505') console.error('create profile failed:', insErr.message);
    return fresh;
  }

  const { data: txRows } = await supabase
    .from('transactions').select('*')
    .eq('email', cleanEmail)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);

  return rowToProfile(row, (txRows ?? []).map(rowToTransaction));
}

// Write-through: persist the mutable profile fields (history lives in its own table).
export async function persistProfile(p: UserProfile): Promise<void> {
  if (!persistenceEnabled) return;
  const { error } = await supabase.from('profiles').upsert({
    email: p.email.toLowerCase().trim(),
    balance: p.balance,
    total_earnings: p.totalEarnings,
    games_played: p.gamesPlayed,
    games_won: p.gamesWon,
    highest_roll: p.highestRoll,
    tickets: p.tickets,
    free_game_used: p.freeGameUsed,
    verification_status: p.verificationStatus,
    verification_details: p.verificationDetails,
  }, { onConflict: 'email' });
  if (error) console.error('persistProfile failed:', error.message);
}

// Insert one ledger entry.
export async function recordTransaction(email: string, tx: Transaction): Promise<void> {
  if (!persistenceEnabled) return;
  const { error } = await supabase.from('transactions').insert({
    id: tx.id,
    email: email.toLowerCase().trim(),
    type: tx.type,
    amount: tx.amount,
    status: tx.status,
    method: tx.method,
    tx_hash: tx.txHash,
    balance_after: tx.balanceAfter,
    created_at: tx.timestamp,
  });
  if (error) console.error('recordTransaction failed:', error.message);
}

// Purge a user (GDPR delete). Transactions cascade via FK.
export async function deleteProfile(email: string): Promise<void> {
  if (!persistenceEnabled) return;
  const { error } = await supabase.from('profiles').delete().eq('email', email.toLowerCase().trim());
  if (error) console.error('deleteProfile failed:', error.message);
}
