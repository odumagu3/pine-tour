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
  referralRewardCap: number;   // most free tickets one player can earn by referring (0 = off)
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
    // Pre-0003 rows have no column at all — fall back rather than yielding NaN.
    referralRewardCap: r.referral_reward_cap == null ? 10 : Number(r.referral_reward_cap),
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
    referral_reward_cap: c.referralRewardCap,
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
    hasWithdrawalPin: !!r.withdrawal_pin_hash, // boolean only — never the hash
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
    hasWithdrawalPin: false,
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
// NOTE: referral_code and withdrawal_pin_hash are deliberately absent. Both are
// written only by their own dedicated functions, and must never be overwritten
// (or blanked) by a routine profile save.
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
// Withdrawal requests
//
// Payouts are fulfilled by hand, so each withdrawal is a queued request an
// admin marks paid (or rejects, which refunds the player).
// -----------------------------------------------------------------------------

export interface WithdrawalRow {
  id: string;
  email: string;
  amount: number;
  bankName: string;
  accountNumber: string;
  accountName: string;
  status: 'pending' | 'paid' | 'rejected';
  note: string;
  transactionId: string | null;
  createdAt: string;
  processedAt: string | null;
}

function rowToWithdrawal(r: any): WithdrawalRow {
  return {
    id: r.id,
    email: r.email,
    amount: Number(r.amount),
    bankName: r.bank_name ?? '',
    accountNumber: r.account_number ?? '',
    accountName: r.account_name ?? '',
    status: r.status,
    note: r.note ?? '',
    transactionId: r.transaction_id ?? null,
    createdAt: r.created_at,
    processedAt: r.processed_at ?? null,
  };
}

export async function createWithdrawal(w: {
  email: string; amount: number; bankName: string; accountNumber: string;
  accountName: string; transactionId: string;
}): Promise<WithdrawalRow | null> {
  if (!persistenceEnabled) return null;
  const { data, error } = await supabase.from('withdrawals').insert({
    email: w.email.toLowerCase().trim(),
    amount: w.amount,
    bank_name: w.bankName,
    account_number: w.accountNumber,
    account_name: w.accountName,
    transaction_id: w.transactionId,
  }).select('*').maybeSingle();
  if (error) { console.error('createWithdrawal failed:', error.message); return null; }
  return data ? rowToWithdrawal(data) : null;
}

// Newest first. `status` filters the queue; omit it for everything.
export async function listWithdrawals(status?: string, limit = 100): Promise<WithdrawalRow[]> {
  if (!persistenceEnabled) return [];
  let q = supabase.from('withdrawals').select('*').order('created_at', { ascending: false }).limit(limit);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) { console.error('listWithdrawals failed:', error.message); return []; }
  return (data ?? []).map(rowToWithdrawal);
}

// Compare-and-swap on status, so two admins clicking at once can't both resolve
// the same request (and double-refund a rejection).
export async function resolveWithdrawal(
  id: string, status: 'paid' | 'rejected', note: string,
): Promise<WithdrawalRow | null> {
  if (!persistenceEnabled) return null;
  const { data, error } = await supabase
    .from('withdrawals')
    .update({ status, note, processed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select('*');
  if (error) { console.error('resolveWithdrawal failed:', error.message); return null; }
  return data && data.length ? rowToWithdrawal(data[0]) : null;
}

// Keep the ledger entry in step with the request it belongs to.
export async function updateTransactionStatus(id: string, status: string): Promise<void> {
  if (!persistenceEnabled) return;
  const { error } = await supabase.from('transactions').update({ status }).eq('id', id);
  if (error) console.error('updateTransactionStatus failed:', error.message);
}

// -----------------------------------------------------------------------------
// Admin roster
// -----------------------------------------------------------------------------

export interface PlayerSummary {
  email: string;
  balance: number;
  tickets: number;
  gamesPlayed: number;
  gamesWon: number;
  totalEarnings: number;
  verificationStatus: string;
  createdAt: string;
}

// Every player with their wallet and ticket position. Admin-only — the caller
// must have checked the admin passcode before calling this.
export async function listPlayers(limit = 500): Promise<{ count: number; players: PlayerSummary[] }> {
  if (!persistenceEnabled) return { count: 0, players: [] };

  const { count } = await supabase.from('profiles').select('email', { count: 'exact', head: true });
  const { data, error } = await supabase
    .from('profiles')
    .select('email, balance, tickets, games_played, games_won, total_earnings, verification_status, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) { console.error('listPlayers failed:', error.message); return { count: 0, players: [] }; }

  return {
    count: count ?? (data?.length ?? 0),
    players: (data ?? []).map(r => ({
      email: r.email,
      balance: Number(r.balance),
      tickets: Number(r.tickets),
      gamesPlayed: Number(r.games_played),
      gamesWon: Number(r.games_won),
      totalEarnings: Number(r.total_earnings),
      verificationStatus: r.verification_status,
      createdAt: r.created_at,
    })),
  };
}

// -----------------------------------------------------------------------------
// Withdrawal PIN
//
// Read and written only here. The hash never leaves the server — rowToProfile
// exposes it to clients as the boolean `hasWithdrawalPin` and nothing else.
// -----------------------------------------------------------------------------

export async function getWithdrawalPinHash(email: string): Promise<string | null> {
  if (!persistenceEnabled) return null;
  const { data, error } = await supabase
    .from('profiles').select('withdrawal_pin_hash')
    .eq('email', email.toLowerCase().trim()).maybeSingle();
  if (error) { console.error('getWithdrawalPinHash failed:', error.message); return null; }
  return data?.withdrawal_pin_hash ?? null;
}

export async function setWithdrawalPinHash(email: string, hash: string): Promise<boolean> {
  if (!persistenceEnabled) return false;
  const { error } = await supabase
    .from('profiles').update({ withdrawal_pin_hash: hash })
    .eq('email', email.toLowerCase().trim());
  if (error) { console.error('setWithdrawalPinHash failed:', error.message); return false; }
  return true;
}

// -----------------------------------------------------------------------------
// Payments (real Paystack deposits)
//
// One row per initialized transaction, keyed by the reference we generated.
// A deposit can be reported twice — the client calls /verify AND Paystack's
// webhook fires (and retries) — so crediting is a compare-and-swap on status:
// only the caller that flips 'pending' → 'credited' actually moves the money.
// -----------------------------------------------------------------------------

export interface PaymentRow {
  reference: string;
  email: string;
  amount: number;       // naira we asked Paystack to charge
  status: 'pending' | 'credited' | 'failed';
  channel: string | null;
  paidAmount: number | null;
  createdAt: string;
}

function rowToPayment(r: any): PaymentRow {
  return {
    reference: r.reference,
    email: r.email,
    amount: Number(r.amount),
    status: r.status,
    channel: r.channel ?? null,
    paidAmount: r.paid_amount == null ? null : Number(r.paid_amount),
    createdAt: r.created_at,
  };
}

// Record an initialized transaction before the player is sent to Paystack.
export async function createPayment(
  reference: string, email: string, amount: number,
): Promise<boolean> {
  if (!persistenceEnabled) return false;
  const { error } = await supabase.from('payments').insert({
    reference,
    email: email.toLowerCase().trim(),
    amount,
  });
  if (error) { console.error('createPayment failed:', error.message); return false; }
  return true;
}

export async function getPayment(reference: string): Promise<PaymentRow | null> {
  if (!persistenceEnabled) return null;
  const { data, error } = await supabase
    .from('payments').select('*').eq('reference', reference).maybeSingle();
  if (error) { console.error('getPayment failed:', error.message); return null; }
  return data ? rowToPayment(data) : null;
}

// Mark a payment credited. Returns true ONLY for the caller that won the race,
// so the wallet is credited once even when /verify and a retrying webhook both
// report the same payment.
//
// The guard is `status <> 'credited'`, NOT `status = 'pending'`. That matters:
// a player can abandon checkout (which we may have recorded as failed) and then
// complete the payment by bank transfer minutes later. Paystack saying
// charge.success is authoritative — our earlier guess must never be able to
// block a real payment from reaching the player's wallet. It is still a correct
// compare-and-swap: Postgres re-evaluates the predicate after the row lock, so
// a second concurrent caller finds status='credited' and matches nothing.
export async function creditPayment(
  reference: string, paidAmount: number, channel: string,
): Promise<boolean> {
  if (!persistenceEnabled) return false;
  const { data, error } = await supabase
    .from('payments')
    .update({
      status: 'credited',
      paid_amount: paidAmount,
      channel,
      credited_at: new Date().toISOString(),
    })
    .eq('reference', reference)
    .neq('status', 'credited')
    .select('reference');
  if (error) { console.error('creditPayment failed:', error.message); return false; }
  return (data?.length ?? 0) > 0;
}

// Mark a payment failed. Only for cases where a charge can never exist — e.g.
// Paystack rejected the initialize call outright.
//
// Deliberately NOT called when a verify returns 'abandoned' or 'failed': those
// are not terminal. The player may still complete the same reference by bank
// transfer or USSD, and creditPayment() is written so a later charge.success
// credits them regardless. Never let a local guess strand a real payment.
export async function markPaymentFailed(reference: string): Promise<void> {
  if (!persistenceEnabled) return;
  const { error } = await supabase
    .from('payments').update({ status: 'failed' })
    .eq('reference', reference).eq('status', 'pending');
  if (error) console.error('markPaymentFailed failed:', error.message);
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
  status: 'pending' | 'rewarded';
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
