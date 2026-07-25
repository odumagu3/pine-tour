import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { UserProfile, Transaction, PublicConfig } from '../types.js';
import { CreditCard, Wallet, ArrowDownLeft, ArrowUpRight, ShieldCheck, HelpCircle, Lock, Loader2, CheckCircle2, AlertCircle, Copy, Check, Ticket, Gift, Landmark } from 'lucide-react';
import { formatNaira, TICKET_PRICE, MIN_TICKETS, MAX_TICKETS } from '../currency.js';
import { apiUrl } from '../config.js';
import ReferralPanel from './ReferralPanel.tsx';
import { openPaystackCheckout } from '../paystack.js';

// Nigerian banks for the Paystack payout (withdrawal) flow.
const NG_BANKS = ['Access Bank', 'GTBank', 'Zenith Bank', 'UBA', 'First Bank', 'Kuda', 'OPay', 'PalmPay', 'Fidelity Bank', 'Union Bank', 'Wema Bank', 'Sterling Bank'];

interface FinancePortalProps {
  profile: UserProfile;
  config: PublicConfig | null;
  onRefreshProfile: () => void;
}

export default function FinancePortal({ profile, config, onRefreshProfile }: FinancePortalProps) {
  // Ticket terms come from the admin config (fall back to defaults).
  const unitPrice = config?.ticketPrice ?? TICKET_PRICE;
  const minQty = config?.minTickets ?? MIN_TICKETS;
  const maxQty = config?.maxTickets ?? MAX_TICKETS;
  // Tabs: 'tickets' | 'referral' | 'deposit' | 'withdraw' | 'verification'
  const [activeTab, setActiveTab] = useState<'tickets' | 'referral' | 'deposit' | 'withdraw' | 'verification'>('tickets');

  // Ticket purchase states
  const [ticketQty, setTicketQty] = useState(minQty);
  const [ticketStatus, setTicketStatus] = useState<'idle' | 'processing' | 'completed' | 'failed'>('idle');
  const [ticketError, setTicketError] = useState('');
  const totalCost = unitPrice * ticketQty;

  // Deposit States — Paystack checkout (initialize → popup → verify).
  const [depositAmount, setDepositAmount] = useState('5000');
  const [depositStatus, setDepositStatus] = useState<'idle' | 'completed'>('idle');
  const [depositError, setDepositError] = useState('');
  const [initializing, setInitializing] = useState(false);
  const [paystackRef, setPaystackRef] = useState<string | null>(null);
  // Balance to beat while we wait for a deposit to land. Bank transfer and USSD
  // settle after the popup closes, via webhook, so the number on screen has to
  // move by itself — otherwise the player is left wondering where their money
  // went and tries paying again.
  const [awaitingCredit, setAwaitingCredit] = useState<number | null>(null);

  // Withdrawal States — Paystack transfer to a Nigerian bank account.
  const [withdrawAmount, setWithdrawAmount] = useState('2000');
  const [withdrawBank, setWithdrawBank] = useState(NG_BANKS[0]);
  const [withdrawAccount, setWithdrawAccount] = useState('');
  const [withdrawAccountName, setWithdrawAccountName] = useState('');
  const [resolving, setResolving] = useState(false);
  const [withdrawPin, setWithdrawPin] = useState('');
  const [withdrawStatus, setWithdrawStatus] = useState<'idle' | 'processing' | 'completed'>('idle');
  const [withdrawError, setWithdrawError] = useState('');

  // Withdrawal PIN — set once per account, then required for every payout.
  const [pinMode, setPinMode] = useState<'idle' | 'editing'>('idle');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [pinSaving, setPinSaving] = useState(false);

  const savePin = async () => {
    setPinError('');
    if (newPin !== confirmPin) { setPinError('The two PINs do not match.'); return; }
    if (!/^\d{4}$/.test(newPin)) { setPinError('PIN must be exactly 4 digits.'); return; }
    setPinSaving(true);
    try {
      const res = await fetch(apiUrl('/api/profile/set-pin'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: profile.email, newPin, currentPin }),
      });
      const data = await res.json();
      if (!res.ok) { setPinError(data.error || 'Could not save your PIN.'); return; }
      setPinMode('idle');
      setNewPin(''); setConfirmPin(''); setCurrentPin('');
      onRefreshProfile();
    } catch {
      setPinError('Lost connection to the cashier service.');
    } finally {
      setPinSaving(false);
    }
  };

  // KYC States
  const [kycName, setKycName] = useState('');
  const [kycType, setKycType] = useState('Passport');
  const [kycNumber, setKycNumber] = useState('');
  const [kycStatus, setKycStatus] = useState<'idle' | 'submitting' | 'completed'>('idle');

  // Copy hash helper
  const [copiedTxId, setCopiedTxId] = useState<string | null>(null);

  const handleCopyHash = (hash: string) => {
    navigator.clipboard.writeText(hash);
    setCopiedTxId(hash);
    setTimeout(() => setCopiedTxId(null), 1500);
  };

  // Clamp a quantity into the allowed [min, max] range.
  const clampQty = (n: number) => Math.max(minQty, Math.min(maxQty, Math.floor(n) || minQty));

  // Buy the chosen quantity of tickets (debited from wallet balance)
  const handleBuyTickets = async () => {
    setTicketError('');
    const qty = clampQty(ticketQty);
    if (profile.balance < unitPrice * qty) {
      setTicketError(`Insufficient balance. ${qty} tickets cost ${formatNaira(unitPrice * qty)}. Add funds first.`);
      return;
    }

    setTicketStatus('processing');
    await new Promise(r => setTimeout(r, 1200)); // simulate payment settlement

    try {
      const response = await fetch(apiUrl(`/api/profile/buy-tickets`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: profile.email, quantity: qty }),
      });
      const data = await response.json();
      if (!response.ok) {
        setTicketStatus('failed');
        setTicketError(data.error || 'Ticket purchase failed.');
      } else {
        setTicketStatus('completed');
        onRefreshProfile();
        setTimeout(() => setTicketStatus('idle'), 2500);
      }
    } catch (e) {
      setTicketStatus('failed');
      setTicketError('Lost connection to cashier service.');
    }
  };

  // While a deposit is settling, re-fetch the profile until the balance moves.
  // Stops as soon as the money lands, or after two minutes so a truly abandoned
  // payment doesn't leave the app polling forever.
  useEffect(() => {
    if (awaitingCredit === null) return;

    if (profile.balance > awaitingCredit) {
      setAwaitingCredit(null);
      setDepositError('');
      setDepositStatus('completed');
      // The reset back to 'idle' lives in its own effect below. Scheduling it
      // here would tie it to this effect's cleanup — and clearing awaitingCredit
      // re-runs this effect immediately, which would cancel the reset and leave
      // the success screen up forever.
      return;
    }

    const startedAt = Date.now();
    const id = window.setInterval(() => {
      if (Date.now() - startedAt > 120000) {
        window.clearInterval(id);
        setAwaitingCredit(null);
        return;
      }
      onRefreshProfile();
    }, 3000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingCredit, profile.balance]);

  // Drop the deposit success screen back to the form after a moment, wherever
  // it was set from.
  useEffect(() => {
    if (depositStatus !== 'completed') return;
    const id = window.setTimeout(() => setDepositStatus('idle'), 3000);
    return () => window.clearTimeout(id);
  }, [depositStatus]);

  // Ask the server to verify a reference with Paystack. The server is the only
  // thing that credits the wallet — a client callback never does.
  const verifyPaystack = async (reference: string) => {
    try {
      const res = await fetch(apiUrl(`/api/paystack/verify`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference }),
      });
      const data = await res.json();
      if (res.ok && data.status) return { ok: true };
      return { ok: false, error: data.error || 'Payment verification failed.' };
    } catch {
      return { ok: false, error: 'Network error while verifying payment.' };
    }
  };

  // Deposit — initialize server-side, open the real Paystack popup, then verify.
  const handleDepositSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setDepositError('');
    const amt = parseFloat(depositAmount);
    if (isNaN(amt) || amt < 100) {
      setDepositError('Minimum deposit is ₦100.');
      return;
    }

    // Remember what the wallet held before, so we can tell when it moves.
    const baseline = profile.balance;

    setInitializing(true);
    try {
      const response = await fetch(apiUrl(`/api/paystack/initialize`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: profile.email, amount: amt }),
      });
      const data = await response.json();
      if (!response.ok || !data.status || !data.access_code) {
        setDepositError(data.error || 'Could not start Paystack checkout.');
        return;
      }

      setPaystackRef(data.reference);
      const outcome = await openPaystackCheckout(data.access_code);

      if (outcome === 'error') {
        setDepositError('Paystack reported a problem with that payment.');
        return;
      }

      // Watch for the money regardless of how the popup closed. Closing it does
      // NOT mean no payment: a player choosing bank transfer often closes the
      // window and pays from their banking app minutes later.
      setAwaitingCredit(baseline);

      if (outcome === 'cancelled') {
        setDepositError('Checkout closed. If you already sent a transfer or used USSD, your balance will update here on its own.');
        return;
      }

      const verified = await verifyPaystack(data.reference);
      if (verified.ok) {
        onRefreshProfile(); // the watcher above flips the UI once it lands
      } else {
        // Often just "not yet" — the webhook finishes it moments later.
        setDepositError('Payment received — waiting for it to settle. Your balance will update here automatically.');
        onRefreshProfile();
      }
    } catch (err) {
      setDepositError(err instanceof Error ? err.message : 'Lost connection to the cashier service.');
    } finally {
      setInitializing(false);
      setPaystackRef(null);
    }
  };

  // Resolve the bank account number → account holder name (Paystack-style).
  const resolveAccount = async (acct: string, bank: string) => {
    const digits = acct.replace(/\D/g, '');
    if (digits.length !== 10) { setWithdrawAccountName(''); return; }
    setResolving(true);
    setWithdrawError('');
    try {
      const res = await fetch(apiUrl(`/api/paystack/resolve-account`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountNumber: digits, bank }),
      });
      const data = await res.json();
      if (res.ok && data.status) setWithdrawAccountName(data.data.account_name);
      else { setWithdrawAccountName(''); setWithdrawError(data.error || 'Could not resolve account.'); }
    } catch {
      setWithdrawAccountName('');
    } finally {
      setResolving(false);
    }
  };

  // Withdrawal — Paystack transfer to the resolved bank account.
  const handleWithdrawSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setWithdrawError('');

    const amt = parseFloat(withdrawAmount);
    if (isNaN(amt) || amt <= 0) { setWithdrawError('Please specify a valid withdrawal amount.'); return; }
    if (profile.balance < amt) { setWithdrawError('Insufficient ledger balance.'); return; }
    if (withdrawAccount.replace(/\D/g, '').length !== 10 || !withdrawAccountName) {
      setWithdrawError('Enter a valid 10-digit account number to resolve the account name.');
      return;
    }
    if (!withdrawPin) { setWithdrawError('Security Transaction PIN is required.'); return; }

    setWithdrawStatus('processing');
    await new Promise(r => setTimeout(r, 1800)); // simulate Paystack transfer queueing

    const last4 = withdrawAccount.replace(/\D/g, '').slice(-4);
    try {
      const response = await fetch(apiUrl(`/api/profile/withdraw`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: profile.email,
          amount: amt,
          method: `Paystack • ${withdrawBank} ••${last4}`,
          bank: withdrawBank,
          accountNumber: withdrawAccount.replace(/\D/g, ''),
          accountName: withdrawAccountName,
          pin: withdrawPin,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setWithdrawStatus('idle');
        setWithdrawError(data.error || 'Withdrawal validation failed.');
      } else {
        setWithdrawStatus('completed');
        onRefreshProfile();
        setTimeout(() => {
          setWithdrawStatus('idle');
          setWithdrawAmount('2000');
          setWithdrawPin('');
        }, 3000);
      }
    } catch (e) {
      setWithdrawStatus('idle');
      setWithdrawError('Failed to route payout to the bank network.');
    }
  };

  // Submit KYC Verification
  const handleKycSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!kycName || !kycNumber) return;

    setKycStatus('submitting');
    await new Promise(r => setTimeout(r, 2000)); // Simulate AI document facial match check

    try {
      const response = await fetch(apiUrl(`/api/profile/verify`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: profile.email,
          fullName: kycName,
          idType: kycType,
          idNumber: kycNumber,
        }),
      });

      if (response.ok) {
        setKycStatus('completed');
        onRefreshProfile();
        setTimeout(() => {
          setActiveTab('withdraw');
          setKycStatus('idle');
        }, 2000);
      }
    } catch (e) {
      setKycStatus('idle');
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 w-full max-w-6xl mx-auto p-2" id="finance_portal_main">

      {/* The Paystack popup is rendered by Paystack's own script, not by us. */}

      {/* CASHIER TERMINAL CARD */}
      <div className="lg:col-span-7 bg-dark-card border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col">
        {/* TAB BUTTONS */}
        <div className="flex border-b border-slate-800 pb-4 mb-6 gap-2 overflow-x-auto">
          <button
            onClick={() => setActiveTab('tickets')}
            className={`flex-1 min-w-max py-2 px-2 rounded-lg font-mono text-xs font-bold transition-all flex items-center justify-center gap-2 ${
              activeTab === 'tickets'
                ? 'bg-neon-purple/10 border border-neon-purple/30 text-neon-purple shadow-[0_0_10px_rgba(157,78,221,0.15)]'
                : 'text-slate-400 hover:text-white hover:bg-slate-900/50'
            }`}
          >
            <Ticket className="w-4 h-4" />
            Buy Tickets
          </button>

          <button
            onClick={() => setActiveTab('referral')}
            className={`flex-1 min-w-max py-2 px-2 rounded-lg font-mono text-xs font-bold transition-all flex items-center justify-center gap-2 ${
              activeTab === 'referral'
                ? 'bg-neon-green/10 border border-neon-green/30 text-neon-green shadow-[0_0_10px_rgba(0,255,102,0.15)]'
                : 'text-slate-400 hover:text-white hover:bg-slate-900/50'
            }`}
          >
            <Gift className="w-4 h-4" />
            Refer &amp; Earn
          </button>

          <button
            onClick={() => setActiveTab('deposit')}
            className={`flex-1 min-w-max py-2 px-2 rounded-lg font-mono text-xs font-bold transition-all flex items-center justify-center gap-2 ${
              activeTab === 'deposit'
                ? 'bg-neon-green/10 border border-neon-green/30 text-neon-green shadow-[0_0_10px_rgba(0,255,102,0.15)]'
                : 'text-slate-400 hover:text-white hover:bg-slate-900/50'
            }`}
          >
            <ArrowDownLeft className="w-4 h-4" />
            Add Funds
          </button>

          <button
            onClick={() => setActiveTab('withdraw')}
            className={`flex-1 py-2 rounded-lg font-mono text-xs font-bold transition-all flex items-center justify-center gap-2 ${
              activeTab === 'withdraw'
                ? 'bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan shadow-[0_0_10px_rgba(0,243,255,0.15)]'
                : 'text-slate-400 hover:text-white hover:bg-slate-900/50'
            }`}
          >
            <ArrowUpRight className="w-4 h-4" />
            Withdraw Winnings
          </button>

          <button
            onClick={() => setActiveTab('verification')}
            className={`flex-1 py-2 rounded-lg font-mono text-xs font-bold transition-all flex items-center justify-center gap-2 ${
              activeTab === 'verification'
                ? 'bg-neon-purple/10 border border-neon-purple/30 text-neon-purple shadow-[0_0_10px_rgba(157,78,221,0.15)]'
                : 'text-slate-400 hover:text-white hover:bg-slate-900/50'
            }`}
          >
            <ShieldCheck className="w-4 h-4" />
            KYC Verification
          </button>
        </div>

        {/* TAB CONTENTS */}
        <div className="flex-1">
          {/* 0. TICKET PORTAL — buy any quantity between min and max */}
          {activeTab === 'tickets' && (
            <AnimatePresence mode="wait">
              {ticketStatus === 'completed' ? (
                <motion.div
                  key="ticket-completed"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-center py-12 space-y-3"
                >
                  <CheckCircle2 className="w-14 h-14 text-neon-purple mx-auto animate-bounce" />
                  <h3 className="text-lg font-bold font-display text-neon-purple neon-glow-purple">Tickets Added!</h3>
                  <p className="text-xs text-slate-400 font-mono">
                    You now hold <strong className="text-white">{profile.tickets}</strong> tournament tickets.
                  </p>
                </motion.div>
              ) : (
                <motion.div
                  key="ticket-form"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-4"
                >
                  {/* Current ticket balance */}
                  <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800/80 flex items-center justify-between">
                    <div>
                      <span className="text-[10px] font-mono text-slate-500 block uppercase">Your Tournament Tickets</span>
                      <span className="text-3xl font-bold font-display text-neon-purple flex items-center gap-2">
                        <Ticket className="w-6 h-6" /> {profile.tickets}
                      </span>
                    </div>
                    {!profile.freeGameUsed && (
                      <span className="text-[9px] font-mono bg-neon-green/10 border border-neon-green/40 text-neon-green px-2 py-1 rounded flex items-center gap-1">
                        <Gift className="w-3 h-3" /> 1 FREE GAME LEFT
                      </span>
                    )}
                  </div>

                  {/* The other way to get a ticket without paying for it. */}
                  <button
                    onClick={() => setActiveTab('referral')}
                    className="w-full text-left bg-neon-green/5 border border-neon-green/25 rounded-xl px-4 py-3 flex items-center gap-3 hover:bg-neon-green/10 transition-all cursor-pointer"
                  >
                    <Gift className="w-4 h-4 text-neon-green flex-shrink-0" />
                    <span className="text-[11px] font-mono text-slate-300 flex-1">
                      Invite a friend — when they sign up and buy tickets, you get a{' '}
                      <strong className="text-neon-green">free ticket</strong>.
                    </span>
                    <span className="text-[10px] font-mono text-neon-green whitespace-nowrap">Refer &amp; Earn →</span>
                  </button>

                  {/* Quantity picker */}
                  <div className="bg-gradient-to-br from-neon-purple/10 to-slate-950 border border-neon-purple/30 rounded-2xl p-5 relative overflow-hidden space-y-4">
                    <div className="absolute -top-8 -right-8 w-24 h-24 bg-neon-purple/10 rounded-full blur-2xl" />
                    <div className="flex items-center justify-between relative">
                      <div>
                        <h3 className="text-md font-bold font-display text-white">Buy Tournament Tickets</h3>
                        <p className="text-[11px] text-slate-400 font-mono mt-1">
                          {formatNaira(unitPrice)} / ticket · one ticket = one entry
                        </p>
                      </div>
                    </div>

                    <div className="relative">
                      <label className="block text-[10px] font-mono text-slate-400 mb-1.5 uppercase tracking-wide">
                        Quantity ({minQty}–{maxQty})
                      </label>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => { setTicketError(''); setTicketQty(q => clampQty(q - 1)); }}
                          className="w-10 h-10 flex-shrink-0 rounded-lg bg-slate-900 border border-slate-800 text-white font-bold text-lg hover:border-neon-purple/60 disabled:opacity-40"
                          disabled={ticketQty <= minQty}
                        >−</button>
                        <input
                          type="number"
                          value={ticketQty}
                          min={minQty}
                          max={maxQty}
                          onChange={(e) => { setTicketError(''); setTicketQty(clampQty(Number(e.target.value))); }}
                          className="flex-1 min-w-0 bg-slate-900 border border-slate-800 rounded-lg py-2 px-3 font-mono text-sm text-white text-center focus:outline-none focus:border-neon-purple/60"
                        />
                        <button
                          type="button"
                          onClick={() => { setTicketError(''); setTicketQty(q => clampQty(q + 1)); }}
                          className="w-10 h-10 flex-shrink-0 rounded-lg bg-slate-900 border border-slate-800 text-white font-bold text-lg hover:border-neon-purple/60 disabled:opacity-40"
                          disabled={ticketQty >= maxQty}
                        >+</button>
                      </div>
                      {/* Quick amounts */}
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {[minQty, 10, 20, 32, maxQty].filter((v, i, a) => v >= minQty && v <= maxQty && a.indexOf(v) === i).map(v => (
                          <button
                            key={v}
                            type="button"
                            onClick={() => { setTicketError(''); setTicketQty(v); }}
                            className={`px-2.5 py-1 rounded-md font-mono text-[10px] font-bold border transition-all ${
                              ticketQty === v ? 'border-neon-purple bg-neon-purple/10 text-neon-purple' : 'border-slate-800 bg-slate-900/50 text-slate-400 hover:text-white'
                            }`}
                          >{v}</button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center justify-between border-t border-slate-800 pt-3 relative">
                      <span className="text-[11px] font-mono text-slate-400">Total</span>
                      <span className="text-2xl font-black font-display text-neon-green neon-glow-green">{formatNaira(totalCost)}</span>
                    </div>
                  </div>

                  {/* Wallet balance context */}
                  <div className="flex items-center justify-between font-mono text-xs px-1">
                    <span className="text-slate-500">Wallet Balance</span>
                    <span className={`font-bold ${profile.balance >= totalCost ? 'text-neon-green' : 'text-red-400'}`}>
                      {formatNaira(profile.balance)}
                    </span>
                  </div>

                  {ticketError && (
                    <div className="p-3 bg-red-950/40 border border-red-500/30 rounded-lg text-xs text-red-400 font-mono flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      {ticketError}
                    </div>
                  )}

                  {profile.balance < totalCost ? (
                    <button
                      onClick={() => setActiveTab('deposit')}
                      className="w-full py-2.5 rounded-lg bg-neon-green hover:bg-neon-green/90 text-[#050505] font-mono font-bold text-xs transition-all tracking-wider shadow-[0_0_15px_rgba(0,255,102,0.3)]"
                    >
                      Add Funds to Buy ({formatNaira(totalCost)} needed)
                    </button>
                  ) : (
                    <button
                      onClick={handleBuyTickets}
                      disabled={ticketStatus === 'processing'}
                      className="w-full py-2.5 rounded-lg bg-neon-purple hover:bg-neon-purple/90 text-white font-mono font-bold text-xs transition-all tracking-wider shadow-[0_0_15px_rgba(157,78,221,0.3)] disabled:opacity-60 flex items-center justify-center gap-2"
                    >
                      {ticketStatus === 'processing' ? (
                        <><Loader2 className="w-4 h-4 animate-spin" /> Processing Payment...</>
                      ) : (
                        <>Buy {ticketQty} Tickets · {formatNaira(totalCost)}</>
                      )}
                    </button>
                  )}

                  <p className="text-[9px] text-slate-600 font-mono text-center">
                    Simulated purchase · payments will be wired to a real processor at launch.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          )}

          {/* 0b. REFER & EARN — share a link, earn free tickets when invitees buy */}
          {activeTab === 'referral' && <ReferralPanel email={profile.email} />}

          {/* 1. DEPOSIT PORTAL — Paystack checkout */}
          {activeTab === 'deposit' && (
            <AnimatePresence mode="wait">
              {depositStatus === 'completed' ? (
                <motion.div key="deposit-done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-12 space-y-3">
                  <CheckCircle2 className="w-14 h-14 text-neon-green mx-auto animate-bounce" />
                  <h3 className="text-lg font-bold font-display text-neon-green neon-glow-green">Deposit settled!</h3>
                  <p className="text-xs text-slate-400 font-mono">Your Paystack payment cleared — your wallet balance is updated.</p>
                </motion.div>
              ) : (
                <motion.form key="deposit-form" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} onSubmit={handleDepositSubmit} className="space-y-4">
                  <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800/80 mb-4">
                    <span className="text-[10px] font-mono text-slate-500 block uppercase">Current Wallet Balance</span>
                    <span className="text-3xl font-bold font-display text-white">{formatNaira(profile.balance)}</span>
                  </div>

                  <div>
                    <label className="block text-xs font-mono text-slate-400 mb-2">Amount to Fund (₦)</label>
                    <div className="relative">
                      <span className="absolute left-3.5 top-1/2 -translate-y-1/2 font-display text-slate-400 font-bold">₦</span>
                      <input
                        type="number"
                        value={depositAmount}
                        onChange={(e) => setDepositAmount(e.target.value)}
                        placeholder="5000"
                        min="100"
                        className="w-full bg-slate-900/80 border border-slate-800 rounded-lg py-2.5 pl-8 pr-4 font-mono text-sm text-white focus:outline-none focus:border-neon-green/60"
                        required
                      />
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {[1000, 2000, 5000, 10000].map(v => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => setDepositAmount(String(v))}
                          className={`px-2.5 py-1 rounded-md font-mono text-[10px] font-bold border transition-all ${depositAmount === String(v) ? 'border-neon-green bg-neon-green/10 text-neon-green' : 'border-slate-800 bg-slate-900/50 text-slate-400 hover:text-white'}`}
                        >{formatNaira(v)}</button>
                      ))}
                    </div>
                  </div>

                  {/* Paystack method preview */}
                  <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: '#0BA4DB' }}>
                      <span className="font-bold text-sm" style={{ color: '#fff' }}>P</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold text-white">Pay with Paystack</div>
                      <div className="text-[10px] font-mono text-slate-500">Card · Bank Transfer · USSD</div>
                    </div>
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded flex-shrink-0" style={{ background: '#fff4e5', color: '#b26a00' }}>TEST</span>
                  </div>

                  {/* Settling: shown while we watch for the money to land, so a
                      slow bank transfer never looks like a lost payment. */}
                  {awaitingCredit !== null && (
                    <div className="p-3 bg-neon-cyan/5 border border-neon-cyan/30 rounded-lg text-xs text-neon-cyan font-mono flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
                      <span>
                        Waiting for your payment to settle — this page updates by itself, no need to
                        refresh or pay again.
                      </span>
                    </div>
                  )}

                  {depositError && awaitingCredit === null && (
                    <div className="p-3 bg-red-950/40 border border-red-500/30 rounded-lg text-xs text-red-400 font-mono flex items-center gap-2">
                      <AlertCircle className="w-4 h-4" />
                      {depositError}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={initializing}
                    className="w-full py-3 rounded-lg font-bold text-sm cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-60 flex items-center justify-center gap-2"
                    style={{ background: '#0BA4DB', color: '#fff' }}
                  >
                    {initializing ? (<><Loader2 className="w-4 h-4 animate-spin" /> Starting Paystack…</>) : (<>Pay {formatNaira(parseFloat(depositAmount) || 0)} with Paystack</>)}
                  </button>
                  <p className="text-[9px] text-slate-600 font-mono text-center">Secured by Paystack · card, bank transfer or USSD.</p>
                </motion.form>
              )}
            </AnimatePresence>
          )}

          {/* 2. WITHDRAWAL PORTAL */}
          {activeTab === 'withdraw' && (
            <AnimatePresence mode="wait">
              {profile.verificationStatus !== 'verified' ? (
                // REQUIRED KYC REDIRECT MESSAGE
                <motion.div
                  key="kyc-required"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="bg-slate-900/40 border border-dashed border-red-500/30 rounded-2xl p-6 text-center space-y-4"
                >
                  <Lock className="w-10 h-10 text-red-400 mx-auto" />
                  <div>
                    <h3 className="text-sm font-semibold font-display text-white uppercase tracking-wide">KYC Compliance Block</h3>
                    <p className="text-xs text-slate-400 font-mono mt-2 leading-relaxed">
                      To satisfy strict local data privacy and financial safety requirements, withdrawals are exclusively available to **Verified Players**.
                    </p>
                  </div>
                  <button
                    onClick={() => setActiveTab('verification')}
                    className="px-4 py-2 bg-neon-purple text-white text-xs font-bold font-mono rounded-lg hover:bg-neon-purple/90 transition-all shadow-[0_0_10px_rgba(157,78,221,0.3)]"
                  >
                    Complete 30-Sec Verification Now
                  </button>
                </motion.div>
              ) : withdrawStatus === 'idle' ? (
                <motion.form
                  key="withdraw-form"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  onSubmit={handleWithdrawSubmit}
                  className="space-y-4"
                >
                  <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800/80 mb-4 flex items-center justify-between">
                    <div>
                      <span className="text-[10px] font-mono text-slate-500 block uppercase">Withdrawable Balance</span>
                      <span className="text-3xl font-bold font-display text-neon-cyan neon-glow-cyan">{formatNaira(profile.balance)}</span>
                    </div>
                    <span className="text-[9px] font-mono bg-neon-cyan/10 border border-neon-cyan/40 text-neon-cyan px-2 py-0.5 rounded">Verified Profile</span>
                  </div>

                  <div>
                    <label className="block text-xs font-mono text-slate-400 mb-2">Withdraw Amount (₦)</label>
                    <input
                      type="number"
                      value={withdrawAmount}
                      onChange={(e) => setWithdrawAmount(e.target.value)}
                      placeholder="50"
                      className="w-full bg-slate-900/80 border border-slate-800 rounded-lg py-2.5 px-4 font-mono text-sm text-white focus:outline-none focus:border-neon-cyan/60"
                      required
                      min="1"
                    />
                  </div>

                  {/* Paystack transfer — bank + account, auto-resolves the name */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-mono text-slate-400 mb-2">Bank</label>
                      <select
                        value={withdrawBank}
                        onChange={(e) => { setWithdrawBank(e.target.value); if (withdrawAccount.replace(/\D/g, '').length === 10) resolveAccount(withdrawAccount, e.target.value); }}
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg py-2.5 px-3 font-mono text-xs text-white focus:outline-none"
                      >
                        {NG_BANKS.map(b => <option key={b} value={b}>{b}</option>)}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-mono text-slate-400 mb-2">Account Number (10 digits)</label>
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={10}
                        value={withdrawAccount}
                        onChange={(e) => {
                          const v = e.target.value.replace(/\D/g, '').slice(0, 10);
                          setWithdrawAccount(v);
                          setWithdrawAccountName('');
                          if (v.length === 10) resolveAccount(v, withdrawBank);
                        }}
                        placeholder="0123456789"
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg py-2.5 px-3 font-mono text-xs text-white focus:outline-none focus:border-neon-cyan/60"
                        required
                      />
                    </div>
                  </div>

                  {/* Resolved account name */}
                  {(resolving || withdrawAccountName) && (
                    <div className="flex items-center gap-2 text-xs font-mono px-1">
                      {resolving ? (
                        <><Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" /> <span className="text-slate-400">Resolving account…</span></>
                      ) : (
                        <><CheckCircle2 className="w-3.5 h-3.5 text-neon-green" /> <span className="text-neon-green font-bold uppercase">{withdrawAccountName}</span></>
                      )}
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-mono text-slate-400 mb-2">Withdrawal PIN</label>

                    {pinMode === 'editing' || !profile.hasWithdrawalPin ? (
                      <div className="space-y-2 bg-slate-900/60 border border-neon-cyan/25 rounded-lg p-3">
                        <p className="text-[10px] font-mono text-slate-400">
                          {profile.hasWithdrawalPin
                            ? 'Change your 4-digit withdrawal PIN.'
                            : 'Create a 4-digit PIN. It authorises every withdrawal, so pick something only you know.'}
                        </p>
                        {profile.hasWithdrawalPin && (
                          <input
                            type="password" inputMode="numeric" placeholder="Current PIN" maxLength={4}
                            value={currentPin} onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, ''))}
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 font-mono text-sm text-white focus:outline-none focus:border-neon-cyan/60"
                          />
                        )}
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            type="password" inputMode="numeric" placeholder="New PIN" maxLength={4}
                            value={newPin} onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 font-mono text-sm text-white focus:outline-none focus:border-neon-cyan/60"
                          />
                          <input
                            type="password" inputMode="numeric" placeholder="Confirm" maxLength={4}
                            value={confirmPin} onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))}
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 font-mono text-sm text-white focus:outline-none focus:border-neon-cyan/60"
                          />
                        </div>
                        {pinError && <p className="text-[10px] font-mono text-red-400">{pinError}</p>}
                        <div className="flex gap-2">
                          <button
                            type="button" onClick={savePin} disabled={pinSaving}
                            className="flex-1 py-2 rounded-lg bg-neon-cyan/10 border border-neon-cyan/40 text-neon-cyan font-mono text-xs font-bold disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1.5"
                          >
                            {pinSaving ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</> : 'Save PIN'}
                          </button>
                          {profile.hasWithdrawalPin && (
                            <button
                              type="button"
                              onClick={() => { setPinMode('idle'); setPinError(''); setNewPin(''); setConfirmPin(''); setCurrentPin(''); }}
                              className="px-3 py-2 rounded-lg border border-slate-800 text-slate-400 font-mono text-xs cursor-pointer"
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="relative">
                          <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                          <input
                            type="password"
                            inputMode="numeric"
                            placeholder="••••"
                            maxLength={4}
                            value={withdrawPin}
                            onChange={(e) => setWithdrawPin(e.target.value.replace(/\D/g, ''))}
                            className="w-full bg-slate-900/80 border border-slate-800 rounded-lg py-2.5 pl-9 pr-4 font-mono text-sm text-white focus:outline-none focus:border-neon-cyan/60"
                            required
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => setPinMode('editing')}
                          className="text-[10px] font-mono text-slate-500 hover:text-neon-cyan mt-1.5 cursor-pointer"
                        >
                          Change PIN
                        </button>
                      </>
                    )}
                  </div>

                  {withdrawError && (
                    <div className="p-3 bg-red-950/40 border border-red-500/30 rounded-lg text-xs text-red-400 font-mono flex items-center gap-2">
                      <AlertCircle className="w-4 h-4" />
                      {withdrawError}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={resolving || !withdrawAccountName}
                    className="w-full py-3 rounded-lg font-bold text-sm cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                    style={{ background: '#0BA4DB', color: '#fff' }}
                  >
                    <Landmark className="w-4 h-4" /> Withdraw {formatNaira(parseFloat(withdrawAmount) || 0)} to bank
                  </button>
                  <p className="text-[9px] text-slate-600 font-mono text-center">Simulated Paystack transfer · no real money moves.</p>
                </motion.form>
              ) : withdrawStatus === 'processing' ? (
                <motion.div
                  key="withdraw-processing"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-col items-center justify-center py-12 space-y-4"
                >
                  <Loader2 className="w-12 h-12 animate-spin" style={{ color: '#0BA4DB' }} />
                  <h3 className="text-sm font-semibold font-display text-white">Queuing Paystack transfer…</h3>
                  <p className="text-[10px] text-slate-500 font-mono text-center max-w-[280px]">
                    Debiting your wallet and routing the payout to {withdrawBank}.
                  </p>
                </motion.div>
              ) : (
                <motion.div
                  key="withdraw-completed"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-center py-12 space-y-3"
                >
                  <CheckCircle2 className="w-14 h-14 text-neon-cyan mx-auto animate-bounce" />
                  <h3 className="text-lg font-bold font-display text-neon-cyan neon-glow-cyan">Transfer sent!</h3>
                  <p className="text-xs text-slate-400 font-mono max-w-[320px] mx-auto">
                    Debited -{formatNaira(parseFloat(withdrawAmount) || 0)} — Paystack is sending it to {withdrawAccountName} ({withdrawBank}).
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          )}

          {/* 3. KYC VERIFICATION PORTAL */}
          {activeTab === 'verification' && (
            <AnimatePresence mode="wait">
              {profile.verificationStatus === 'verified' ? (
                <motion.div
                  key="kyc-verified"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-center py-10 space-y-4"
                >
                  <CheckCircle2 className="w-14 h-14 text-neon-purple mx-auto neon-glow-purple" />
                  <div>
                    <h3 className="text-lg font-bold font-display text-neon-purple neon-glow-purple">Identity Confirmed</h3>
                    <p className="text-xs text-slate-400 font-mono mt-1">You are fully compliant with local regulations.</p>
                  </div>
                  
                  {profile.verificationDetails && (
                    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 max-w-sm mx-auto text-left font-mono text-xs space-y-1.5 text-slate-300">
                      <div>Name: <span className="text-white font-semibold">{profile.verificationDetails.fullName}</span></div>
                      <div>Type: <span className="text-white font-semibold">{profile.verificationDetails.idType}</span></div>
                      <div>ID Number: <span className="text-white font-semibold">{profile.verificationDetails.idNumber}</span></div>
                      <div>Status: <span className="text-neon-purple font-semibold">VERIFIED</span></div>
                    </div>
                  )}
                </motion.div>
              ) : kycStatus === 'idle' ? (
                <motion.form
                  key="kyc-form"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  onSubmit={handleKycSubmit}
                  className="space-y-4"
                >
                  <div className="bg-slate-900/40 p-4 rounded-xl border border-slate-800">
                    <p className="text-xs text-slate-400 leading-relaxed font-mono">
                      🔒 Your documents are encrypted and protected under secure privacy policies. Verification grants cashout rights.
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-mono text-slate-400 mb-2">Legal Full Name</label>
                    <input
                      type="text"
                      value={kycName}
                      onChange={(e) => setKycName(e.target.value)}
                      placeholder="Jane Doe"
                      className="w-full bg-slate-900/80 border border-slate-800 rounded-lg py-2.5 px-4 font-mono text-sm text-white focus:outline-none focus:border-neon-purple/60"
                      required
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-mono text-slate-400 mb-2">ID Document Type</label>
                      <select
                        value={kycType}
                        onChange={(e) => setKycType(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg py-2.5 px-3 font-mono text-xs text-white focus:outline-none"
                      >
                        <option value="Passport">International Passport</option>
                        <option value="Driver License">Driver License</option>
                        <option value="National ID">National Identity Card</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-mono text-slate-400 mb-2">ID Number/Hash</label>
                      <input
                        type="text"
                        value={kycNumber}
                        onChange={(e) => setKycNumber(e.target.value)}
                        placeholder="N-12345678"
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg py-2.5 px-3 font-mono text-xs text-white focus:outline-none"
                        required
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="w-full py-2.5 rounded-lg bg-neon-purple hover:bg-neon-purple/90 text-white font-mono font-bold text-xs transition-all tracking-wider shadow-[0_0_15px_rgba(157,78,221,0.3)] mt-6"
                  >
                    Submit Encrypted Verification
                  </button>
                </motion.form>
              ) : kycStatus === 'submitting' ? (
                <motion.div
                  key="kyc-submitting"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-col items-center justify-center py-12 space-y-4"
                >
                  <Loader2 className="w-12 h-12 text-neon-purple animate-spin" />
                  <h3 className="text-sm font-semibold font-display text-white">Performing Biometric Scanning...</h3>
                  <p className="text-[10px] text-slate-500 font-mono text-center max-w-[280px]">
                    Matching face records and verifying ID checksums. Fully automated compliant process.
                  </p>
                </motion.div>
              ) : (
                <motion.div
                  key="kyc-completed"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-center py-12 space-y-3"
                >
                  <CheckCircle2 className="w-14 h-14 text-neon-purple mx-auto animate-bounce" />
                  <h3 className="text-lg font-bold font-display text-neon-purple neon-glow-purple">Verification Approved!</h3>
                  <p className="text-xs text-slate-400 font-mono">
                    Thank you. Your cashier status is now fully verified.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </div>
      </div>

      {/* LEDGER & TRANSACTION ARCHIVE */}
      <div className="lg:col-span-5 bg-dark-card border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col max-h-[500px]">
        <h2 className="text-md font-bold font-display text-white mb-1 tracking-tight flex items-center justify-between">
          <span>Ledger Activities</span>
          <span className="text-[9px] font-mono font-medium px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-500 uppercase">
            Audit Ready
          </span>
        </h2>
        <p className="text-xs text-slate-500 font-mono mb-4">Cryptographically signed ledger audit feed</p>

        <div className="flex-1 overflow-y-auto space-y-3 pr-1">
          {profile.history.length === 0 ? (
            <div className="text-center py-10 font-mono text-xs text-slate-500">
              No transactions recorded in ledger.
            </div>
          ) : (
            profile.history.map((tx) => {
              const isCredit = tx.type === 'win' || tx.type === 'deposit' || tx.type === 'refund';
              const sign = isCredit ? '+' : '-';

              // Colors
              const colorTextClass = tx.type === 'win' ? 'text-neon-green' : tx.type === 'deposit' ? 'text-neon-green' : tx.type === 'refund' ? 'text-neon-cyan' : tx.type === 'ticket' ? 'text-neon-purple' : tx.type === 'bet' ? 'text-neon-pink' : 'text-neon-cyan';
              const badgeBg = tx.type === 'win' ? 'bg-neon-green/5' : tx.type === 'deposit' ? 'bg-neon-green/5' : tx.type === 'refund' ? 'bg-neon-cyan/5' : tx.type === 'ticket' ? 'bg-neon-purple/5' : tx.type === 'bet' ? 'bg-neon-pink/5' : 'bg-neon-cyan/5';

              return (
                <div key={tx.id} className="p-3 bg-slate-950 rounded-xl border border-slate-900/60 space-y-1.5 hover:border-slate-800 transition-all">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className={`text-[10px] uppercase font-mono font-bold px-2 py-0.5 rounded ${badgeBg} ${colorTextClass}`}>
                        {tx.type}
                      </span>
                      <span className="text-[10px] text-slate-400 font-mono ml-2">
                        {tx.method}
                      </span>
                    </div>
                    <span className={`text-sm font-bold font-mono ${colorTextClass}`}>
                      {sign}{formatNaira(tx.amount)}
                    </span>
                  </div>

                  {/* Hash display */}
                  <div className="flex items-center justify-between pt-1 font-mono text-[9px] text-slate-500 border-t border-slate-900/40">
                    <span className="truncate max-w-[150px]">SHA-256: {tx.txHash}</span>
                    <button
                      onClick={() => handleCopyHash(tx.txHash)}
                      className="text-slate-500 hover:text-white p-0.5 transition-all flex items-center gap-0.5"
                      title="Copy transaction hash to verify"
                    >
                      {copiedTxId === tx.txHash ? (
                        <Check className="w-3 h-3 text-neon-green animate-pulse" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                      <span>{copiedTxId === tx.txHash ? 'Copied' : 'Verify'}</span>
                    </button>
                  </div>

                  <div className="text-[8px] font-mono text-slate-600 text-right">
                    {new Date(tx.timestamp).toLocaleString()}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
