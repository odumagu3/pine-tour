import React, { useEffect, useRef, useState } from 'react';
import { Eye, Crown, Users, X, Loader2, ArrowLeft, Trophy } from 'lucide-react';
import { apiUrl } from '../config.js';

const SUIT: Record<string, string> = { circle: '●', triangle: '▲', cross: '➕', square: '■', star: '★', whot: '🃏' };
const DOT: Record<string, string> = { red: 'bg-neon-pink', green: 'bg-neon-green', yellow: 'bg-amber-400', blue: 'bg-neon-cyan' };

interface SpecTable { roomId: string; players: string[]; winner: string; done: boolean; }
interface SpecRound { index: number; byes: string[]; tables: SpecTable[]; }
interface Spectate {
  exists: boolean;
  status?: string;
  currentRound?: number;
  totalRounds?: number;
  championName?: string | null;
  forcedWinnerName?: string | null;
  rounds?: SpecRound[];
}

export default function TournamentSpectator({ email, onClose }: { email: string; onClose: () => void }) {
  const [spec, setSpec] = useState<Spectate | null>(null);
  const [watch, setWatch] = useState<{ roomId: string; label: string } | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(apiUrl(`/api/tournament/spectate`));
        if (res.ok && alive) setSpec(await res.json());
      } catch { /* ignore */ }
    };
    poll();
    const id = window.setInterval(poll, 2500);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  const forced = spec?.forcedWinnerName || null;

  return (
    <div className="w-full max-w-lg mx-auto py-6 space-y-4">
      <div className="flex items-center justify-between">
        <button onClick={onClose} className="inline-flex items-center gap-1.5 text-xs font-mono text-slate-400 hover:text-white cursor-pointer">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h2 className="text-sm font-bold font-display text-white flex items-center gap-2">
          <Eye className="w-4 h-4 text-neon-cyan" /> Watching the Tournament
        </h2>
        <span className="text-[10px] font-mono text-slate-500">{spec?.status === 'running' ? `Round ${spec?.currentRound}/${spec?.totalRounds}` : ''}</span>
      </div>

      {spec?.championName ? (
        <div className="bg-gradient-to-br from-neon-green/10 to-slate-950 border border-neon-green/30 rounded-2xl p-6 text-center">
          <Trophy className="w-10 h-10 text-neon-green mx-auto mb-2" />
          <p className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Champion</p>
          <p className="text-xl font-black font-display text-white">{spec.championName}</p>
        </div>
      ) : !spec?.exists ? (
        <div className="py-10 text-center font-mono text-xs text-slate-500"><Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" /> Loading bracket…</div>
      ) : null}

      {/* Bracket — tap a live table to watch the cards */}
      {spec?.rounds && (
        <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
          {spec.rounds.map(round => (
            <div key={round.index}>
              <p className="text-[10px] font-mono text-slate-400 uppercase tracking-widest mb-1.5 flex items-center gap-2">
                <Users className="w-3 h-3" /> Round {round.index}
                <span className="text-slate-600">· {round.tables.length} table{round.tables.length !== 1 ? 's' : ''}{round.byes.length ? ` · ${round.byes.length} bye` : ''}</span>
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {round.tables.map((t, i) => (
                  <button
                    key={i}
                    onClick={() => !t.done && setWatch({ roomId: t.roomId, label: `Round ${round.index} · Table ${i + 1}` })}
                    disabled={t.done}
                    className={`text-left rounded-lg border p-2 text-[11px] font-mono transition-all group ${t.done ? 'border-neon-green/30 bg-neon-green/5' : 'border-slate-800 bg-slate-900/40 hover:border-neon-cyan/60 cursor-pointer'}`}
                  >
                    {!t.done && <span className="float-right text-slate-500 group-hover:text-neon-cyan inline-flex items-center gap-0.5"><Eye className="w-3 h-3" />watch</span>}
                    {t.players.map((name, j) => {
                      const isWinner = t.done && name === t.winner;
                      const isForced = forced && name === forced;
                      return (
                        <span key={j} className={`inline-flex items-center gap-1 mr-2 ${isWinner ? 'text-neon-green font-bold' : isForced ? 'text-amber-300 font-bold' : 'text-slate-400'}`}>
                          {isWinner && <Crown className="w-3 h-3" />}{isForced && '👑'}{name}
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

      {watch && <WatchTable email={email} roomId={watch.roomId} label={watch.label} forcedName={forced} onClose={() => setWatch(null)} />}
    </div>
  );
}

interface TableSnap {
  exists: boolean;
  status?: string;
  topCard?: { suit: string; value: number } | null;
  requestedSuit?: string | null;
  drawPileCount?: number;
  winnerName?: string | null;
  players?: { name: string; color: string | null; cardsCount: number; active: boolean; predestined?: boolean }[];
  logs?: { message: string; type: string; timestamp: string }[];
}

function WatchTable({ email, roomId, label, forcedName, onClose }: { email: string; roomId: string; label: string; forcedName: string | null; onClose: () => void }) {
  const [snap, setSnap] = useState<TableSnap | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(apiUrl(`/api/tournament/table?roomId=${encodeURIComponent(roomId)}&email=${encodeURIComponent(email)}`));
        if (res.ok && alive) setSnap(await res.json());
      } catch { /* ignore */ }
    };
    poll();
    const id = window.setInterval(poll, 900);
    return () => { alive = false; window.clearInterval(id); };
  }, [email, roomId]);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [snap]);

  const top = snap?.topCard;
  const suit = top ? (top.value === 20 ? '🃏' : SUIT[top.suit] ?? top.suit) : '—';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 backdrop-blur-sm p-3" onClick={onClose}>
      <div className="w-full max-w-lg bg-dark-card border border-neon-cyan/30 rounded-2xl p-4 shadow-2xl relative" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-3 right-3 text-slate-500 hover:text-white cursor-pointer"><X className="w-5 h-5" /></button>
        <h3 className="text-sm font-bold font-display text-white flex items-center gap-2 mb-3">
          <Eye className="w-4 h-4 text-neon-cyan" /> {label}
          {snap?.status === 'playing' && <span className="text-[9px] font-mono text-amber-400 animate-pulse">● LIVE</span>}
        </h3>
        {!snap?.exists ? (
          <div className="py-10 text-center font-mono text-xs text-slate-500"><Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" /> Loading…</div>
        ) : (
          <>
            <div className="flex items-center justify-center gap-6 mb-4">
              <div className="text-center">
                <div className={`w-16 rounded-lg border-2 flex flex-col items-center justify-center font-display ${top?.value === 20 ? 'border-neon-purple bg-neon-purple/10' : 'border-slate-600 bg-slate-900'}`} style={{ height: '5.5rem' }}>
                  <span className="text-2xl leading-none">{suit}</span>
                  <span className="text-lg font-bold text-white">{top ? (top.value === 20 ? 'W' : top.value) : ''}</span>
                </div>
                <span className="text-[9px] font-mono text-slate-500 mt-1 block">top card</span>
              </div>
              <div className="text-center">
                <div className="w-16 rounded-lg border-2 border-dashed border-slate-700 bg-slate-900/50 flex items-center justify-center text-slate-400 font-display font-bold text-lg" style={{ height: '5.5rem' }}>{snap.drawPileCount ?? 0}</div>
                <span className="text-[9px] font-mono text-slate-500 mt-1 block">market</span>
              </div>
            </div>
            {snap.requestedSuit && <p className="text-center text-[10px] font-mono text-neon-purple mb-3">Requested: {SUIT[snap.requestedSuit] ?? snap.requestedSuit} {snap.requestedSuit}</p>}
            <div className="grid grid-cols-2 gap-2 mb-3">
              {snap.players?.map((p, i) => (
                <div key={i} className={`flex items-center justify-between rounded-lg border px-2.5 py-1.5 ${p.active ? 'border-neon-cyan bg-neon-cyan/10' : snap.winnerName === p.name ? 'border-neon-green/40 bg-neon-green/5' : 'border-slate-800 bg-slate-900/40'}`}>
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${DOT[p.color ?? ''] ?? 'bg-slate-600'}`} />
                    <span className={`text-[11px] font-mono truncate ${forcedName && p.name === forcedName ? 'text-amber-300 font-bold' : p.active ? 'text-white font-bold' : 'text-slate-300'}`}>{p.name}</span>
                    {forcedName && p.name === forcedName && <Crown className="w-3 h-3 text-amber-400 flex-shrink-0" />}
                  </span>
                  <span className="text-[11px] font-mono font-bold text-slate-400 flex-shrink-0">{p.cardsCount}🂠</span>
                </div>
              ))}
            </div>
            <div ref={logRef} className="h-36 overflow-y-auto bg-slate-950 border border-slate-800 rounded-lg p-2 space-y-1">
              {(snap.logs ?? []).map((l, i) => (
                <div key={i} className={`text-[10px] font-mono leading-snug ${l.type === 'win' ? 'text-neon-green' : l.type === 'move' ? 'text-slate-200' : l.type === 'roll' ? 'text-neon-cyan' : l.type === 'system' ? 'text-amber-300' : 'text-slate-500'}`}>{l.message}</div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
