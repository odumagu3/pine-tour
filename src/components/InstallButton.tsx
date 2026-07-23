import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Download, Share, PlusSquare, X, Smartphone } from 'lucide-react';
import { usePwaInstall } from '../usePwaInstall.js';

interface InstallButtonProps {
  /** 'full' = prominent full-width lobby button, 'compact' = header pill. */
  variant?: 'full' | 'compact';
  className?: string;
}

export default function InstallButton({ variant = 'full', className = '' }: InstallButtonProps) {
  const { canInstall, needsManualInstructions, promptInstall } = usePwaInstall();
  const [showIosHelp, setShowIosHelp] = useState(false);

  // Already installed / running standalone → render nothing.
  if (!canInstall) return null;

  const handleClick = async () => {
    if (needsManualInstructions) {
      setShowIosHelp(true);
      return;
    }
    await promptInstall();
  };

  const base =
    'inline-flex items-center justify-center gap-2 font-mono font-bold transition-all cursor-pointer';

  const button =
    variant === 'full' ? (
      <button
        onClick={handleClick}
        className={`${base} w-full py-2.5 rounded-lg bg-neon-green/10 hover:bg-neon-green/20 border border-neon-green/40 text-neon-green text-xs tracking-wider shadow-[0_0_15px_rgba(34,197,94,0.15)] ${className}`}
      >
        <Download className="w-4 h-4" />
        Install App
      </button>
    ) : (
      <button
        onClick={handleClick}
        title="Install Neon Whot! Bet as an app"
        className={`${base} px-3 py-1.5 rounded-lg bg-neon-green/10 hover:bg-neon-green/20 border border-neon-green/40 text-neon-green text-[10px] tracking-wider ${className}`}
      >
        <Download className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Install App</span>
      </button>
    );

  return (
    <>
      {button}

      <AnimatePresence>
        {showIosHelp && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-4"
            onClick={() => setShowIosHelp(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: 30, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 30, scale: 0.98 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm bg-dark-card border border-slate-800 rounded-2xl p-5 shadow-2xl relative"
            >
              <button
                onClick={() => setShowIosHelp(false)}
                className="absolute top-3 right-3 text-slate-500 hover:text-white cursor-pointer"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>

              <div className="flex items-center gap-2 mb-4">
                <Smartphone className="w-5 h-5 text-neon-green" />
                <h3 className="text-sm font-display font-bold text-white">Install on iPhone / iPad</h3>
              </div>

              <ol className="space-y-3 text-xs font-mono text-slate-300">
                <li className="flex items-start gap-2.5">
                  <span className="flex-shrink-0 w-5 h-5 rounded bg-neon-purple/20 border border-neon-purple/40 text-neon-purple flex items-center justify-center text-[10px] font-bold">1</span>
                  <span className="flex items-center gap-1.5 flex-wrap">
                    Tap the <Share className="w-4 h-4 inline text-neon-cyan" /> <span className="text-white">Share</span> button in Safari's toolbar.
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="flex-shrink-0 w-5 h-5 rounded bg-neon-purple/20 border border-neon-purple/40 text-neon-purple flex items-center justify-center text-[10px] font-bold">2</span>
                  <span className="flex items-center gap-1.5 flex-wrap">
                    Choose <PlusSquare className="w-4 h-4 inline text-neon-cyan" /> <span className="text-white">Add to Home Screen</span>.
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="flex-shrink-0 w-5 h-5 rounded bg-neon-purple/20 border border-neon-purple/40 text-neon-purple flex items-center justify-center text-[10px] font-bold">3</span>
                  <span>Tap <span className="text-white">Add</span> — Neon Whot! Bet lands on your home screen like a native app.</span>
                </li>
              </ol>

              <button
                onClick={() => setShowIosHelp(false)}
                className="mt-5 w-full py-2 rounded-lg bg-neon-purple/90 hover:bg-neon-purple text-white font-mono font-bold text-xs cursor-pointer"
              >
                Got it
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
