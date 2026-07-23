import React, { useEffect, useRef, useState } from 'react';
import { Trophy, Users, Play, RotateCcw, Bot, Crown, Loader2, AlertCircle, PlusCircle } from 'lucide-react';
import { formatNaira } from '../currency.js';
import { apiUrl } from '../config.js';

interface TournamentPanelProps {
  email: string;
  passcode: string;
}

interface StatusPlayer { name: string; isBot: boolean; }
interface StatusTable { players: StatusPlayer[]; winner: string; done: boolean; }
interface StatusRound { index: number; byes: string[]; tables: StatusTable[]; }
interface TournamentStatus {
  exists: boolean;
  status?: 'registering' | 'running' | 'finished';
  sponsorName?: string;
  prize?: number;
  entrantCount?: number;
  currentRound?: number;
  totalRounds?: number;
  championName?: string | null;
  championIsBot?: boolean | null;
  rounds?: StatusRound[];
}

export default function TournamentPanel({ email, passcode }: TournamentPanelProps) {
  const [status, setStatus] = useState<TournamentStatus | null>(null);
  const [simCount, setSimCount] = useState(50);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const pollRef = useRef<number | null>(null);

  const fetchStatus = async () => {
    try {
      const res = await fetch(apiUrl(`/api/tournament/status?email=${encodeURIComponent(email)}`));
      if (res.ok) setStatus(await res.json());
    } catch { /* ignore transient poll errors */ }
  };

  // Poll the bracket while a tournament exists (or is running).
  useEffect(() => {
    fetchStatus();
    pollRef.current = window.setInterval(fetchStatus, 2500);
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  const action = async (path: string, body: Record<string, unknown> = {}) => {
    setError('');
    setBusy(path);
    try {
      const res = await fetch(apiUrl(`/api/tournament/${path}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, passcode, ...body }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || 'Action failed.');
      else if (data.status) setStatus(data.status);
    } catch {
      setError('Could not reach the tournament service.');
    } finally {
      setBusy(null);
    }
  };

  const st = status?.status;
  const exists = !!status?.exists;

  const btn = 'inline-flex items-center justify-center gap-2 font-mono font-bold text-xs rounded-lg px-4 py-2 transition-all disabled:opacity-50 cursor-pointer';

  return (
    <div className="bg-dark-card border border-neon-green/20 rounded-2xl p-5 shadow-lg space-y-4">
      <h3 className="text-sm font-bold font-display text-white flex items-center gap-2">
        <span className="text-neon-green"><Trophy className="w-4 h-4" /></span>
        Live Tournament <span className="text-[10px] font-mono text-slate-500">(Knockout Bracket)</span>
      </h3>

      {error && (
        <div className="p-3 bg-red-950/40 border border-red-500/30 rounded-lg text-xs text-red-400 font-mono flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {/* Summary strip */}
      {exists && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
          <Stat label="Status" value={st === 'registering' ? 'Registering' : st === 'running' ? 'Running' : 'Finished'} />
          <Stat label="Players" value={String(status?.entrantCount ?? 0)} />
          <Stat label="Round" value={st === 'registering' ? '—' : `${status?.currentRound}/${status?.totalRounds}`} />
          <Stat label="Prize" value={formatNaira(status?.prize ?? 0)} />
        </div>
      )}

      {/* Controls per phase */}
      {!exists && (
        <div className="space-y-2">
          <p className="text-[11px] text-slate-400 font-mono">
            Uses the Sponsor + Prize from the <span className="text-neon-purple">Tournament</span> section above — set those first.
          </p>
          <button onClick={() => action('create')} disabled={busy !== null} className={`${btn} bg-neon-green/10 border border-neon-green/40 text-neon-green w-full`}>
            {busy === 'create' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trophy className="w-4 h-4" />}
            Create Tournament
          </button>
        </div>
      )}

      {exists && st === 'registering' && (
        <div className="space-y-3">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="block text-[10px] font-mono text-slate-400 mb-1 uppercase tracking-wide">Simulated players to add</label>
              <input
                type="number" min={1} max={200} value={simCount}
                onChange={(e) => setSimCount(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg py-2 px-3 font-mono text-sm text-white focus:outline-none focus:border-neon-green/60"
              />
            </div>
            <button onClick={() => action('simulate', { count: simCount })} disabled={busy !== null} className={`${btn} bg-slate-800 border border-slate-700 text-slate-200`}>
              {busy === 'simulate' ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlusCircle className="w-4 h-4" />}
              Add
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {[8, 16, 32, 50, 64].map(n => (
              <button key={n} onClick={() => setSimCount(n)} className={`px-2.5 py-1 rounded-md font-mono text-[10px] font-bold border ${simCount === n ? 'border-neon-green bg-neon-green/10 text-neon-green' : 'border-slate-800 bg-slate-900/50 text-slate-400 hover:text-white'}`}>{n}</button>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={() => action('start')} disabled={busy !== null || (status?.entrantCount ?? 0) < 2} className={`${btn} bg-neon-purple hover:bg-neon-purple/90 text-white flex-1`}>
              {busy === 'start' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              Start Tournament ({status?.entrantCount ?? 0})
            </button>
            <button onClick={() => action('reset')} disabled={busy !== null} className={`${btn} bg-slate-800 border border-slate-700 text-slate-300`}>
              <RotateCcw className="w-4 h-4" /> Reset
            </button>
          </div>
          <p className="text-[10px] text-slate-500 font-mono flex items-center gap-1.5">
            <Bot className="w-3 h-3" /> Simulated players are AI, used to test how a full field behaves. Switch to humans-only when real money goes live.
          </p>
        </div>
      )}

      {exists && st === 'finished' && (
        <div className="space-y-3">
          <div className="bg-gradient-to-br from-neon-green/10 to-slate-950 border border-neon-green/30 rounded-xl p-4 text-center">
            <Crown className="w-8 h-8 text-neon-green mx-auto mb-1" />
            <p className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Champion</p>
            <p className="text-lg font-black font-display text-white flex items-center justify-center gap-2">
              {status?.championName ?? '—'}
              {status?.championIsBot && <span className="text-[9px] font-mono bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded">AI</span>}
            </p>
            <p className="text-xs font-mono text-neon-green mt-1">{formatNaira(status?.prize ?? 0)}{status?.championIsBot ? ' — not paid (AI, test run)' : ' paid to champion'}</p>
          </div>
          <button onClick={() => action('reset')} disabled={busy !== null} className={`${btn} bg-slate-800 border border-slate-700 text-slate-300 w-full`}>
            <RotateCcw className="w-4 h-4" /> New Tournament
          </button>
        </div>
      )}

      {exists && st === 'running' && (
        <button onClick={() => action('reset')} disabled={busy !== null} className={`${btn} bg-slate-800 border border-slate-700 text-slate-300`}>
          <RotateCcw className="w-4 h-4" /> Cancel & Reset
        </button>
      )}

      {/* Bracket view */}
      {exists && (st === 'running' || st === 'finished') && status?.rounds && (
        <div className="space-y-3 max-h-[360px] overflow-y-auto pr-1">
          {status.rounds.map(round => (
            <div key={round.index}>
              <p className="text-[10px] font-mono text-slate-400 uppercase tracking-widest mb-1.5 flex items-center gap-2">
                <Users className="w-3 h-3" /> Round {round.index}
                <span className="text-slate-600">· {round.tables.length} table{round.tables.length !== 1 ? 's' : ''}{round.byes.length ? ` · ${round.byes.length} bye` : ''}</span>
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {round.tables.map((t, i) => (
                  <div key={i} className={`rounded-lg border p-2 text-[11px] font-mono ${t.done ? 'border-neon-green/30 bg-neon-green/5' : 'border-slate-800 bg-slate-900/40'}`}>
                    {t.players.map((p, j) => {
                      const isWinner = t.done && p.name === t.winner;
                      return (
                        <span key={j} className={`inline-flex items-center gap-1 mr-2 ${isWinner ? 'text-neon-green font-bold' : 'text-slate-400'}`}>
                          {isWinner && <Crown className="w-3 h-3" />}{p.name}
                        </span>
                      );
                    })}
                    {!t.done && <span className="text-amber-400 ml-1">· playing…</span>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-900/50 border border-slate-800 rounded-lg py-2 px-1">
      <div className="text-[9px] font-mono text-slate-500 uppercase tracking-wide">{label}</div>
      <div className="text-xs font-bold font-display text-white truncate">{value}</div>
    </div>
  );
}
