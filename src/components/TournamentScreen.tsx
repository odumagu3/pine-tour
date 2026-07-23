import React from 'react';
import { motion } from 'motion/react';
import { Hourglass, Crown, Trophy, Swords, Wallet, Users, Loader2, Ticket, Gift, AlertCircle } from 'lucide-react';
import { formatNaira } from '../currency.js';

export type TourneyPhase = 'join' | 'lobby' | 'waiting' | 'eliminated' | 'champion';

interface TournamentInfo {
  entrantCount?: number;
  prize?: number;
  sponsorName?: string;
  round?: number;
  bye?: boolean;
}

interface TournamentScreenProps {
  phase: TourneyPhase;
  info: TournamentInfo;
  onGoToCashier: () => void;
  // 'join' phase extras
  ticketCount?: number;
  freeGameAvailable?: boolean;
  canAfford?: boolean;
  error?: string;
  registering?: boolean;
  onRegister?: () => void;
}

export default function TournamentScreen({ phase, info, onGoToCashier, ticketCount = 0, freeGameAvailable = false, canAfford = false, error = '', registering = false, onRegister }: TournamentScreenProps) {
  return (
    <div className="w-full max-w-md mx-auto py-10">
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-dark-card border border-slate-800 rounded-2xl p-8 text-center shadow-2xl relative overflow-hidden"
      >
        <div className="absolute -top-12 -right-12 w-32 h-32 bg-neon-purple/10 rounded-full blur-3xl" />

        {phase === 'join' && (
          <>
            <Ticket className="w-14 h-14 text-neon-purple mx-auto mb-4" />
            <h2 className="text-xl font-black font-display text-white">Join the Tournament</h2>
            <p className="text-xs text-slate-400 font-mono mt-2 leading-relaxed">
              Entry buy-in is <span className="text-white">1 ticket</span>
              {freeGameAvailable ? ' — or use your free game.' : '.'} Winner takes the cash prize.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <Tile icon={<Trophy className="w-4 h-4" />} label="Cash Prize" value={formatNaira(info.prize ?? 0)} accent />
              <Tile icon={<Ticket className="w-4 h-4" />} label="Your Tickets" value={String(ticketCount)} />
            </div>

            {freeGameAvailable && (
              <div className="mt-3 inline-flex items-center gap-1.5 text-[10px] font-mono bg-neon-green/10 border border-neon-green/40 text-neon-green px-2.5 py-1 rounded">
                <Gift className="w-3 h-3" /> You have 1 free game available
              </div>
            )}

            {error && (
              <div className="mt-4 p-3 bg-red-950/40 border border-red-500/30 rounded-lg text-[11px] text-red-400 font-mono flex items-center gap-2 text-left">
                <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
              </div>
            )}

            <div className="mt-5 space-y-2">
              {canAfford ? (
                <button
                  onClick={onRegister}
                  disabled={registering}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-neon-purple hover:bg-neon-purple/90 text-white font-mono font-bold text-xs cursor-pointer disabled:opacity-60"
                >
                  {registering ? <><Loader2 className="w-4 h-4 animate-spin" /> Registering…</> : <><Swords className="w-4 h-4" /> Register Now</>}
                </button>
              ) : (
                <button
                  onClick={onGoToCashier}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-neon-green hover:bg-neon-green/90 text-dark-bg font-mono font-bold text-xs cursor-pointer"
                >
                  <Wallet className="w-4 h-4" /> Buy Tickets to Register
                </button>
              )}
              <button
                onClick={onGoToCashier}
                className="w-full text-[11px] font-mono text-slate-400 hover:text-white cursor-pointer py-1"
              >
                {canAfford ? 'Buy more tickets' : 'Go to the Cashier'}
              </button>
            </div>
          </>
        )}

        {phase === 'lobby' && (
          <>
            <Hourglass className="w-14 h-14 text-neon-purple mx-auto mb-4 animate-pulse" />
            <h2 className="text-xl font-black font-display text-white">You're Registered!</h2>
            <p className="text-xs text-slate-400 font-mono mt-2 leading-relaxed">
              Waiting for the host to start the tournament. The bracket begins the moment they do —
              stay on this screen.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <Tile icon={<Users className="w-4 h-4" />} label="Players In" value={String(info.entrantCount ?? 1)} />
              <Tile icon={<Trophy className="w-4 h-4" />} label="Cash Prize" value={formatNaira(info.prize ?? 0)} accent />
            </div>
            <div className="mt-5 flex items-center justify-center gap-2 text-[11px] font-mono text-slate-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Waiting for kickoff…
            </div>
          </>
        )}

        {phase === 'waiting' && (
          <>
            <Swords className="w-14 h-14 text-neon-green mx-auto mb-4" />
            <h2 className="text-xl font-black font-display text-white">
              {info.bye ? 'You Got a Bye!' : 'You Advanced!'}
            </h2>
            <p className="text-xs text-slate-400 font-mono mt-2 leading-relaxed">
              {info.bye
                ? `No opponent this round — you skip straight through.`
                : `You won your table in Round ${info.round ?? ''}.`}{' '}
              Sit tight — the next round is being set up.
            </p>
            <div className="mt-5 flex items-center justify-center gap-2 text-[11px] font-mono text-neon-green">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Next round starting…
            </div>
          </>
        )}

        {phase === 'eliminated' && (
          <>
            <div className="w-14 h-14 rounded-2xl bg-slate-800/60 border border-slate-700 flex items-center justify-center mx-auto mb-4">
              <Swords className="w-7 h-7 text-slate-400" />
            </div>
            <h2 className="text-xl font-black font-display text-white">Knocked Out</h2>
            <p className="text-xs text-slate-400 font-mono mt-2 leading-relaxed">
              You were eliminated in Round {info.round ?? ''}. Good run — the deck wasn't kind this time.
              Grab more tickets and jump into the next tournament.
            </p>
            <button
              onClick={onGoToCashier}
              className="mt-5 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-neon-purple hover:bg-neon-purple/90 text-white font-mono font-bold text-xs cursor-pointer"
            >
              <Wallet className="w-4 h-4" /> Buy Tickets
            </button>
          </>
        )}

        {phase === 'champion' && (
          <>
            <motion.div
              initial={{ rotate: -10, scale: 0.8 }}
              animate={{ rotate: 0, scale: 1 }}
              transition={{ type: 'spring', stiffness: 200 }}
            >
              <Crown className="w-16 h-16 text-neon-green mx-auto mb-3 drop-shadow-[0_0_12px_rgba(34,197,94,0.6)]" />
            </motion.div>
            <h2 className="text-2xl font-black font-display text-neon-green neon-glow-green">CHAMPION!</h2>
            <p className="text-xs text-slate-300 font-mono mt-2 leading-relaxed">
              You won the {info.sponsorName || ''} tournament. The cash prize has been credited to your wallet.
            </p>
            <div className="mt-4 text-3xl font-black font-display text-white">{formatNaira(info.prize ?? 0)}</div>
            <button
              onClick={onGoToCashier}
              className="mt-5 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-neon-green hover:bg-neon-green/90 text-dark-bg font-mono font-bold text-xs cursor-pointer"
            >
              <Wallet className="w-4 h-4" /> View Wallet
            </button>
          </>
        )}
      </motion.div>
    </div>
  );
}

function Tile({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-3">
      <div className="text-[9px] font-mono text-slate-500 uppercase tracking-wide flex items-center justify-center gap-1">{icon}{label}</div>
      <div className={`text-lg font-black font-display mt-1 ${accent ? 'text-neon-green' : 'text-white'}`}>{value}</div>
    </div>
  );
}
