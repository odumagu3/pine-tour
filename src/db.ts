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
    referralCode: r.referral_code ?? '',
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
    referralCode: '',
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
// NOTE: referral_code is deliberately absent — it is minted once by
// ensureReferralCode() and must never be overwritten by a routine profile save.
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

// -----------------------------------------------------------------------------
// Referrals
//
// A player shares …/?ref=CODE. Whoever signs up through it gets a row in
// `referrals` with status 'pending'; when that invitee buys tickets the row is
// flipped to 'rewarded' and the referrer is credited a free ticket. The unique
// constraint on referred_email means one invitee can only ever be attributed
// once, and the compare-and-swap in claimReferralReward() means the payout can
// only ever fire once — even if two ticket purchases land at the same instant.
// -----------------------------------------------------------------------------

export interface ReferralRow {
  id: string;
  referrerEmail: string;
  referredEmail: string;
  code: string;
  status: 'pending' | 'rewarded' | 'capped';
  rewardedAt: string | null;
  createdAt: string;
}

function rowToReferral(r: any): ReferralRow {
  return {
    id: r.id,
    referrerEmail: r.referrer_email,
    referredEmail: r.referred_email,
    code: r.code,
    status: r.status,
    rewardedAt: r.rewarded_at ?? null,
    createdAt: r.created_at,
  };
}

// Codes are typed and read aloud, so the alphabet drops the characters people
// confuse: I/1 and O/0.
const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERRAL_CODE_LENGTH = 6;

function mintReferralCode(): string {
  let out = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    out += REFERRAL_ALPHABET[Math.floor(Math.random() * REFERRAL_ALPHABET.length)];
  }
  return out;
}

// Accept whatever the user pasted (lowercase, stray spaces, a trailing slash)
// and reduce it to the canonical form stored in the database.
export function normalizeReferralCode(code: string): string {
  return (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, REFERRAL_CODE_LENGTH);
}

// Return this profile's referral code, minting one on first use. Existing rows
// predate the column, so this backfills them lazily rather than in a migration.
export async function ensureReferralCode(email: string): Promise<string> {
  if (!persistenceEnabled) return '';
  const cleanEmail = email.toLowerCase().trim();

  const { data: existing, error: readErr } = await supabase
    .from('profiles').select('referral_code').eq('email', cleanEmail).maybeSingle();
  if (readErr) { console.error('ensureReferralCode read failed:', readErr.message); return ''; }
  if (existing?.referral_code) return existing.referral_code;

  // Retry on the (very unlikely) collision with an already-issued code.
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = mintReferralCode();
    const { data: updated, error } = await supabase
      .from('profiles')
      .update({ referral_code: code })
      .eq('email', cleanEmail)
      .is('referral_code', null) // never clobber a code this profile already has
      .select('referral_code')
      .maybeSingle();

    if (!error && updated?.referral_code) return updated.referral_code;
    if (error && error.code !== '23505') {
      console.error('ensureReferralCode write failed:', error.message);
      return '';
    }
    // Either the code collided, or a concurrent request already assigned one.
    // Re-read: if a code is now present we are done, otherwise loop and retry.
    const { data: again } = await supabase
      .from('profiles').select('referral_code').eq('email', cleanEmail).maybeSingle();
    if (again?.referral_code) return again.referral_code;
  }

  console.error('ensureReferralCode: exhausted attempts for', cleanEmail);
  return '';
}

// Resolve a shared code back to the player who owns it.
export async function findEmailByReferralCode(code: string): Promise<string | null> {
  if (!persistenceEnabled) return null;
  const clean = normalizeReferralCode(code);
  if (clean.length !== REFERRAL_CODE_LENGTH) return null;
  const { data, error } = await supabase
    .from('profiles').select('email').eq('referral_code', clean).maybeSingle();
  if (error) { console.error('findEmailByReferralCode failed:', error.message); return null; }
  return data?.email ?? null;
}

// Attribute an invitee to a referrer. Returns null when the invitee was already
// attributed to someone (unique violation) or the row was rejected — attribution
// is first-link-wins and never reassigned.
export async function createReferral(
  referrerEmail: string, referredEmail: string, code: string,
): Promise<ReferralRow | null> {
  if (!persistenceEnabled) return null;
  const { data, error } = await supabase.from('referrals').insert({
    referrer_email: referrerEmail.toLowerCase().trim(),
    referred_email: referredEmail.toLowerCase().trim(),
    code: normalizeReferralCode(code),
  }).select('*').maybeSingle();

  if (error) {
    // 23505 = this invitee already has a referrer; 23514 = self-referral check.
    if (error.code !== '23505' && error.code !== '23514') {
      console.error('createReferral failed:', error.message);
    }
    return null;
  }
  return data ? rowToReferral(data) : null;
}

// The unpaid referral for this invitee, if they were referred and have not yet
// triggered the payout.
export async function getPendingReferralFor(referredEmail: string): Promise<ReferralRow | null> {
  if (!persistenceEnabled) return null;
  const { data, error } = await supabase
    .from('referrals').select('*')
    .eq('referred_email', referredEmail.toLowerCase().trim())
    .eq('status', 'pending')
    .maybeSingle();
  if (error) { console.error('getPendingReferralFor failed:', error.message); return null; }
  return data ? rowToReferral(data) : null;
}

// Flip pending → rewarded. The `.eq('status', 'pending')` guard makes this a
// compare-and-swap: exactly one caller can win, so the free ticket is credited
// exactly once. Returns true only for the caller that won.
export async function claimReferralReward(id: string): Promise<boolean> {
  if (!persistenceEnabled) return false;
  const { data, error } = await supabase
    .from('referrals')
    .update({ status: 'rewarded', rewarded_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id');
  if (error) { console.error('claimReferralReward failed:', error.message); return false; }
  return (data?.length ?? 0) > 0;
}

// Mark a qualifying referral that arrived after the referrer hit their cap, so
// it is not re-examined on every future purchase.
export async function markReferralCapped(id: string): Promise<void> {
  if (!persistenceEnabled) return;
  const { error } = await supabase
    .from('referrals').update({ status: 'capped' }).eq('id', id).eq('status', 'pending');
  if (error) console.error('markReferralCapped failed:', error.message);
}

// Counts behind the "Refer & Earn" panel and the reward cap.
export async function referralStats(referrerEmail: string): Promise<{ invited: number; rewarded: number }> {
  if (!persistenceEnabled) return { invited: 0, rewarded: 0 };
  const clean = referrerEmail.toLowerCase().trim();

  const [invited, rewarded] = await Promise.all([
    supabase.from('referrals').select('id', { count: 'exact', head: true })
      .eq('referrer_email', clean),
    supabase.from('referrals').select('id', { count: 'exact', head: true })
      .eq('referrer_email', clean).eq('status', 'rewarded'),
  ]);

  if (invited.error) console.error('referralStats(invited) failed:', invited.error.message);
  if (rewarded.error) console.error('referralStats(rewarded) failed:', rewarded.error.message);

  return { invited: invited.count ?? 0, rewarded: rewarded.count ?? 0 };
}
