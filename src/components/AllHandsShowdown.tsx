import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';

// The "all hands on deck" reveal: when the market runs dry, every player's hand
// is laid down and their card total counted up on screen, then the highest is
// knocked out. Driven by the server's `all-hands-showdown` event.
interface Total { name: string; total: number; eliminated: boolean; }
export interface ShowdownData {
  totals: Total[];
  eliminatedName: string;
  maxSum: number;
  remaining: number;
  nonce: number; // changes each showdown so the animation re-runs
}

// Animate a number from 0 up to `target` with an ease-out curve.
function CountUp({ target, duration = 1100 }: { target: number; duration?: number }) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(Math.round(eased * target));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return <>{val}</>;
}

export default function AllHandsShowdown({ data, onDone }: { data: ShowdownData; onDone: () => void }) {
  const [revealElim, setRevealElim] = useState(false);
  useEffect(() => {
    setRevealElim(false);
    // Count the cards first, then reveal who's knocked out, then dismiss.
    const t1 = window.setTimeout(() => setRevealElim(true), 1500);
    const t2 = window.setTimeout(onDone, 4300);
    return () => { window.clearTimeout(t1); window.clearTimeout(t2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.nonce]);

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/85 backdrop-blur-sm p-4">
      <motion.div
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="w-full max-w-md bg-dark-card border border-neon-purple/40 rounded-2xl p-6 shadow-2xl"
      >
        <div className="text-center mb-5">
          <span className="text-[10px] font-mono uppercase tracking-widest text-neon-purple">🃏 Market emptied — All Hands on Deck</span>
          <h3 className="text-lg font-black font-display text-white mt-1">Counting every hand…</h3>
        </div>

        <div className="space-y-2">
          {data.totals.map((p, i) => {
            const isOut = revealElim && p.eliminated;
            const safe = revealElim && !p.eliminated;
            return (
              <motion.div
                key={p.name + i}
                initial={{ x: -18, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                transition={{ delay: i * 0.12 }}
                className={`flex items-center justify-between rounded-xl border px-4 py-2.5 transition-colors ${
                  isOut ? 'border-red-500/60 bg-red-950/40' : safe ? 'border-neon-green/30 bg-neon-green/5' : 'border-slate-800 bg-slate-900/50'
                }`}
              >
                <span className={`font-mono text-sm truncate ${isOut ? 'text-red-300 font-bold' : safe ? 'text-neon-green' : 'text-slate-200'}`}>
                  {p.name}{isOut && ' ❌'}{safe && ' ✓'}
                </span>
                <span className={`font-display font-black text-xl tabular-nums ${isOut ? 'text-red-400' : 'text-white'}`}>
                  <CountUp target={p.total} />
                </span>
              </motion.div>
            );
          })}
        </div>

        <div className="mt-5 text-center min-h-[22px]">
          {revealElim && (
            <motion.p initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="text-xs font-mono text-red-300">
              Highest total ({data.maxSum}) — <span className="font-bold">{data.eliminatedName}</span> is knocked out.
              {' '}{data.remaining} player{data.remaining !== 1 ? 's' : ''} left.
            </motion.p>
          )}
        </div>
      </motion.div>
    </div>
  );
}
