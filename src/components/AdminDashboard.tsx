import React, { useState } from 'react';
import { motion } from 'motion/react';
import { PublicConfig } from '../types.js';
import { formatNaira } from '../currency.js';
import { apiUrl } from '../config.js';
import { ShieldCheck, Lock, Loader2, CheckCircle2, AlertCircle, Save, Building2, Trophy, Ticket, Gamepad2, Users, Unlock } from 'lucide-react';

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
      className={`px-3 py-1 rounded-lg font-mono font-bold text-[10px] transition-all ${value ? 'bg-neon-green text-dark-bg' : 'bg-slate-800 text-slate-400'}`}
    >
      {value ? 'ON' : 'OFF'}
    </button>
  </div>
);

// Editable shape (everything except isAdmin). adminPasscode is a "new passcode" field.
interface EditableConfig {
  arenaName: string;
  defaultRoomId: string;
  prizeMode: 'fixed' | 'random';
  fixedSponsorName: string;
  fixedPrize: number;
  sponsorPoolText: string; // comma-separated in the form
  prizeMin: number;
  prizeMax: number;
  ticketPackPrice: number;
  ticketPackSize: number;
  freeGameEnabled: boolean;
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

  const toEditable = (c: any): EditableConfig => ({
    arenaName: c.arenaName ?? '',
    defaultRoomId: c.defaultRoomId ?? '',
    prizeMode: c.prizeMode === 'fixed' ? 'fixed' : 'random',
    fixedSponsorName: c.fixedSponsorName ?? '',
    fixedPrize: Number(c.fixedPrize ?? 0),
    sponsorPoolText: Array.isArray(c.sponsorPool) ? c.sponsorPool.join(', ') : '',
    prizeMin: Number(c.prizeMin ?? 0),
    prizeMax: Number(c.prizeMax ?? 0),
    ticketPackPrice: Number(c.ticketPackPrice ?? 0),
    ticketPackSize: Number(c.ticketPackSize ?? 0),
    freeGameEnabled: !!c.freeGameEnabled,
    turnTimerSeconds: Number(c.turnTimerSeconds ?? 20),
    maxPlayers: Number(c.maxPlayers ?? 4),
    autoBotFill: !!c.autoBotFill,
    adminEmailsText: Array.isArray(c.adminEmails) ? c.adminEmails.join(', ') : email,
    newPasscode: '',
  });

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

  const handleSave = async () => {
    if (!form) return;
    setError('');
    setSaveStatus('saving');
    const payload = {
      arenaName: form.arenaName,
      defaultRoomId: form.defaultRoomId,
      prizeMode: form.prizeMode,
      fixedSponsorName: form.fixedSponsorName,
      fixedPrize: form.fixedPrize,
      sponsorPool: form.sponsorPoolText.split(',').map(s => s.trim()).filter(Boolean),
      prizeMin: form.prizeMin,
      prizeMax: form.prizeMax,
      ticketPackPrice: form.ticketPackPrice,
      ticketPackSize: form.ticketPackSize,
      freeGameEnabled: form.freeGameEnabled,
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
            <label className={labelCls}>Default Room ID</label>
            <input className={field} value={form.defaultRoomId} onChange={(e) => update('defaultRoomId', e.target.value)} />
          </div>
        </div>
      </Section>

      {/* Sponsor & prize */}
      <Section icon={<Trophy className="w-4 h-4" />} title="Sponsor & Cash Prize">
        <div>
          <label className={labelCls}>Prize Mode</label>
          <div className="flex gap-2">
            {(['fixed', 'random'] as const).map(mode => (
              <button
                key={mode}
                type="button"
                onClick={() => update('prizeMode', mode)}
                className={`flex-1 py-2 rounded-lg font-mono text-xs font-bold border transition-all ${
                  form.prizeMode === mode
                    ? 'border-neon-purple bg-neon-purple/10 text-neon-purple'
                    : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:text-white'
                }`}
              >
                {mode === 'fixed' ? 'Fixed' : 'Random Pool'}
              </button>
            ))}
          </div>
        </div>

        {form.prizeMode === 'fixed' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Sponsor Name</label>
              <input className={field} value={form.fixedSponsorName} onChange={(e) => update('fixedSponsorName', e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Cash Prize (₦) — {formatNaira(form.fixedPrize)}</label>
              <input type="number" className={field} value={form.fixedPrize} onChange={(e) => update('fixedPrize', Number(e.target.value))} min={0} />
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className={labelCls}>Sponsor Pool (comma-separated)</label>
              <textarea className={`${field} h-20 resize-none`} value={form.sponsorPoolText} onChange={(e) => update('sponsorPoolText', e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Min Prize (₦)</label>
                <input type="number" className={field} value={form.prizeMin} onChange={(e) => update('prizeMin', Number(e.target.value))} min={0} />
              </div>
              <div>
                <label className={labelCls}>Max Prize (₦)</label>
                <input type="number" className={field} value={form.prizeMax} onChange={(e) => update('prizeMax', Number(e.target.value))} min={0} />
              </div>
            </div>
          </div>
        )}
      </Section>

      {/* Ticket economy */}
      <Section icon={<Ticket className="w-4 h-4" />} title="Ticket Economy">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Pack Price (₦) — {formatNaira(form.ticketPackPrice)}</label>
            <input type="number" className={field} value={form.ticketPackPrice} onChange={(e) => update('ticketPackPrice', Number(e.target.value))} min={0} />
          </div>
          <div>
            <label className={labelCls}>Tickets per Pack</label>
            <input type="number" className={field} value={form.ticketPackSize} onChange={(e) => update('ticketPackSize', Number(e.target.value))} min={1} />
          </div>
        </div>
        <Toggle value={form.freeGameEnabled} onChange={(v) => update('freeGameEnabled', v)} label="Give new players 1 free game" />
        {form.ticketPackSize > 0 && (
          <p className="text-[10px] text-slate-500 font-mono">
            = {formatNaira(form.ticketPackPrice / form.ticketPackSize)} per ticket
          </p>
        )}
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
        <Toggle value={form.autoBotFill} onChange={(v) => update('autoBotFill', v)} label="Auto-fill empty seats with bots" />
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
