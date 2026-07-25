import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { PublicConfig } from '../types.js';
import { formatNaira } from '../currency.js';
import { apiUrl } from '../config.js';
import { ShieldCheck, Lock, Loader2, CheckCircle2, AlertCircle, Save, Building2, Trophy, Ticket, Gamepad2, Users, Unlock, Landmark, RefreshCw, Wallet, Copy, Check } from 'lucide-react';

interface WithdrawalRequest {
  id: string;
  email: string;
  amount: number;
  bankName: string;
  accountNumber: string;
  accountName: string;
  nameVerified: boolean;
  status: 'pending' | 'paid' | 'rejected';
  createdAt: string;
}

interface AllHandsSeat {
  name: string;
  email: string;
  isBot: boolean;
}

interface AllHandsTableRow {
  roomId: string;
  table: number;
  status: 'waiting' | 'betting' | 'playing' | 'finished';
  players: AllHandsSeat[];
  humans: number;
  canStart: boolean;
}

interface AllHandsTable {
  seats: number;
  tables: AllHandsTableRow[];
  adminStart: boolean;
  forcedWinner: string;
  botRoster: string[];
  prizeActive: boolean;
  prize: number;
  sponsorName: string;
}

interface PlayerRow {
  email: string;
  balance: number;
  tickets: number;
  gamesPlayed: number;
  gamesWon: number;
  verificationStatus: string;
}

interface AdminDashboardProps {
  email: string;
  config: PublicConfig | null;
  onSaved: () => void; // ask App to refetch the public config
}

// Shared field classes (module scope so their identity is stable across renders)
const field = "w-full bg-slate-900 border border-slate-800 rounded-lg py-2 px-3 font-mono text-xs text-white focus:outline-none focus:border-neon-purple/60";
const labelCls = "block text-[11px] font-mono text-slate-400 mb-1.5";

// IMPORTANT: These presentational components MUST live at module scope. If they
// were declared inside AdminDashboard, every render (i.e. every keystroke) would
// create new component identities, forcing React to unmount/remount the inputs —
// which loses focus and scrolls the page. Keeping them here fixes that.
const Section: React.FC<{ icon: React.ReactNode; title: string; children: React.ReactNode }> = ({ icon, title, children }) => (
  <div className="bg-dark-card border border-slate-800 rounded-2xl p-5 shadow-lg space-y-4">
    <h3 className="text-sm font-bold font-display text-white flex items-center gap-2">
      <span className="text-neon-purple">{icon}</span> {title}
    </h3>
    {children}
  </div>
);

const Toggle: React.FC<{ value: boolean; onChange: (v: boolean) => void; label: string }> = ({ value, onChange, label }) => (
  <div className="flex items-center justify-between bg-slate-900/50 rounded-lg px-3 py-2 border border-slate-800">
    <span className="text-[11px] font-mono text-slate-300">{label}</span>
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`px-3 py-1 rounded-lg font-mono font-bold text-[10px] transition-all ${value ? 'bg-neon-green text-[#050505]' : 'bg-slate-800 text-slate-400'}`}
    >
      {value ? 'ON' : 'OFF'}
    </button>
  </div>
);

// Editable shape (everything except isAdmin). adminPasscode is a "new passcode" field.
interface EditableConfig {
  arenaName: string;
  roomName: string;      // the single arena room name
  sponsorName: string;   // tournament sponsor ('' = no tournament)
  sponsorPrize: number;  // tournament cash prize
  fieldSize: number;     // seats the bracket auto-fills to (multiple of 4)
  botRosterText: string; // comma-separated bot names used to fill seats
  casualForcedWinner: string; // bot name that wins casual "Enter Arena" games
  allHandsForcedWinner: string; // name that wins All Hands on Deck games
  allHandsAdminStart: boolean;  // only the admin may start All Hands games
  ticketPrice: number;   // price per ticket
  freeGameEnabled: boolean;
  referralRewardCap: number; // free tickets earnable per player by referring (0 = off)
  turnTimerSeconds: number;
  maxPlayers: number;
  autoBotFill: boolean;
  adminEmailsText: string; // comma-separated in the form
  newPasscode: string;
}

export default function AdminDashboard({ email, config, onSaved }: AdminDashboardProps) {
  const [passcode, setPasscode] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [form, setForm] = useState<EditableConfig | null>(null);

  const isAdmin = !!config?.isAdmin;

  // The admin/verify + admin/config responses return the RAW config (legacy
  // field names), so read from those and map to our simplified form shape.
  const toEditable = (c: any): EditableConfig => ({
    arenaName: c.arenaName ?? '',
    roomName: c.roomName ?? c.defaultRoomId ?? '',
    sponsorName: c.sponsorName ?? c.fixedSponsorName ?? '',
    sponsorPrize: Number(c.sponsorPrize ?? c.fixedPrize ?? 0),
    fieldSize: Number(c.tournamentFieldSize ?? 16),
    botRosterText: Array.isArray(c.botRoster) ? c.botRoster.join(', ') : '',
    casualForcedWinner: c.casualForcedWinner ?? '',
    allHandsForcedWinner: c.allHandsForcedWinner ?? '',
    allHandsAdminStart: c.allHandsAdminStart !== false,
    ticketPrice: Number(c.ticketPrice ?? c.ticketPackPrice ?? 0),
    freeGameEnabled: !!c.freeGameEnabled,
    referralRewardCap: Number(c.referralRewardCap ?? 10),
    turnTimerSeconds: Number(c.turnTimerSeconds ?? 20),
    maxPlayers: Number(c.maxPlayers ?? 4),
    autoBotFill: !!c.autoBotFill,
    adminEmailsText: Array.isArray(c.adminEmails) ? c.adminEmails.join(', ') : email,
    newPasscode: '',
  });

  // --- Withdrawal queue + player roster (loaded after unlocking) ------------
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([]);
  const [wdFilter, setWdFilter] = useState<'pending' | 'all'>('pending');
  const [wdBusy, setWdBusy] = useState<string | null>(null);
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [playerCount, setPlayerCount] = useState(0);
  const [opsError, setOpsError] = useState('');
  const [opsLoading, setOpsLoading] = useState(false);
  const [copied, setCopied] = useState('');

  const adminPost = async (path: string, body: Record<string, unknown>) => {
    const res = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, passcode, ...body }),
    });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  };

  // --- All Hands live table -------------------------------------------------
  const [ahTable, setAhTable] = useState<AllHandsTable | null>(null);
  const [ahStarting, setAhStarting] = useState<string | null>(null);
  const [ahError, setAhError] = useState('');

  const loadAhTable = async () => {
    try {
      const { ok, data } = await adminPost('/api/admin/all-hands/table', {});
      if (ok) setAhTable(data);
    } catch { /* transient — the poll will try again */ }
  };

  // Poll while the panel is unlocked so the admin watches players sit down live.
  useEffect(() => {
    if (!unlocked) return;
    loadAhTable();
    const id = window.setInterval(loadAhTable, 4000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked, passcode]);

  // Place / remove a specific bot at a table before it starts.
  const addBot = async (roomId: string, name: string) => {
    setAhError('');
    const { ok, data } = await adminPost('/api/admin/all-hands/add-bot', { roomId, name });
    if (!ok) setAhError(data.error || 'Could not seat that bot.');
    await loadAhTable();
  };

  const removeBot = async (roomId: string, name: string) => {
    setAhError('');
    const { ok, data } = await adminPost('/api/admin/all-hands/remove-bot', { roomId, name });
    if (!ok) setAhError(data.error || 'Could not remove that bot.');
    await loadAhTable();
  };

  // Set the winner by name — works for a seated player OR a roster bot that
  // isn't seated yet (it gets a guaranteed seat when a table starts).
  const pickWinner = async (name: string) => {
    setAhError('');
    const { ok, data } = await adminPost('/api/admin/all-hands/winner', { name });
    if (!ok) setAhError(data.error || 'Could not set the winner.');
    update('allHandsForcedWinner', name);
    await loadAhTable();
  };

  const startAllHands = async (roomId: string) => {
    setAhStarting(roomId);
    setAhError('');
    try {
      const { ok, data } = await adminPost('/api/admin/all-hands/start', { roomId });
      if (!ok) setAhError(data.error || 'Could not start the game.');
      await loadAhTable();
    } catch {
      setAhError('Could not reach the admin service.');
    } finally {
      setAhStarting(null);
    }
  };

  const loadOps = async (status: 'pending' | 'all' = wdFilter) => {
    setOpsLoading(true);
    setOpsError('');
    try {
      const [wd, pl] = await Promise.all([
        adminPost('/api/admin/withdrawals', { status }),
        adminPost('/api/admin/players', {}),
      ]);
      if (wd.ok) setWithdrawals(wd.data.withdrawals || []);
      if (pl.ok) { setPlayers(pl.data.players || []); setPlayerCount(pl.data.count || 0); }
      if (!wd.ok || !pl.ok) setOpsError('Could not load the latest data.');
    } catch {
      setOpsError('Could not reach the admin service.');
    } finally {
      setOpsLoading(false);
    }
  };

  const resolveWithdrawal = async (id: string, action: 'paid' | 'rejected') => {
    setWdBusy(id);
    setOpsError('');
    try {
      const { ok, data } = await adminPost('/api/admin/withdrawals/resolve', { id, action });
      if (!ok) setOpsError(data.error || 'Could not update that request.');
      await loadOps();
    } catch {
      setOpsError('Could not reach the admin service.');
    } finally {
      setWdBusy(null);
    }
  };

  const copyValue = (value: string) => {
    navigator.clipboard?.writeText(value).catch(() => {});
    setCopied(value);
    setTimeout(() => setCopied(''), 1500);
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setVerifying(true);
    try {
      const res = await fetch(apiUrl('/api/admin/verify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, passcode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Verification failed.');
      } else {
        setForm(toEditable(data.config));
        setUnlocked(true);
        loadOps(); // pull the withdrawal queue and player roster straight away
      }
    } catch {
      setError('Could not reach the admin service.');
    } finally {
      setVerifying(false);
    }
  };

  const update = <K extends keyof EditableConfig>(key: K, value: EditableConfig[K]) => {
    setForm(prev => (prev ? { ...prev, [key]: value } : prev));
    setSaveStatus('idle');
  };

  // The casual predetermined winner applies INSTANTLY (no "Save" needed), like
  // the bracket picker — it doesn't need to wait for the settings form to save.
  const setCasualWinner = async (name: string) => {
    update('casualForcedWinner', name);
    try {
      await fetch(apiUrl('/api/tournament/casual-winner'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, passcode, name }),
      });
    } catch { /* ignore */ }
  };

  // The All Hands preselected winner also applies INSTANTLY (no "Save" needed).
  const setAllHandsWinner = async (name: string) => {
    update('allHandsForcedWinner', name);
    try {
      await fetch(apiUrl('/api/all-hands/force-winner'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, passcode, name }),
      });
    } catch { /* ignore */ }
  };

  const handleSave = async () => {
    if (!form) return;
    setError('');
    setSaveStatus('saving');
    const payload = {
      arenaName: form.arenaName,
      roomName: form.roomName,
      sponsorName: form.sponsorName.trim(),
      sponsorPrize: form.sponsorPrize,
      tournamentFieldSize: form.fieldSize,
      botRoster: form.botRosterText.split(',').map(s => s.trim()).filter(Boolean),
      casualForcedWinner: form.casualForcedWinner.trim(),
      allHandsForcedWinner: form.allHandsForcedWinner.trim(),
      allHandsAdminStart: form.allHandsAdminStart,
      ticketPrice: form.ticketPrice,
      freeGameEnabled: form.freeGameEnabled,
      referralRewardCap: form.referralRewardCap,
      turnTimerSeconds: form.turnTimerSeconds,
      maxPlayers: form.maxPlayers,
      autoBotFill: form.autoBotFill,
      adminEmails: form.adminEmailsText.split(',').map(s => s.trim()).filter(Boolean),
      ...(form.newPasscode.trim() ? { adminPasscode: form.newPasscode.trim() } : {}),
    };
    try {
      const res = await fetch(apiUrl('/api/admin/config'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, passcode: form.newPasscode.trim() || passcode, config: payload }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to save settings.');
        setSaveStatus('idle');
      } else {
        // Keep working with the (possibly new) passcode for subsequent saves
        if (form.newPasscode.trim()) setPasscode(form.newPasscode.trim());
        setForm(toEditable(data.config));
        setSaveStatus('saved');
        onSaved();
        setTimeout(() => setSaveStatus('idle'), 2500);
      }
    } catch {
      setError('Could not reach the admin service.');
      setSaveStatus('idle');
    }
  };

  // Not an admin account
  if (!isAdmin) {
    return (
      <div className="w-full max-w-md mx-auto py-16 text-center">
        <div className="h-16 w-16 bg-red-500/10 border border-red-500/30 rounded-2xl flex items-center justify-center mb-6 mx-auto">
          <Lock className="w-8 h-8 text-red-400" />
        </div>
        <h3 className="text-lg font-bold font-display text-white">Admin Access Only</h3>
        <p className="text-xs text-slate-400 mt-2 font-mono leading-relaxed">
          The account <strong className="text-slate-300">{email}</strong> is not an administrator.
          Sign in with an admin email to manage arena settings.
        </p>
      </div>
    );
  }

  // Admin, but passcode not yet entered
  if (!unlocked || !form) {
    return (
      <div className="w-full max-w-md mx-auto py-12">
        <motion.form
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          onSubmit={handleUnlock}
          className="bg-dark-card border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4"
        >
          <div className="text-center">
            <div className="h-14 w-14 bg-neon-purple/10 border border-neon-purple/30 rounded-2xl flex items-center justify-center mb-4 mx-auto">
              <ShieldCheck className="w-7 h-7 text-neon-purple" />
            </div>
            <h3 className="text-lg font-bold font-display text-white">Admin Dashboard</h3>
            <p className="text-[11px] text-slate-500 font-mono mt-1">Enter your admin passcode to unlock settings.</p>
          </div>

          <div>
            <label className="block text-xs font-mono text-slate-400 mb-1.5">Admin Passcode</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type="password"
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg py-2.5 pl-9 pr-4 font-mono text-sm text-white focus:outline-none focus:border-neon-purple/60"
                required
              />
            </div>
          </div>

          {error && (
            <div className="p-3 bg-red-950/40 border border-red-500/30 rounded-lg text-xs text-red-400 font-mono flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
            </div>
          )}

          <button
            type="submit"
            disabled={verifying}
            className="w-full py-2.5 rounded-lg bg-neon-purple hover:bg-neon-purple/90 text-white font-mono font-bold text-xs transition-all shadow-[0_0_15px_rgba(157,78,221,0.3)] disabled:opacity-60 flex items-center justify-center gap-2"
          >
            {verifying ? <><Loader2 className="w-4 h-4 animate-spin" /> Verifying...</> : <><Unlock className="w-4 h-4" /> Unlock Dashboard</>}
          </button>
        </motion.form>
      </div>
    );
  }

  // Unlocked settings editor
  return (
    <div className="w-full max-w-3xl mx-auto space-y-5" id="admin_dashboard">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-neon-purple/10 border border-neon-purple/30 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-neon-purple" />
          </div>
          <div>
            <h2 className="text-md font-bold font-display text-white tracking-tight">Admin Dashboard</h2>
            <p className="text-[10px] text-slate-500 font-mono">Signed in as {email}</p>
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={saveStatus === 'saving'}
          className="px-4 py-2 rounded-lg bg-neon-purple hover:bg-neon-purple/90 text-white font-mono font-bold text-xs transition-all shadow-[0_0_12px_rgba(157,78,221,0.3)] disabled:opacity-60 flex items-center gap-2"
        >
          {saveStatus === 'saving' ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving...</>
            : saveStatus === 'saved' ? <><CheckCircle2 className="w-4 h-4" /> Saved</>
            : <><Save className="w-4 h-4" /> Save Settings</>}
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-950/40 border border-red-500/30 rounded-lg text-xs text-red-400 font-mono flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {/* Arena / room */}
      <Section icon={<Building2 className="w-4 h-4" />} title="Arena & Room">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Arena Name</label>
            <input className={field} value={form.arenaName} onChange={(e) => update('arenaName', e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Arena Room Name</label>
            <input className={field} value={form.roomName} onChange={(e) => update('roomName', e.target.value)} />
            <p className="text-[10px] text-slate-500 font-mono mt-1">Everyone plays in this one room.</p>
          </div>
        </div>
      </Section>

      {/* Game — All Hands on Deck (sponsor + prize that fund the game) */}
      <Section icon={<Trophy className="w-4 h-4" />} title="Game — All Hands on Deck">
        {(() => {
          const active = form.sponsorName.trim().length > 0 && form.sponsorPrize > 0;
          return (
            <div className={`flex items-center gap-2 rounded-lg px-3 py-2 border text-[11px] font-mono ${active ? 'border-neon-green/40 bg-neon-green/5 text-neon-green' : 'border-slate-700 bg-slate-900/40 text-slate-400'}`}>
              <span className={`w-2 h-2 rounded-full ${active ? 'bg-neon-green' : 'bg-slate-500'}`} />
              {active ? 'All Hands on Deck is LIVE — players can enter.' : 'No prize set — players see “No game available”.'}
            </div>
          );
        })()}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Sponsor Name</label>
            <input className={field} value={form.sponsorName} onChange={(e) => update('sponsorName', e.target.value)} placeholder="e.g. IgniTech" />
          </div>
          <div>
            <label className={labelCls}>Cash Prize (₦) — {formatNaira(form.sponsorPrize)}</label>
            <input type="number" className={field} value={form.sponsorPrize} onChange={(e) => update('sponsorPrize', Number(e.target.value))} min={0} />
          </div>
        </div>
        <p className="text-[10px] text-slate-500 font-mono">
          Set a sponsor name and a prize above 0 to open the game. The prize goes to the last player standing in All Hands on Deck. Clear the sponsor name (or set the prize to 0) to close it.
        </p>
      </Section>

      {/* Ticket economy */}
      <Section icon={<Ticket className="w-4 h-4" />} title="Ticket Economy">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Price per Ticket (₦) — {formatNaira(form.ticketPrice)}</label>
            <input type="number" className={field} value={form.ticketPrice} onChange={(e) => update('ticketPrice', Number(e.target.value))} min={0} />
          </div>
          <div>
            <label className={labelCls}>Purchase Limits</label>
            <div className="w-full bg-slate-900/40 border border-slate-800 rounded-lg py-2 px-3 font-mono text-xs text-slate-400">
              Players buy 4–64 tickets
            </div>
          </div>
        </div>
        <Toggle value={form.freeGameEnabled} onChange={(v) => update('freeGameEnabled', v)} label="Give new players 1 free game" />

        <div>
          <label className={labelCls}>
            Referral Reward Cap — {form.referralRewardCap === 0
              ? 'referral rewards paused'
              : `up to ${form.referralRewardCap} free ticket${form.referralRewardCap === 1 ? '' : 's'} per player`}
          </label>
          <input
            type="number"
            className={field}
            value={form.referralRewardCap}
            onChange={(e) => update('referralRewardCap', Number(e.target.value))}
            min={0}
            max={1000}
          />
          <p className="text-[10px] text-slate-500 font-mono mt-1.5 leading-relaxed">
            A player earns 1 free ticket each time someone who signed up through their link buys
            tickets. Set to 0 to pause payouts — links keep working and queued referrals stay
            eligible if you raise it again. Already-earned tickets are never taken back.
          </p>
        </div>
      </Section>

      {/* Gameplay */}
      <Section icon={<Gamepad2 className="w-4 h-4" />} title="Gameplay Rules">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Turn Timer (seconds)</label>
            <input type="number" className={field} value={form.turnTimerSeconds} onChange={(e) => update('turnTimerSeconds', Number(e.target.value))} min={5} max={120} />
          </div>
          <div>
            <label className={labelCls}>Max Players per Table</label>
            <select className={field} value={form.maxPlayers} onChange={(e) => update('maxPlayers', Number(e.target.value))}>
              {[2, 3, 4].map(n => <option key={n} value={n}>{n} players</option>)}
            </select>
          </div>
        </div>
        <Toggle value={form.autoBotFill} onChange={(v) => update('autoBotFill', v)} label="Auto-fill empty seats with AI opponents" />
      </Section>

      {/* Bots + casual rigging (TEST) */}
      <Section icon={<Gamepad2 className="w-4 h-4" />} title="Bots — TEST">
        <div>
          <label className={labelCls}>Bot Roster (comma-separated names)</label>
          <textarea
            className={`${field} h-16 resize-none`}
            value={form.botRosterText}
            placeholder="Chidi, Amara, Tunde, Zainab, Emeka…"
            onChange={(e) => update('botRosterText', e.target.value)}
          />
          <p className="text-[10px] text-slate-500 font-mono mt-1">These bots fill empty seats in both the casual game and the bracket. Leave blank for the defaults.</p>
        </div>
        {(() => {
          const roster = form.botRosterText.split(',').map(s => s.trim()).filter(Boolean);
          return (
            <div>
              <label className={labelCls}>Casual game — predetermined winner</label>
              <input
                className={field}
                value={form.casualForcedWinner}
                placeholder="Type or tap a bot name"
                onChange={(e) => update('casualForcedWinner', e.target.value)}
                onBlur={(e) => setCasualWinner(e.target.value.trim())}
              />
              <div className="flex flex-wrap gap-1 mt-1.5">
                <button type="button" onClick={() => setCasualWinner('')} className={`px-2 py-0.5 rounded text-[10px] font-mono border ${!form.casualForcedWinner ? 'border-slate-600 bg-slate-800 text-white' : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:text-white'}`}>None</button>
                {roster.map(n => (
                  <button key={n} type="button" onClick={() => setCasualWinner(n)} className={`px-2 py-0.5 rounded text-[10px] font-mono border ${form.casualForcedWinner === n ? 'border-amber-500 bg-amber-500/15 text-amber-200' : 'border-slate-800 bg-slate-900/40 text-slate-300 hover:border-amber-500/50'}`}>
                    {form.casualForcedWinner === n && '✓ '}{n}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-slate-500 font-mono mt-1">Legacy casual-game rig (the casual game is retired). For All Hands on Deck, use the picker below.</p>
            </div>
          );
        })()}
        {(() => {
          const roster = form.botRosterText.split(',').map(s => s.trim()).filter(Boolean);
          return (
            <div>
              <label className={labelCls}>All Hands on Deck — preselected winner</label>
              <input
                className={field}
                value={form.allHandsForcedWinner}
                placeholder="Type a bot name or a player's nickname"
                onChange={(e) => update('allHandsForcedWinner', e.target.value)}
                onBlur={(e) => setAllHandsWinner(e.target.value.trim())}
              />
              <div className="flex flex-wrap gap-1 mt-1.5">
                <button type="button" onClick={() => setAllHandsWinner('')} className={`px-2 py-0.5 rounded text-[10px] font-mono border ${!form.allHandsForcedWinner ? 'border-slate-600 bg-slate-800 text-white' : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:text-white'}`}>None</button>
                {roster.map(n => (
                  <button key={n} type="button" onClick={() => setAllHandsWinner(n)} className={`px-2 py-0.5 rounded text-[10px] font-mono border ${form.allHandsForcedWinner === n ? 'border-amber-500 bg-amber-500/15 text-amber-200' : 'border-slate-800 bg-slate-900/40 text-slate-300 hover:border-amber-500/50'}`}>
                    {form.allHandsForcedWinner === n && '✓ '}{n}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-slate-500 font-mono mt-1">Applies instantly and <strong>silently</strong>: this player is protected from every knock-out and wins All Hands on Deck (last one standing). No crown, no mark on the table, no chat announcement — only you see the pick, here. Use a bot name (guaranteed a seat) or a seated player's exact nickname.</p>
            </div>
          );
        })()}
        <p className="text-[9px] text-amber-500/80 font-mono">⚠️ Turn these off before real players/payments.</p>
      </Section>

      {/* All Hands on Deck — live table the admin starts by hand */}
      <Section icon={<Gamepad2 className="w-4 h-4" />} title="All Hands on Deck — Live Table">
        <Toggle
          value={form.allHandsAdminStart}
          onChange={(v) => update('allHandsAdminStart', v)}
          label="Only I can start the game (needs Save)"
        />

        {!form.allHandsAdminStart && (
          <p className="text-[10px] font-mono text-amber-500/90">
            ⚠️ Off: the game starts by itself once enough players sit down, and any seated player can
            force it. You won't get a chance to pick a winner first.
          </p>
        )}

        {ahError && (
          <div className="p-2.5 bg-red-950/40 border border-red-500/30 rounded-lg text-[11px] text-red-400 font-mono flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {ahError}
          </div>
        )}

        {/* Selected winner shows here too — they may be on any table, or not
            seated anywhere yet. */}
        {!!ahTable?.forcedWinner && (
          <div className="flex items-center justify-between bg-amber-500/5 border border-amber-500/30 rounded-lg px-3 py-2">
            <span className="text-[10px] font-mono text-amber-300">
              Preselected winner: <strong>{ahTable.forcedWinner}</strong> — wins whichever table they sit at.
            </span>
            <button
              type="button"
              onClick={() => pickWinner('')}
              className="text-[10px] font-mono text-slate-400 hover:text-white cursor-pointer flex-shrink-0 ml-2"
            >
              Clear
            </button>
          </div>
        )}

        {/* Pick any roster bot as the winner, seated or not. An unseated bot is
            given a guaranteed seat on whichever table starts next. */}
        {!!ahTable?.botRoster?.length && (
          <div>
            <span className="text-[10px] font-mono text-slate-500 uppercase block mb-1.5">
              Make a bot the winner (seats itself when a table starts)
            </span>
            <div className="flex flex-wrap gap-1">
              {ahTable.botRoster.map(n => (
                <button
                  key={`rosterwin-${n}`}
                  type="button"
                  onClick={() => pickWinner(n)}
                  className={`px-2 py-0.5 rounded text-[10px] font-mono border ${ahTable.forcedWinner === n ? 'border-amber-500 bg-amber-500/15 text-amber-200' : 'border-slate-800 bg-slate-900/40 text-slate-300 hover:border-amber-500/50'}`}
                >
                  {ahTable.forcedWinner === n && '✓ '}{n}
                </button>
              ))}
            </div>
          </div>
        )}

        {!ahTable?.tables?.length ? (
          <p className="text-[11px] font-mono text-slate-500 py-3 text-center">
            No tables open yet — one opens when the first player enters.
          </p>
        ) : (
          <div className="space-y-3">
            {ahTable.tables.map(t => (
              <div key={t.roomId} className="bg-slate-900/60 border border-slate-800 rounded-xl p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-[10px] font-mono text-slate-500 uppercase block">Table {t.table}</span>
                    <span className={`text-md font-bold font-display ${
                      t.status === 'playing' ? 'text-neon-green'
                        : t.status === 'betting' ? 'text-amber-400' : 'text-slate-400'
                    }`}>
                      {t.status === 'playing' ? 'Game in progress'
                        : t.status === 'betting' ? 'Players waiting'
                        : t.status === 'finished' ? 'Finished'
                        : 'Open — no one seated'}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] font-mono text-slate-500 uppercase block">Real players</span>
                    <span className="text-md font-bold font-display text-white">
                      {t.humans}<span className="text-slate-600 text-sm"> / {ahTable.seats}</span>
                    </span>
                  </div>
                </div>

                {!t.players.length ? (
                  <p className="text-[11px] font-mono text-slate-500">Nobody seated.</p>
                ) : (
                  <div className="space-y-1">
                    {t.players.map((p, i) => (
                      <div key={`${t.roomId}-${p.name}-${i}`} className="flex items-center justify-between bg-slate-950/60 rounded-lg px-2.5 py-1.5 border border-slate-800/70">
                        <div className="min-w-0">
                          <span className="text-[11px] font-mono text-white">{p.name}</span>
                          {p.isBot
                            ? <span className="text-[9px] font-mono text-slate-600 ml-1.5">AI</span>
                            : <span className="text-[9px] font-mono text-slate-600 ml-1.5 truncate">{p.email}</span>}
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {ahTable.forcedWinner === p.name && (
                            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/40">
                              WILL WIN
                            </span>
                          )}
                          {p.isBot && t.status !== 'playing' && (
                            <button
                              type="button"
                              onClick={() => removeBot(t.roomId, p.name)}
                              title="Remove this bot"
                              className="text-[10px] font-mono text-slate-500 hover:text-red-400 cursor-pointer px-1"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Seat a specific bot at THIS table */}
                {t.status !== 'playing' && t.players.length < ahTable.seats && (
                  <div>
                    <span className="text-[10px] font-mono text-slate-500 uppercase block mb-1.5">
                      Add a bot to table {t.table}
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {ahTable.botRoster
                        .filter(n => !t.players.some(p => p.name === n))
                        .map(n => (
                          <button
                            key={`addbot-${t.roomId}-${n}`}
                            type="button"
                            onClick={() => addBot(t.roomId, n)}
                            className="px-2 py-0.5 rounded text-[10px] font-mono border border-slate-800 bg-slate-900/40 text-slate-300 hover:border-neon-cyan/50 hover:text-neon-cyan cursor-pointer"
                          >
                            + {n}
                          </button>
                        ))}
                      {!ahTable.botRoster.filter(n => !t.players.some(p => p.name === n)).length && (
                        <span className="text-[10px] font-mono text-slate-600">Every roster bot is already seated here.</span>
                      )}
                    </div>
                  </div>
                )}

                {/* Pick the winner from whoever is seated at THIS table */}
                {!!t.players.length && t.status !== 'playing' && (
                  <div>
                    <span className="text-[10px] font-mono text-slate-500 uppercase block mb-1.5">
                      Preselect the winner
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {t.players.map((p, i) => (
                        <button
                          key={`pick-${t.roomId}-${p.name}-${i}`}
                          type="button"
                          onClick={() => pickWinner(p.name)}
                          className={`px-2 py-0.5 rounded text-[10px] font-mono border ${ahTable.forcedWinner === p.name ? 'border-amber-500 bg-amber-500/15 text-amber-200' : 'border-slate-800 bg-slate-900/40 text-slate-300 hover:border-amber-500/50'}`}
                        >
                          {ahTable.forcedWinner === p.name && '✓ '}{p.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => startAllHands(t.roomId)}
                  disabled={ahStarting === t.roomId || !t.canStart}
                  className="w-full py-2 rounded-lg bg-neon-green/10 border border-neon-green/40 text-neon-green font-mono text-xs font-bold disabled:opacity-40 cursor-pointer flex items-center justify-center gap-2"
                >
                  {ahStarting === t.roomId
                    ? <><Loader2 className="w-4 h-4 animate-spin" /> Starting…</>
                    : t.status === 'playing'
                      ? 'Game already running'
                      : <><Gamepad2 className="w-4 h-4" /> Start table {t.table}</>}
                </button>
              </div>
            ))}
          </div>
        )}

        <p className="text-[9px] text-slate-600 font-mono">
          A 5th player opens table 2 rather than waiting. Empty seats fill with AI when you start.
          Updates every few seconds — no need to refresh.
        </p>
      </Section>

      {/* Withdrawal requests — the queue an admin actually pays out by hand */}
      <Section icon={<Landmark className="w-4 h-4" />} title="Withdrawal Requests">
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-1.5">
            {(['pending', 'all'] as const).map(f => (
              <button
                key={f}
                type="button"
                onClick={() => { setWdFilter(f); loadOps(f); }}
                className={`px-3 py-1 rounded-lg font-mono text-[10px] font-bold transition-all cursor-pointer ${
                  wdFilter === f ? 'bg-neon-cyan/15 border border-neon-cyan/40 text-neon-cyan' : 'bg-slate-900 border border-slate-800 text-slate-400'
                }`}
              >
                {f === 'pending' ? 'Pending' : 'All'}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => loadOps()}
            disabled={opsLoading}
            className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white font-mono text-[10px] disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-3 h-3 ${opsLoading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>

        {opsError && (
          <div className="p-2.5 bg-red-950/40 border border-red-500/30 rounded-lg text-[11px] text-red-400 font-mono flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {opsError}
          </div>
        )}

        {withdrawals.length === 0 ? (
          <p className="text-[11px] font-mono text-slate-500 py-3 text-center">
            {opsLoading ? 'Loading…' : wdFilter === 'pending' ? 'No pending withdrawal requests.' : 'No withdrawal requests yet.'}
          </p>
        ) : (
          <div className="space-y-2">
            {withdrawals.map(w => (
              <div key={w.id} className="bg-slate-900/60 border border-slate-800 rounded-xl p-3 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-lg font-bold font-display text-neon-cyan">{formatNaira(w.amount)}</div>
                    <div className="text-[10px] font-mono text-slate-500 truncate">{w.email}</div>
                  </div>
                  <span className={`text-[9px] font-mono px-2 py-0.5 rounded flex-shrink-0 ${
                    w.status === 'pending' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                      : w.status === 'paid' ? 'bg-neon-green/10 text-neon-green border border-neon-green/30'
                      : 'bg-red-500/10 text-red-400 border border-red-500/30'
                  }`}>
                    {w.status.toUpperCase()}
                  </span>
                </div>

                {/* What the admin needs to actually send the money */}
                <div className="bg-slate-950/70 rounded-lg p-2.5 border border-slate-800/70 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-mono text-slate-500">Account name</span>
                    <span className="text-[11px] font-mono text-white truncate">{w.accountName || '—'}</span>
                  </div>
                  {/* Whether the BANK confirmed this name, or the player typed it */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-mono text-slate-500">Name check</span>
                    {w.nameVerified ? (
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-neon-green/10 text-neon-green border border-neon-green/30">
                        CONFIRMED BY BANK
                      </span>
                    ) : (
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/40">
                        ⚠ NOT VERIFIED — CHECK FIRST
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-mono text-slate-500">Account number</span>
                    <button
                      type="button"
                      onClick={() => copyValue(w.accountNumber)}
                      className="text-[11px] font-mono text-neon-cyan flex items-center gap-1 cursor-pointer hover:opacity-80"
                    >
                      {w.accountNumber || '—'}
                      {copied === w.accountNumber ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    </button>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-mono text-slate-500">Bank</span>
                    <span className="text-[11px] font-mono text-white truncate">{w.bankName || '—'}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-mono text-slate-500">Requested</span>
                    <span className="text-[10px] font-mono text-slate-400">
                      {new Date(w.createdAt).toLocaleString('en-NG')}
                    </span>
                  </div>
                </div>

                {w.status === 'pending' && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => resolveWithdrawal(w.id, 'paid')}
                      disabled={wdBusy === w.id}
                      className="flex-1 py-2 rounded-lg bg-neon-green/10 border border-neon-green/40 text-neon-green font-mono text-[11px] font-bold disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1.5"
                    >
                      {wdBusy === w.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                      Mark Paid
                    </button>
                    <button
                      type="button"
                      onClick={() => resolveWithdrawal(w.id, 'rejected')}
                      disabled={wdBusy === w.id}
                      className="flex-1 py-2 rounded-lg bg-red-500/10 border border-red-500/40 text-red-400 font-mono text-[11px] font-bold disabled:opacity-50 cursor-pointer"
                    >
                      Reject &amp; Refund
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="text-[9px] text-slate-600 font-mono">
          Payouts are not automated. Send the money from your bank or Paystack dashboard, then mark it
          paid. Rejecting returns the amount to the player's wallet.
        </p>
      </Section>

      {/* Player roster — headcount, tickets and wallet balances */}
      <Section icon={<Wallet className="w-4 h-4" />} title={`Players — ${playerCount}`}>
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-slate-900/60 rounded-lg p-2.5 border border-slate-800">
            <span className="text-[9px] font-mono text-slate-500 uppercase block">Players</span>
            <span className="text-xl font-bold font-display text-white">{playerCount}</span>
          </div>
          <div className="bg-slate-900/60 rounded-lg p-2.5 border border-slate-800">
            <span className="text-[9px] font-mono text-slate-500 uppercase block">Tickets held</span>
            <span className="text-xl font-bold font-display text-neon-purple">
              {players.reduce((s, p) => s + p.tickets, 0)}
            </span>
          </div>
          <div className="bg-slate-900/60 rounded-lg p-2.5 border border-slate-800">
            <span className="text-[9px] font-mono text-slate-500 uppercase block">Wallets total</span>
            <span className="text-xl font-bold font-display text-neon-green">
              {formatNaira(players.reduce((s, p) => s + p.balance, 0))}
            </span>
          </div>
        </div>

        {players.length === 0 ? (
          <p className="text-[11px] font-mono text-slate-500 py-3 text-center">
            {opsLoading ? 'Loading…' : 'No players yet.'}
          </p>
        ) : (
          <div className="max-h-80 overflow-y-auto -mx-1 px-1">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 bg-dark-card">
                <tr className="text-[9px] font-mono text-slate-500 uppercase">
                  <th className="py-1.5 pr-2">Player</th>
                  <th className="py-1.5 px-1 text-right">Tickets</th>
                  <th className="py-1.5 pl-2 text-right">Wallet</th>
                </tr>
              </thead>
              <tbody>
                {players.map(p => (
                  <tr key={p.email} className="border-t border-slate-900">
                    <td className="py-1.5 pr-2">
                      <div className="text-[11px] font-mono text-white truncate max-w-[180px]">{p.email}</div>
                      <div className="text-[9px] font-mono text-slate-600">
                        {p.gamesPlayed} played · {p.gamesWon} won
                        {p.verificationStatus === 'verified' && <span className="text-neon-green"> · KYC ✓</span>}
                      </div>
                    </td>
                    <td className="py-1.5 px-1 text-right text-[11px] font-mono text-neon-purple">{p.tickets}</td>
                    <td className="py-1.5 pl-2 text-right text-[11px] font-mono text-neon-green">{formatNaira(p.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Access control */}
      <Section icon={<Users className="w-4 h-4" />} title="Admin Access">
        <div>
          <label className={labelCls}>Admin Emails (comma-separated)</label>
          <textarea className={`${field} h-16 resize-none`} value={form.adminEmailsText} onChange={(e) => update('adminEmailsText', e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>Change Passcode (leave blank to keep current)</label>
          <input type="password" className={field} value={form.newPasscode} onChange={(e) => update('newPasscode', e.target.value)} placeholder="••••••••" />
        </div>
      </Section>
    </div>
  );
}
