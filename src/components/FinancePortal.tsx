import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { UserProfile, Transaction, PublicConfig } from '../types.js';
import { CreditCard, Wallet, ArrowDownLeft, ArrowUpRight, ShieldCheck, HelpCircle, Lock, Loader2, CheckCircle2, AlertCircle, Copy, Check, Ticket, Gift } from 'lucide-react';
import { formatNaira, TICKET_PACK_PRICE, TICKET_PACK_SIZE } from '../currency.js';

interface FinancePortalProps {
  profile: UserProfile;
  config: PublicConfig | null;
  onRefreshProfile: () => void;
}

export default function FinancePortal({ profile, config, onRefreshProfile }: FinancePortalProps) {
  // Ticket pack terms come from the admin config (fall back to defaults).
  const packPrice = config?.ticketPackPrice ?? TICKET_PACK_PRICE;
  const packSize = config?.ticketPackSize ?? TICKET_PACK_SIZE;
  // Tabs: 'tickets' | 'deposit' | 'withdraw' | 'verification'
  const [activeTab, setActiveTab] = useState<'tickets' | 'deposit' | 'withdraw' | 'verification'>('tickets');

  // Ticket purchase states
  const [ticketStatus, setTicketStatus] = useState<'idle' | 'processing' | 'completed' | 'failed'>('idle');
  const [ticketError, setTicketError] = useState('');

  // Deposit States
  const [depositAmount, setDepositAmount] = useState('5000');
  const [depositMethod, setDepositMethod] = useState<'card' | 'crypto'>('card');
  const [cardNumber, setCardNumber] = useState('4111 2222 3333 4444');
  const [cardExpiry, setCardExpiry] = useState('12/28');
  const [cardCVC, setCardCVC] = useState('954');
  const [cryptoAddress, setCryptoAddress] = useState('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
  const [depositStatus, setDepositStatus] = useState<'idle' | 'connecting' | 'authorizing' | 'signing' | 'completed' | 'failed'>('idle');
  const [depositError, setDepositError] = useState('');

  // Withdrawal States
  const [withdrawAmount, setWithdrawAmount] = useState('2000');
  const [withdrawMethod, setWithdrawMethod] = useState('Bank Transfer');
  const [withdrawAccount, setWithdrawAccount] = useState('DE89 5003 0000 1234 5678 90');
  const [withdrawPin, setWithdrawPin] = useState('');
  const [withdrawStatus, setWithdrawStatus] = useState<'idle' | 'processing' | 'completed'>('idle');
  const [withdrawError, setWithdrawError] = useState('');

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

  // Buy a tournament ticket pack (debited from wallet balance)
  const handleBuyTickets = async () => {
    setTicketError('');
    if (profile.balance < packPrice) {
      setTicketError(`Insufficient balance. You need ${formatNaira(packPrice)}. Add funds first.`);
      return;
    }

    setTicketStatus('processing');
    await new Promise(r => setTimeout(r, 1200)); // simulate payment settlement

    try {
      const response = await fetch(`/api/profile/buy-tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: profile.email }),
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

  // Submit Deposit
  const handleDepositSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setDepositError('');
    
    const amt = parseFloat(depositAmount);
    if (isNaN(amt) || amt <= 0) {
      setDepositError('Please specify a positive deposit amount.');
      return;
    }

    // Step-by-step gateway simulation
    setDepositStatus('connecting');
    await new Promise(r => setTimeout(r, 1000));
    setDepositStatus('authorizing');
    await new Promise(r => setTimeout(r, 1200));
    setDepositStatus('signing');
    await new Promise(r => setTimeout(r, 900));

    try {
      const response = await fetch(`/api/profile/deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: profile.email,
          amount: amt,
          method: depositMethod === 'card' ? 'Visa •••• 4444' : 'Bitcoin Wallet',
          cardNumber,
          cardExpiry,
          cardCVC,
          cryptoAddress,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setDepositStatus('failed');
        setDepositError(data.error || 'Payment gateway connection failed.');
      } else {
        setDepositStatus('completed');
        onRefreshProfile();
        setTimeout(() => {
          setDepositStatus('idle');
          setDepositAmount('100');
        }, 3000);
      }
    } catch (e) {
      setDepositStatus('failed');
      setDepositError('Lost connection to cashier service.');
    }
  };

  // Submit Withdrawal
  const handleWithdrawSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setWithdrawError('');

    const amt = parseFloat(withdrawAmount);
    if (isNaN(amt) || amt <= 0) {
      setWithdrawError('Please specify a valid withdrawal amount.');
      return;
    }

    if (profile.balance < amt) {
      setWithdrawError('Insufficient ledger balance.');
      return;
    }

    if (!withdrawPin) {
      setWithdrawError('Security Transaction PIN is required.');
      return;
    }

    setWithdrawStatus('processing');
    await new Promise(r => setTimeout(r, 2000)); // Simulate anti-fraud risk check

    try {
      const response = await fetch(`/api/profile/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: profile.email,
          amount: amt,
          method: withdrawMethod,
          targetAccount: withdrawAccount,
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
          setWithdrawAmount('50');
          setWithdrawPin('');
        }, 3000);
      }
    } catch (e) {
      setWithdrawStatus('idle');
      setWithdrawError('Failed to route payout to bank network.');
    }
  };

  // Submit KYC Verification
  const handleKycSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!kycName || !kycNumber) return;

    setKycStatus('submitting');
    await new Promise(r => setTimeout(r, 2000)); // Simulate AI document facial match check

    try {
      const response = await fetch(`/api/profile/verify`, {
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
          {/* 0. TICKET PACK PORTAL */}
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
                    +{packSize} tournament tickets. You now hold <strong className="text-white">{profile.tickets}</strong> tickets.
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

                  {/* Pack offer */}
                  <div className="bg-gradient-to-br from-neon-purple/10 to-slate-950 border border-neon-purple/30 rounded-2xl p-5 relative overflow-hidden">
                    <div className="absolute -top-8 -right-8 w-24 h-24 bg-neon-purple/10 rounded-full blur-2xl" />
                    <div className="flex items-center justify-between relative">
                      <div>
                        <h3 className="text-md font-bold font-display text-white">Tournament Ticket Pack</h3>
                        <p className="text-[11px] text-slate-400 font-mono mt-1">
                          {packSize} tickets · one ticket = one tournament entry
                        </p>
                      </div>
                      <div className="text-right">
                        <span className="text-2xl font-black font-display text-neon-green neon-glow-green block">{formatNaira(packPrice)}</span>
                        <span className="text-[9px] font-mono text-slate-500">{formatNaira(packPrice / packSize)} / ticket</span>
                      </div>
                    </div>
                  </div>

                  {/* Wallet balance context */}
                  <div className="flex items-center justify-between font-mono text-xs px-1">
                    <span className="text-slate-500">Wallet Balance</span>
                    <span className={`font-bold ${profile.balance >= packPrice ? 'text-neon-green' : 'text-red-400'}`}>
                      {formatNaira(profile.balance)}
                    </span>
                  </div>

                  {ticketError && (
                    <div className="p-3 bg-red-950/40 border border-red-500/30 rounded-lg text-xs text-red-400 font-mono flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      {ticketError}
                    </div>
                  )}

                  {profile.balance < packPrice ? (
                    <button
                      onClick={() => setActiveTab('deposit')}
                      className="w-full py-2.5 rounded-lg bg-neon-green hover:bg-neon-green/90 text-dark-bg font-mono font-bold text-xs transition-all tracking-wider shadow-[0_0_15px_rgba(0,255,102,0.3)]"
                    >
                      Add Funds to Buy ({formatNaira(packPrice)} needed)
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
                        <>Buy {packSize} Tickets · {formatNaira(packPrice)}</>
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

          {/* 1. DEPOSIT PORTAL */}
          {activeTab === 'deposit' && (
            <AnimatePresence mode="wait">
              {depositStatus === 'idle' ? (
                <motion.form
                  key="deposit-form"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  onSubmit={handleDepositSubmit}
                  className="space-y-4"
                >
                  <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800/80 mb-4">
                    <span className="text-[10px] font-mono text-slate-500 block uppercase">Current Wallet Balance</span>
                    <span className="text-3xl font-bold font-display text-white">{formatNaira(profile.balance)}</span>
                  </div>

                  <div>
                    <label className="block text-xs font-mono text-slate-400 mb-2">Deposit Sum (₦)</label>
                    <div className="relative">
                      <span className="absolute left-3.5 top-1/2 -translate-y-1/2 font-display text-slate-400 font-bold">₦</span>
                      <input
                        type="number"
                        value={depositAmount}
                        onChange={(e) => setDepositAmount(e.target.value)}
                        placeholder="5000"
                        className="w-full bg-slate-900/80 border border-slate-800 rounded-lg py-2.5 pl-8 pr-4 font-mono text-sm text-white focus:outline-none focus:border-neon-green/60"
                        required
                        min="1"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-mono text-slate-400 mb-2">Secure Method</label>
                    <div className="grid grid-cols-2 gap-4">
                      <button
                        type="button"
                        onClick={() => setDepositMethod('card')}
                        className={`py-3 rounded-lg border font-mono text-xs font-semibold flex flex-col items-center gap-1.5 transition-all ${
                          depositMethod === 'card'
                            ? 'border-neon-green bg-neon-green/5 text-white'
                            : 'border-slate-800 bg-slate-900/30 text-slate-400 hover:text-white hover:border-slate-700'
                        }`}
                      >
                        <CreditCard className="w-5 h-5 text-neon-green" />
                        Visa / Mastercard
                      </button>

                      <button
                        type="button"
                        onClick={() => setDepositMethod('crypto')}
                        className={`py-3 rounded-lg border font-mono text-xs font-semibold flex flex-col items-center gap-1.5 transition-all ${
                          depositMethod === 'crypto'
                            ? 'border-neon-green bg-neon-green/5 text-white'
                            : 'border-slate-800 bg-slate-900/30 text-slate-400 hover:text-white hover:border-slate-700'
                        }`}
                      >
                        <Wallet className="w-5 h-5 text-neon-green" />
                        Bitcoin Wallet
                      </button>
                    </div>
                  </div>

                  {depositMethod === 'card' ? (
                    <div className="space-y-3 pt-2">
                      <div>
                        <label className="block text-[10px] font-mono text-slate-500 mb-1">Card number</label>
                        <input
                          type="text"
                          value={cardNumber}
                          onChange={(e) => setCardNumber(e.target.value)}
                          className="w-full bg-slate-900/80 border border-slate-800 rounded-lg py-2 px-3 font-mono text-xs text-white focus:outline-none focus:border-neon-green/60"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-[10px] font-mono text-slate-500 mb-1">Expiry Date</label>
                          <input
                            type="text"
                            value={cardExpiry}
                            onChange={(e) => setCardExpiry(e.target.value)}
                            placeholder="MM/YY"
                            className="w-full bg-slate-900/80 border border-slate-800 rounded-lg py-2 px-3 font-mono text-xs text-white focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-mono text-slate-500 mb-1">CVC Code</label>
                          <input
                            type="password"
                            value={cardCVC}
                            onChange={(e) => setCardCVC(e.target.value)}
                            placeholder="***"
                            maxLength={3}
                            className="w-full bg-slate-900/80 border border-slate-800 rounded-lg py-2 px-3 font-mono text-xs text-white focus:outline-none"
                          />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3 pt-2">
                      <div>
                        <label className="block text-[10px] font-mono text-slate-500 mb-1">Send to our Secure BTC Address</label>
                        <div className="flex bg-slate-950 p-2.5 rounded-lg border border-slate-800 font-mono text-[11px] text-slate-300 items-center justify-between">
                          <span className="truncate mr-2">{cryptoAddress}</span>
                          <button
                            type="button"
                            onClick={() => handleCopyHash(cryptoAddress)}
                            className="text-neon-green p-1 hover:bg-slate-900 rounded"
                          >
                            <Copy className="w-4 h-4" />
                          </button>
                        </div>
                        <p className="text-[10px] text-slate-500 font-mono mt-1">
                          Deposits will instantly authorize upon transaction broadcast.
                        </p>
                      </div>
                    </div>
                  )}

                  {depositError && (
                    <div className="p-3 bg-red-950/40 border border-red-500/30 rounded-lg text-xs text-red-400 font-mono flex items-center gap-2">
                      <AlertCircle className="w-4 h-4" />
                      {depositError}
                    </div>
                  )}

                  <button
                    type="submit"
                    className="w-full py-2.5 rounded-lg bg-neon-green hover:bg-neon-green/90 text-dark-bg font-mono font-bold text-xs transition-all tracking-wider shadow-[0_0_15px_rgba(0,255,102,0.3)] mt-6"
                  >
                    Authorize Simulated Deposit
                  </button>
                </motion.form>
              ) : (
                // GATEWAY PROCESSING STEPPERS
                <motion.div
                  key="deposit-processing"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-col items-center justify-center py-10 space-y-6"
                >
                  {depositStatus !== 'completed' && depositStatus !== 'failed' ? (
                    <div className="text-center space-y-4">
                      <Loader2 className="w-12 h-12 text-neon-green animate-spin mx-auto" />
                      <h3 className="text-sm font-semibold font-display text-white">Payment Gateway Handshake</h3>
                      
                      <div className="space-y-2 max-w-[280px] mx-auto text-left font-mono text-xs text-slate-500">
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${depositStatus === 'connecting' ? 'bg-neon-green animate-ping' : 'bg-slate-800'}`} />
                          <span className={depositStatus === 'connecting' ? 'text-white' : ''}>1. Connecting to Secure Gateway</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${depositStatus === 'authorizing' ? 'bg-neon-green animate-ping' : 'bg-slate-800'}`} />
                          <span className={depositStatus === 'authorizing' ? 'text-white' : ''}>2. Acquiring Bank Authorization</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${depositStatus === 'signing' ? 'bg-neon-green animate-ping' : 'bg-slate-800'}`} />
                          <span className={depositStatus === 'signing' ? 'text-white' : ''}>3. Appending Ledger Signatures</span>
                        </div>
                      </div>
                    </div>
                  ) : depositStatus === 'completed' ? (
                    <div className="text-center space-y-3">
                      <CheckCircle2 className="w-14 h-14 text-neon-green mx-auto animate-bounce" />
                      <h3 className="text-lg font-bold font-display text-neon-green neon-glow-green">Deposit settled!</h3>
                      <p className="text-xs text-slate-400 font-mono">
                        Wallet updated with +{formatNaira(parseFloat(depositAmount) || 0)}. Transaction signed and sealed.
                      </p>
                    </div>
                  ) : (
                    <div className="text-center space-y-3">
                      <AlertCircle className="w-14 h-14 text-red-500 mx-auto" />
                      <h3 className="text-lg font-bold font-display text-red-500">Deposit Failed</h3>
                      <p className="text-xs text-slate-400 font-mono">{depositError}</p>
                      <button
                        onClick={() => setDepositStatus('idle')}
                        className="px-4 py-2 bg-slate-900 border border-slate-800 text-xs text-white rounded font-mono"
                      >
                        Try Again
                      </button>
                    </div>
                  )}
                </motion.div>
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

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-mono text-slate-400 mb-2">Payout Method</label>
                      <select
                        value={withdrawMethod}
                        onChange={(e) => setWithdrawMethod(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg py-2.5 px-3 font-mono text-xs text-white focus:outline-none"
                      >
                        <option value="Bank Transfer">Bank Wire (SEPA/ACH)</option>
                        <option value="PayPal">PayPal Balance</option>
                        <option value="Bitcoin wallet">BTC Wallet</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-mono text-slate-400 mb-2">Target Account/Wallet</label>
                      <input
                        type="text"
                        value={withdrawAccount}
                        onChange={(e) => setWithdrawAccount(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg py-2.5 px-3 font-mono text-xs text-white focus:outline-none"
                        required
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-mono text-slate-400 mb-2">Security Transaction PIN</label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                      <input
                        type="password"
                        placeholder="••••"
                        maxLength={4}
                        value={withdrawPin}
                        onChange={(e) => setWithdrawPin(e.target.value)}
                        className="w-full bg-slate-900/80 border border-slate-800 rounded-lg py-2.5 pl-9 pr-4 font-mono text-sm text-white focus:outline-none focus:border-neon-cyan/60"
                        required
                      />
                    </div>
                    <p className="text-[9px] text-slate-500 font-mono mt-1">
                      🔒 Default authorization simulator secure PIN: <strong className="text-neon-cyan">1234</strong>
                    </p>
                  </div>

                  {withdrawError && (
                    <div className="p-3 bg-red-950/40 border border-red-500/30 rounded-lg text-xs text-red-400 font-mono flex items-center gap-2">
                      <AlertCircle className="w-4 h-4" />
                      {withdrawError}
                    </div>
                  )}

                  <button
                    type="submit"
                    className="w-full py-2.5 rounded-lg bg-neon-cyan hover:bg-neon-cyan/90 text-dark-bg font-mono font-bold text-xs transition-all tracking-wider shadow-[0_0_15px_rgba(0,243,255,0.3)] mt-6"
                  >
                    Confirm Payout Routing
                  </button>
                </motion.form>
              ) : withdrawStatus === 'processing' ? (
                <motion.div
                  key="withdraw-processing"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-col items-center justify-center py-12 space-y-4"
                >
                  <Loader2 className="w-12 h-12 text-neon-cyan animate-spin" />
                  <h3 className="text-sm font-semibold font-display text-white">Running Fraud Risk Auditing...</h3>
                  <p className="text-[10px] text-slate-500 font-mono text-center max-w-[280px]">
                    Verifying KYC, verifying anti-cheat balance matching, and broadcasting payout block.
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
                  <h3 className="text-lg font-bold font-display text-neon-cyan neon-glow-cyan">Payout Authorized!</h3>
                  <p className="text-xs text-slate-400 font-mono max-w-[320px] mx-auto">
                    Successfully debited -{formatNaira(parseFloat(withdrawAmount) || 0)}. Funds routed to your target account.
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
