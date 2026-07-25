import React from 'react';
import { motion } from 'motion/react';
import { GameState, ChatMessage } from '../types.js';
import { formatNaira } from '../currency.js';
import { Swords, Trophy, Users, Loader2, MessageSquare, Send } from 'lucide-react';

// All Hands on Deck — the pre-game lobby and the end-of-game result overlay.
// While a game is actually 'playing', App renders the shared GameBoard instead;
// this component covers everything around it (waiting to start, and the
// last-player-standing result). Live play, elimination and the survival rules
// are all driven server-side (room.mode === 'all-hands').
interface AllHandsResult {
  youWon: boolean;
  winnerName: string;
  prize: number;
}

interface Props {
  gameState: GameState | null;
  email: string;
  myName: string;
  sponsorName?: string;
  prize?: number;
  result: AllHandsResult | null;
  starting: boolean;
  onStart: () => void;
  onPlayAgain: () => void;
  chatMessages: ChatMessage[];
  chatInput: string;
  onChatInput: (v: string) => void;
  onSendChat: (e: React.FormEvent) => void;
}

const seatColor = (c?: string | null) =>
  c === 'red' ? 'text-neon-pink' : c === 'green' ? 'text-neon-green' : c === 'yellow' ? 'text-amber-400' : 'text-neon-cyan';

export default function AllHandsScreen({
  gameState, email, myName, sponsorName, prize, result, starting,
  onStart, onPlayAgain, chatMessages, chatInput, onChatInput, onSendChat,
}: Props) {
  // --- Result overlay (last player standing) --------------------------------
  if (result) {
    return (
      <div className="max-w-lg mx-auto">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className={`rounded-2xl p-8 text-center border ${
            result.youWon
              ? 'bg-gradient-to-br from-neon-green/15 to-slate-950 border-neon-green/40'
              : 'bg-dark-card border-slate-800'
          }`}
        >
          <Trophy className={`w-14 h-14 mx-auto mb-4 ${result.youWon ? 'text-neon-green' : 'text-slate-500'}`} />
          {result.youWon ? (
            <>
              <h2 className="text-2xl font-black font-display text-white">You're the last player standing! 🏆</h2>
              <p className="text-sm font-mono text-neon-green mt-2 neon-glow-green">
                You win {formatNaira(result.prize)}
              </p>
            </>
          ) : (
            <>
              <h2 className="text-2xl font-black font-display text-white">{result.winnerName} takes it</h2>
              <p className="text-sm font-mono text-slate-400 mt-2">
                Last player standing — {formatNaira(result.prize)}. Better luck next hand.
              </p>
            </>
          )}
          <button
            onClick={onPlayAgain}
            className="mt-6 px-6 py-2.5 rounded-lg bg-neon-purple hover:bg-neon-purple/90 text-white font-mono font-bold text-xs tracking-wider shadow-[0_0_15px_rgba(157,78,221,0.3)] cursor-pointer"
          >
            Play again
          </button>
        </motion.div>
      </div>
    );
  }

  // --- Pre-game lobby --------------------------------------------------------
  const players = gameState?.players ?? [];
  const seated = players.filter(p => p.id === email).length > 0;

  return (
    <div className="max-w-lg mx-auto space-y-4">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-gradient-to-br from-neon-purple/10 to-slate-950 border border-neon-purple/30 rounded-2xl p-6"
      >
        <div className="text-center">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-mono tracking-widest text-neon-purple uppercase bg-neon-purple/5 border border-neon-purple/20 px-2.5 py-0.5 rounded">
            <Swords className="w-3 h-3" /> Survival Mode
          </span>
          <h2 className="text-2xl font-black font-display text-white mt-3">All Hands on Deck</h2>
          <p className="text-xs font-mono text-slate-400 mt-2 leading-relaxed">
            No checking out. When the market's draw pile runs dry, <span className="text-white">every hand is counted</span> and
            the highest total is knocked out. Survivors are redealt and it repeats until one player is left standing.
          </p>
          {prize ? (
            <div className="mt-4 inline-flex flex-col items-center">
              <span className="text-[9px] font-mono text-slate-500 uppercase tracking-widest">Last standing wins</span>
              <span className="text-xl font-black font-display text-neon-green neon-glow-green">{formatNaira(prize)}</span>
              {sponsorName && <span className="text-[10px] font-mono text-slate-500">sponsored by {sponsorName}</span>}
            </div>
          ) : null}
        </div>

        {/* Seated players */}
        <div className="mt-5 bg-slate-900/50 border border-slate-800 rounded-xl p-3">
          <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-2">
            <Users className="w-3.5 h-3.5 text-neon-cyan" /> At the table ({players.length})
          </div>
          {players.length === 0 ? (
            <p className="text-[11px] font-mono text-slate-500">Waiting for you to take a seat…</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {players.map(p => (
                <span
                  key={p.id}
                  className={`text-[11px] font-mono font-bold px-2 py-1 rounded bg-slate-950 border border-slate-800 ${seatColor(p.color)}`}
                >
                  {p.id === email ? `${p.name} (you)` : p.name}
                </span>
              ))}
            </div>
          )}
          <p className="text-[10px] font-mono text-slate-500 mt-2">
            wait for more players to join.
          </p>
        </div>

        <button
          onClick={onStart}
          disabled={!seated || starting}
          className="mt-4 w-full py-2.5 rounded-lg bg-neon-green hover:bg-neon-green/90 text-[#050505] font-mono font-bold text-xs tracking-wider shadow-[0_0_15px_rgba(0,255,102,0.25)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {starting ? (<><Loader2 className="w-4 h-4 animate-spin" /> Dealing…</>) : 'Deal & Play now'}
        </button>
      </motion.div>

      {/* Arena chat */}
      <div className="bg-dark-card border border-slate-800 rounded-2xl p-4 flex flex-col h-[240px]">
        <h3 className="text-xs uppercase font-mono tracking-wider text-slate-400 mb-3 flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-neon-purple" /> Table Chat
        </h3>
        <div className="flex-1 overflow-y-auto space-y-2 mb-3 pr-1">
          {chatMessages.length === 0 ? (
            <div className="text-center py-8 font-mono text-xs text-slate-500">Say hi to the table.</div>
          ) : (
            chatMessages.map(cm => (
              <div key={cm.id} className="text-xs font-mono leading-snug">
                <span className={`font-bold ${seatColor(cm.senderColor)}`}>{cm.senderName}:</span>
                <span className="text-slate-300 ml-1.5">{cm.message}</span>
              </div>
            ))
          )}
        </div>
        <form onSubmit={onSendChat} className="flex gap-2">
          <input
            value={chatInput}
            onChange={(e) => onChatInput(e.target.value)}
            placeholder={`Message as ${myName}…`}
            className="flex-1 bg-slate-900 border border-slate-800 rounded-lg py-2 px-3 font-mono text-xs text-white focus:outline-none focus:border-neon-purple/60"
          />
          <button type="submit" className="px-3 rounded-lg bg-neon-purple hover:bg-neon-purple/90 text-white cursor-pointer">
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
