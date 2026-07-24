import React, { useState } from 'react';
import { motion } from 'motion/react';
import { PublicConfig } from '../types.js';
import { formatNaira } from '../currency.js';
import { apiUrl } from '../config.js';
import { ShieldCheck, Lock, Loader2, CheckCircle2, AlertCircle, Save, Building2, Trophy, Ticket, Gamepad2, Users, Unlock } from 'lucide-react';
import TournamentPanel from './TournamentPanel.tsx';

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
  roomName: string;      // the single arena room name
  sponsorName: string;   // tournament sponsor ('' = no tournament)
  sponsorPrize: number;  // tournament cash prize
  fieldSize: number;     // seats the bracket auto-fills to (multiple of 4)
  botRosterText: string; // comma-separated bot names used to fill seats
  casualForcedWinner: string; // bot name that wins casual "Enter Arena" games
  allHandsForcedWinner: string; // name that wins All Hands on Deck games
  ticketPrice: number;   // price per ticket
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
    ticketPrice: Number(c.ticketPrice ?? c.ticketPackPrice ?? 0),
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
      ticketPrice: form.ticketPrice,
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
            <label className={labelCls}>Arena Room Name</label>
            <input className={field} value={form.roomName} onChange={(e) => update('roomName', e.target.value)} />
            <p className="text-[10px] text-slate-500 font-mono mt-1">Everyone plays in this one room.</p>
          </div>
        </div>
      </Section>

      {/* Tournament */}
      <Section icon={<Trophy className="w-4 h-4" />} title="Tournament">
        {(() => {
          const active = form.sponsorName.trim().length > 0 && form.sponsorPrize > 0;
          return (
            <div className={`flex items-center gap-2 rounded-lg px-3 py-2 border text-[11px] font-mono ${active ? 'border-neon-green/40 bg-neon-green/5 text-neon-green' : 'border-slate-700 bg-slate-900/40 text-slate-400'}`}>
              <span className={`w-2 h-2 rounded-full ${active ? 'bg-neon-green' : 'bg-slate-500'}`} />
              {active ? 'Tournament is LIVE — players can enter.' : 'No tournament — players see “No tournaments available”.'}
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Field Size (seats)</label>
            <input type="number" className={field} value={form.fieldSize} onChange={(e) => update('fieldSize', Number(e.target.value))} min={4} max={128} step={4} />
            <p className="text-[10px] text-slate-500 font-mono mt-1">
              AI fills empty seats up to this. Rounded to a multiple of 4 (full tables). Quick picks:
              {[8, 16, 32, 64].map(n => (
                <button key={n} type="button" onClick={() => update('fieldSize', n)} className="ml-1 px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300">{n}</button>
              ))}
            </p>
          </div>
        </div>
        <p className="text-[10px] text-slate-500 font-mono">
          Set a sponsor name and a prize above 0 to open a tournament. Clear the sponsor name (or set the prize to 0) to close all tournaments.
        </p>
      </Section>

      {/* Live knockout tournament — create, simulate a field, start, and watch */}
      <TournamentPanel email={email} passcode={passcode} sponsorName={form.sponsorName} sponsorPrize={form.sponsorPrize} />

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
                    {form.casualForcedWinner === n && '👑 '}{n}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-slate-500 font-mono mt-1">Applies instantly (no Save needed). This bot wins any casual “Enter Arena” game and is openly marked to players. Bracket winner is picked in the Live Tournament panel.</p>
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
                    {form.allHandsForcedWinner === n && '👑 '}{n}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-slate-500 font-mono mt-1">Applies instantly. This player is protected from every knock-out and wins All Hands on Deck (last one standing), openly marked with 👑. Use a bot name (guaranteed a seat) or a seated player's exact nickname.</p>
            </div>
          );
        })()}
        <p className="text-[9px] text-amber-500/80 font-mono">⚠️ Turn these off before real players/payments.</p>
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
