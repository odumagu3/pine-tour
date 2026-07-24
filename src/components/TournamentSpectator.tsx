import React, { useEffect, useState } from 'react';
import { Eye, Crown, Users, X, Loader2, ArrowLeft, Trophy } from 'lucide-react';
import { apiUrl } from '../config.js';
import { GameState, UserProfile, PublicConfig } from '../types.js';
import GameBoard from './GameBoard.tsx';

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

export default function TournamentSpectator({ email, onClose, profile, config }: { email: string; onClose: () => void; profile: UserProfile | null; config: PublicConfig | null }) {
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

      {watch && <WatchTable email={email} roomId={watch.roomId} label={watch.label} forcedName={forced} profile={profile} config={config} onClose={() => setWatch(null)} />}
    </div>
  );
}

interface TableSnap {
  exists: boolean;
  status?: string;
  winnerName?: string | null;
  state?: GameState | null;
}

// Watch a live table the SAME way it looks when you're playing: the real
// GameBoard, driven by a spectator-safe full state polled from the server
// (hands hidden — you see the board, seats, top card, market and the live play,
// but not anyone's cards). Read-only: with no seat there are no play controls.
function WatchTable({ email, roomId, label, profile, config, onClose }: { email: string; roomId: string; label: string; forcedName: string | null; profile: UserProfile | null; config: PublicConfig | null; onClose: () => void }) {
  const [snap, setSnap] = useState<TableSnap | null>(null);
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

  const noop = () => {};

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/80 backdrop-blur-sm p-2 sm:p-4 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-5xl my-4 bg-dark-card border border-neon-cyan/30 rounded-2xl p-3 sm:p-4 shadow-2xl relative" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold font-display text-white flex items-center gap-2">
            <Eye className="w-4 h-4 text-neon-cyan" /> {label}
            {snap?.status === 'playing' && <span className="text-[9px] font-mono text-amber-400 animate-pulse">● LIVE</span>}
            <span className="text-[9px] font-mono text-slate-500 uppercase tracking-widest border border-slate-700 rounded px-1.5 py-0.5">Spectating</span>
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white cursor-pointer inline-flex items-center gap-1 text-xs font-mono">
            <X className="w-5 h-5" />
          </button>
        </div>
        {!snap?.exists ? (
          <div className="py-16 text-center font-mono text-xs text-slate-500"><Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" /> Loading table…</div>
        ) : snap.state ? (
          // Read-only: no seat → GameBoard renders the table from the outside with
          // no play controls. Handlers are no-ops (the server also rejects actions
          // from anyone not seated at the table).
          <GameBoard
            gameState={snap.state}
            profile={profile}
            config={config}
            activePlayerEmail={email}
            onRollDice={noop}
            onMoveToken={noop}
            onAddBots={noop}
            onGoToCashier={noop}
          />
        ) : (
          <div className="py-16 text-center font-mono text-xs text-slate-500">This table has finished.</div>
        )}
      </div>
    </div>
  );
}
