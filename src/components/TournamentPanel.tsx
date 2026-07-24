import React, { useEffect, useRef, useState } from 'react';
import { Trophy, Users, Play, RotateCcw, Bot, Crown, Loader2, AlertCircle, PlusCircle, Eye, X } from 'lucide-react';
import { formatNaira } from '../currency.js';
import { apiUrl } from '../config.js';

interface TournamentPanelProps {
  email: string;
  passcode: string;
  sponsorName?: string;
  sponsorPrize?: number;
}

interface StatusPlayer { name: string; isBot: boolean; }
interface StatusTable { roomId: string; players: StatusPlayer[]; winner: string; done: boolean; }
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
  forcedWinnerId?: string | null;
  forcedWinnerName?: string | null;
  entrants?: { id: string; name: string; isBot: boolean }[];
  rounds?: StatusRound[];
}

export default function TournamentPanel({ email, passcode, sponsorName = '', sponsorPrize = 0 }: TournamentPanelProps) {
  const [status, setStatus] = useState<TournamentStatus | null>(null);
  const [simCount, setSimCount] = useState(50);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [watching, setWatching] = useState<{ roomId: string; label: string } | null>(null);
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
    const url = apiUrl(`/api/tournament/${path}`);
    const payload = JSON.stringify({ email, passcode, ...body });
    // The backend is on a free tier that sleeps after ~15 min idle. A cold start
    // takes ~30-50s and the first request(s) can fail outright, so retry with a
    // clear "waking up" message before giving up.
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        });
        const data = await res.json();
        if (!res.ok) setError(data.error || 'Action failed.');
        else if (data.status) setStatus(data.status);
        setBusy(null);
        return;
      } catch {
        if (attempt < maxAttempts) {
          setError('Waking up the server (free tier can take ~30s)… retrying');
          await new Promise(r => setTimeout(r, 3000));
        } else {
          setError('Could not reach the tournament service. The server may be starting up — wait a few seconds and try again.');
        }
      }
    }
    setBusy(null);
  };

  const st = status?.status;
  const exists = !!status?.exists;

  const btn = 'inline-flex items-center justify-center gap-2 font-mono font-bold text-xs rounded-lg px-4 py-2 transition-all disabled:opacity-50 cursor-pointer';

  return (
    <div className="bg-dark-card border border-neon-green/20 rounded-2xl p-5 shadow-lg space-y-4">
      <h3 className="text-sm font-bold font-display text-white flex items-center gap-2">
        <span className="text-neon-green"><Trophy className="w-4 h-4" /></span>
        Run the Tournament <span className="text-[10px] font-mono text-slate-500">(Knockout)</span>
      </h3>
      <p className="text-[10px] font-mono text-slate-400 -mt-2">
        This launches the tournament you set up above so real players can join. Steps: <span className="text-neon-green">Create</span> (opens registration) → players register (or add AI to test) → <span className="text-neon-purple">Start</span>.
      </p>

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

      {/* Preselected winner (TEST). Admin-only — players are never told. */}
      {exists && (st === 'registering' || st === 'running') && (status?.entrants?.length ?? 0) > 0 && (
        <div className="border border-amber-500/30 bg-amber-950/10 rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-[11px] font-mono font-bold text-amber-300 flex items-center gap-1.5">
              <Crown className="w-3.5 h-3.5" /> Preselected Winner — TEST (silent)
            </h4>
            {status?.forcedWinnerId && (
              <button onClick={() => action('force-winner', { entrantId: null })} disabled={busy !== null} className="text-[10px] font-mono text-slate-400 hover:text-white cursor-pointer">Clear pick</button>
            )}
          </div>
          {status?.forcedWinnerName
            ? <p className="text-[10px] font-mono text-amber-200">Picked: <strong>{status.forcedWinnerName}</strong> — visible here only. No mark, no chat announcement.</p>
            : <p className="text-[10px] font-mono text-slate-400">Tap a player to make them win. Players see nothing — they just win at the end.</p>}
          <div className="max-h-40 overflow-y-auto grid grid-cols-2 gap-1 pr-1">
            {status?.entrants?.map(e => (
              <button
                key={e.id}
                onClick={() => action('force-winner', { entrantId: e.id })}
                disabled={busy !== null}
                className={`text-left text-[10px] font-mono px-2 py-1 rounded border truncate cursor-pointer ${status.forcedWinnerId === e.id ? 'border-amber-500 bg-amber-500/15 text-amber-200 font-bold' : 'border-slate-800 bg-slate-900/40 text-slate-300 hover:border-amber-500/50'}`}
              >
                {status.forcedWinnerId === e.id && '✓ '}{e.name}{e.isBot && <span className="text-slate-500"> · AI</span>}
              </button>
            ))}
          </div>
          <p className="text-[9px] text-slate-500 font-mono">⚠️ Turn this off before real players/payments — the rig is silent, so nothing on the table reveals it.</p>
        </div>
      )}

      {/* Controls per phase */}
      {!exists && (
        <div className="space-y-2">
          {sponsorName && sponsorPrize > 0 ? (
            <p className="text-[11px] text-slate-300 font-mono">
              Ready to launch: <span className="text-white font-bold">{sponsorName}</span> · <span className="text-neon-green font-bold">{formatNaira(sponsorPrize)}</span>. Create <span className="text-neon-green">opens registration</span> so real players can join it from their lobby.
            </p>
          ) : (
            <p className="text-[11px] text-amber-400 font-mono">
              Set a Sponsor name + Cash Prize in the Tournament section above first — then create.
            </p>
          )}
          <button onClick={() => action('create')} disabled={busy !== null || !(sponsorName && sponsorPrize > 0)} className={`${btn} bg-neon-green/10 border border-neon-green/40 text-neon-green w-full disabled:opacity-40`}>
            {busy === 'create' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trophy className="w-4 h-4" />}
            {sponsorName && sponsorPrize > 0 ? `Create Tournament — ${sponsorName} (${formatNaira(sponsorPrize)})` : 'Create Tournament'}
          </button>
        </div>
      )}

      {exists && st === 'registering' && (
        <div className="space-y-3">
          <div className="rounded-lg border border-neon-green/30 bg-neon-green/5 px-3 py-2 text-[11px] font-mono text-neon-green">
            ✅ Registration is OPEN — real players can join now from their lobby ({status?.entrantCount ?? 0} in). Press <span className="font-bold">Start</span> when ready. The AI simulator below is optional (for testing on your own).
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="block text-[10px] font-mono text-slate-400 mb-1 uppercase tracking-wide">Add AI (optional, for testing)</label>
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
                  <button
                    key={i}
                    onClick={() => setWatching({ roomId: t.roomId, label: `Round ${round.index} · Table ${i + 1}` })}
                    className={`text-left rounded-lg border p-2 text-[11px] font-mono transition-all hover:border-neon-cyan/60 group ${t.done ? 'border-neon-green/30 bg-neon-green/5' : 'border-slate-800 bg-slate-900/40'}`}
                  >
                    <span className="float-right text-slate-500 group-hover:text-neon-cyan inline-flex items-center gap-0.5"><Eye className="w-3 h-3" />{!t.done ? 'watch' : 'view'}</span>
                    {t.players.map((p, j) => {
                      const isWinner = t.done && p.name === t.winner;
                      return (
                        <span key={j} className={`inline-flex items-center gap-1 mr-2 ${isWinner ? 'text-neon-green font-bold' : 'text-slate-400'}`}>
                          {isWinner && <Crown className="w-3 h-3" />}{p.name}
                        </span>
                      );
                    })}
                    {!t.done && <span className="text-amber-400 ml-1">· playing…</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {watching && (
        <WatchTableModal email={email} roomId={watching.roomId} label={watching.label} onClose={() => setWatching(null)} />
      )}
    </div>
  );
}

// --- Live spectator view of one table (polls public game state) --------------
const SUIT_SYMBOL: Record<string, string> = { circle: '●', triangle: '▲', cross: '✚', square: '■', star: '★', whot: '🃏' };
const COLOR_DOT: Record<string, string> = { red: 'bg-neon-pink', green: 'bg-neon-green', yellow: 'bg-amber-400', blue: 'bg-neon-cyan' };

interface TableSnapshot {
  exists: boolean;
  status?: 'waiting' | 'playing' | 'finished';
  topCard?: { suit: string; value: number } | null;
  requestedSuit?: string | null;
  drawPileCount?: number;
  winnerName?: string | null;
  players?: { name: string; color: string | null; cardsCount: number; active: boolean }[];
  logs?: { message: string; type: string; timestamp: string }[];
}

function WatchTableModal({ email, roomId, label, onClose }: { email: string; roomId: string; label: string; onClose: () => void }) {
  const [snap, setSnap] = useState<TableSnapshot | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(apiUrl(`/api/tournament/table?email=${encodeURIComponent(email)}&roomId=${encodeURIComponent(roomId)}`));
        if (res.ok && alive) setSnap(await res.json());
      } catch { /* transient */ }
    };
    poll();
    const id = window.setInterval(poll, 900);
    return () => { alive = false; window.clearInterval(id); };
  }, [email, roomId]);

  // Auto-scroll the log to the newest line.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [snap]);

  const top = snap?.topCard;
  const suit = top ? (top.value === 20 ? '🃏' : SUIT_SYMBOL[top.suit] ?? top.suit) : '—';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 backdrop-blur-sm p-3" onClick={onClose}>
      <div className="w-full max-w-lg bg-dark-card border border-neon-cyan/30 rounded-2xl p-4 shadow-2xl relative" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-3 right-3 text-slate-500 hover:text-white cursor-pointer"><X className="w-5 h-5" /></button>
        <h3 className="text-sm font-bold font-display text-white flex items-center gap-2 mb-3">
          <Eye className="w-4 h-4 text-neon-cyan" /> {label}
          {snap?.status === 'playing' && <span className="text-[9px] font-mono text-amber-400 animate-pulse">● LIVE</span>}
          {snap?.status === 'finished' && <span className="text-[9px] font-mono text-neon-green">FINISHED</span>}
        </h3>

        {!snap?.exists ? (
          <div className="py-10 text-center font-mono text-xs text-slate-500">
            <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" /> Loading table…
          </div>
        ) : (
          <>
            {/* Top card + market */}
            <div className="flex items-center justify-center gap-6 mb-4">
              <div className="text-center">
                <div className={`w-16 h-22 rounded-lg border-2 flex flex-col items-center justify-center font-display shadow-lg ${top?.value === 20 ? 'border-neon-purple bg-neon-purple/10' : 'border-slate-600 bg-slate-900'}`} style={{ height: '5.5rem' }}>
                  <span className="text-2xl leading-none">{suit}</span>
                  <span className="text-lg font-bold text-white">{top ? (top.value === 20 ? 'W' : top.value) : ''}</span>
                </div>
                <span className="text-[9px] font-mono text-slate-500 mt-1 block">top card</span>
              </div>
              <div className="text-center">
                <div className="w-16 rounded-lg border-2 border-dashed border-slate-700 bg-slate-900/50 flex items-center justify-center text-slate-400 font-display font-bold text-lg" style={{ height: '5.5rem' }}>
                  {snap.drawPileCount ?? 0}
                </div>
                <span className="text-[9px] font-mono text-slate-500 mt-1 block">market</span>
              </div>
            </div>
            {snap.requestedSuit && (
              <p className="text-center text-[10px] font-mono text-neon-purple mb-3">Requested suit: {SUIT_SYMBOL[snap.requestedSuit] ?? snap.requestedSuit} {snap.requestedSuit}</p>
            )}

            {/* Players */}
            <div className="grid grid-cols-2 gap-2 mb-3">
              {snap.players?.map((p, i) => (
                <div key={i} className={`flex items-center justify-between rounded-lg border px-2.5 py-1.5 ${p.active ? 'border-neon-cyan bg-neon-cyan/10 shadow-[0_0_10px_rgba(0,243,255,0.15)]' : snap.winnerName === p.name ? 'border-neon-green/40 bg-neon-green/5' : 'border-slate-800 bg-slate-900/40'}`}>
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${COLOR_DOT[p.color ?? ''] ?? 'bg-slate-600'}`} />
                    <span className={`text-[11px] font-mono truncate ${p.active ? 'text-white font-bold' : 'text-slate-300'}`}>{p.name}</span>
                    {snap.winnerName === p.name && <Crown className="w-3 h-3 text-neon-green flex-shrink-0" />}
                  </span>
                  <span className="text-[11px] font-mono font-bold text-slate-400 flex-shrink-0">{p.cardsCount}🂠</span>
                </div>
              ))}
            </div>

            {/* Live play-by-play */}
            <div ref={logRef} className="h-40 overflow-y-auto bg-slate-950 border border-slate-800 rounded-lg p-2 space-y-1">
              {(snap.logs ?? []).map((l, i) => (
                <div key={i} className={`text-[10px] font-mono leading-snug ${
                  l.type === 'win' ? 'text-neon-green' : l.type === 'move' ? 'text-slate-200' : l.type === 'roll' ? 'text-neon-cyan' : l.type === 'cheat' ? 'text-amber-400' : 'text-slate-500'
                }`}>{l.message}</div>
              ))}
            </div>
            <p className="text-[9px] text-slate-600 font-mono text-center mt-2">Updating live · a table auto-resolves after 45s (fewest cards wins)</p>
          </>
        )}
      </div>
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
