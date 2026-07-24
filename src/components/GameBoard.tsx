import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Player, PlayerColor, WhotCard, CardSuit, GameState, AntiCheatAlert, UserProfile, PublicConfig } from '../types.js';
import { HelpCircle, AlertTriangle, Play, RefreshCw, Zap, Award, Layers, Sparkles, CheckCircle2, Volume2, VolumeX, Ticket, Gift, Trophy } from 'lucide-react';
import { playCardSound, playDrawSound, playSpecialSound, playWinSound, isSoundEnabled, setSoundEnabled, unlockAudio } from '../sound.js';
import { formatNaira, TICKET_PRICE } from '../currency.js';

interface GameBoardProps {
  gameState: GameState;
  profile: UserProfile | null;
  config: PublicConfig | null;
  activePlayerEmail: string;
  onRollDice: () => void; // Draws card
  onMoveToken: (tokenId: number) => void; // Plays card
  onAddBots: () => void;
  onGoToCashier: () => void;
}

export default function GameBoard({
  gameState,
  profile,
  config,
  activePlayerEmail,
  onRollDice,
  onMoveToken,
  onAddBots,
  onGoToCashier,
}: GameBoardProps) {
  // Ticket price + arena name from admin config (fall back to defaults).
  const unitPrice = config?.ticketPrice ?? TICKET_PRICE;
  const arenaName = config?.arenaName ?? 'Neon Whot!';
  const buyPackLabel = `🎟️ Buy Tickets (from ${formatNaira(unitPrice)} each)`;
  const wsConn = (window as any).ludoSocket;

  // Active seat (human player)
  const myPlayer = gameState.players.find(p => p.id === activePlayerEmail);
  const myColor = myPlayer?.color;
  const isMyTurn = gameState.players[gameState.activePlayerIndex]?.id === activePlayerEmail;

  // Show suit selection modal/popup when a human plays a Whot (20) wildcard
  const [showSuitDeclaration, setShowSuitDeclaration] = React.useState(false);

  // Sound on/off (persisted). Default on.
  const [soundOn, setSoundOn] = React.useState(() => isSoundEnabled());

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    setSoundEnabled(next);
  };

  // Unlock the audio context on the first user interaction (browsers require a gesture).
  React.useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  // Flying cards animation state
  const [flyingCards, setFlyingCards] = React.useState<Array<{
    id: string;
    fromPos: 'South' | 'West' | 'North' | 'East' | 'DrawPile' | 'DiscardPile';
    toPos: 'South' | 'West' | 'North' | 'East' | 'DrawPile' | 'DiscardPile';
    card?: WhotCard;
  }>>([]);

  // Check if Whot 20 was just played by us and we need to declare
  React.useEffect(() => {
    if (gameState.status === 'playing' && isMyTurn) {
      const topCard = gameState.discardPile[gameState.discardPile.length - 1];
      // If we played a 20 and there is no requested suit set yet, prompt declaration
      if (topCard && topCard.value === 20 && !gameState.requestedSuit) {
        setShowSuitDeclaration(true);
      } else {
        setShowSuitDeclaration(false);
      }
    } else {
      setShowSuitDeclaration(false);
    }
  }, [gameState.discardPile, gameState.requestedSuit, isMyTurn, gameState.status]);

  // Automatic Play Simulation state
  const [autoplay, setAutoplay] = React.useState(() => {
    return localStorage.getItem('whot_autoplay_enabled') === 'true';
  });

  React.useEffect(() => {
    localStorage.setItem('whot_autoplay_enabled', autoplay ? 'true' : 'false');
  }, [autoplay]);

  // Autoplay simulation engine
  React.useEffect(() => {
    if (!autoplay || !isMyTurn || gameState.status !== 'playing' || showSuitDeclaration) return;

    const timer = setTimeout(() => {
      if (!myPlayer) return;

      const topCard = gameState.discardPile[gameState.discardPile.length - 1];
      if (!topCard) return;

      // Find playable cards
      const playable = myPlayer.hand.filter(c => {
        if (c.value === 20) return true;
        if (gameState.requestedSuit) {
          return c.suit === gameState.requestedSuit;
        }
        return c.suit === topCard.suit || c.value === topCard.value;
      });

      if (playable.length > 0) {
        // Play first valid card
        handlePlayCard(playable[0].id);
      } else {
        // Draw card
        handleDrawCard();
      }
    }, 1500);

    return () => clearTimeout(timer);
  }, [autoplay, isMyTurn, gameState.discardPile, gameState.requestedSuit, gameState.status, showSuitDeclaration]);

  // Handlers using WS directly or falling back
  const handleDrawCard = () => {
    if (wsConn && wsConn.readyState === WebSocket.OPEN) {
      wsConn.send(JSON.stringify({ type: 'draw-card' }));
    } else {
      onRollDice(); // fallback
    }
  };

  const handlePlayCard = (cardId: string) => {
    if (wsConn && wsConn.readyState === WebSocket.OPEN) {
      wsConn.send(JSON.stringify({ type: 'play-card', cardId }));
    } else {
      // fallback mapping card index if possible
      if (myPlayer) {
        const index = myPlayer.hand.findIndex(c => c.id === cardId);
        if (index !== -1) onMoveToken(index);
      }
    }
  };

  const handleDeclareSuit = (suit: CardSuit) => {
    if (wsConn && wsConn.readyState === WebSocket.OPEN) {
      wsConn.send(JSON.stringify({ type: 'declare-suit', suit }));
    }
    setShowSuitDeclaration(false);
  };

  // Entry availability derived from the player's profile.
  const hasFreeGame = !!profile && !profile.freeGameUsed;
  const ticketsLeft = profile?.tickets ?? 0;
  const canEnter = hasFreeGame || ticketsLeft > 0;

  // Enter the sponsored tournament, then fill the table with bots and deal.
  const handleEnterTournament = () => {
    if (!canEnter) {
      onGoToCashier();
      return;
    }
    if (wsConn && wsConn.readyState === WebSocket.OPEN) {
      wsConn.send(JSON.stringify({ type: 'enter-tournament' }));

      // Fill remaining seats with bots so the match can start instantly.
      for (let i = 1; i <= 3; i++) {
        setTimeout(() => {
          if (wsConn.readyState === WebSocket.OPEN) {
            wsConn.send(JSON.stringify({ type: 'add-bots-manually' }));
          }
        }, i * 250);
      }
    }
  };

  // Helper to render suit symbol nicely
  const getSuitSymbol = (suit: CardSuit) => {
    switch (suit) {
      case 'circle': return { icon: '⭕', label: 'Circle', color: 'text-rose-400 border-rose-500/20 bg-rose-950/20' };
      case 'triangle': return { icon: '🔺', label: 'Triangle', color: 'text-cyan-400 border-cyan-500/20 bg-cyan-950/20' };
      case 'cross': return { icon: '➕', label: 'Cross', color: 'text-amber-400 border-amber-500/20 bg-amber-950/20' };
      case 'square': return { icon: '⏹️', label: 'Square', color: 'text-violet-400 border-violet-500/20 bg-violet-950/20' };
      case 'star': return { icon: '⭐', label: 'Star', color: 'text-emerald-400 border-emerald-500/20 bg-emerald-950/20' };
      case 'whot': return { icon: '🌟', label: 'Whot', color: 'text-pink-400 border-pink-500/30 bg-pink-950/30 font-bold animate-pulse' };
    }
  };

  const getCardColorTheme = (suit: CardSuit) => {
    switch (suit) {
      case 'circle': return 'from-rose-900/60 to-slate-950 border-rose-500/40 text-rose-300';
      case 'triangle': return 'from-cyan-900/60 to-slate-950 border-cyan-500/40 text-cyan-300';
      case 'cross': return 'from-amber-900/60 to-slate-950 border-amber-500/40 text-amber-300';
      case 'square': return 'from-violet-900/60 to-slate-950 border-violet-500/40 text-violet-300';
      case 'star': return 'from-emerald-900/60 to-slate-950 border-emerald-500/40 text-emerald-300';
      case 'whot': return 'from-pink-900/60 to-purple-950 border-pink-500/60 text-pink-300 shadow-[0_0_15px_rgba(236,72,153,0.3)]';
    }
  };

  // Get seat positions relative to screen coordinates for 4 seats
  const getOpponentsList = (): { pos: 'South' | 'West' | 'North' | 'East'; player: Player; isActive: boolean }[] => {
    if (!myPlayer) {
      const positions: ('South' | 'West' | 'North' | 'East')[] = ['South', 'West', 'North', 'East'];
      return gameState.players.map((p, idx) => ({
        pos: positions[idx % 4],
        player: p,
        isActive: gameState.activePlayerIndex === idx
      }));
    }
    
    const myIndex = gameState.players.findIndex(p => p.id === activePlayerEmail);
    const list: { pos: 'South' | 'West' | 'North' | 'East'; player: Player; isActive: boolean }[] = [];

    // South is always YOU
    list.push({ pos: 'South', player: myPlayer, isActive: gameState.activePlayerIndex === myIndex });

    // Arrange others clockwise (West, North, East)
    const positions: ('West' | 'North' | 'East')[] = ['West', 'North', 'East'];
    let posIndex = 0;

    for (let i = 1; i < 4; i++) {
      const idx = (myIndex + i) % gameState.players.length;
      if (gameState.players[idx]) {
        list.push({
          pos: positions[posIndex++],
          player: gameState.players[idx],
          isActive: gameState.activePlayerIndex === idx
        });
      }
    }
    return list;
  };

  const seats = getOpponentsList();
  const topCard = gameState.discardPile[gameState.discardPile.length - 1];

  // Check which cards are playable
  const getPlayableCardIds = () => {
    if (!isMyTurn || !myPlayer || !topCard || showSuitDeclaration) return [];
    return myPlayer.hand.filter(c => {
      if (c.value === 20) return true;
      if (gameState.requestedSuit) {
        return c.suit === gameState.requestedSuit;
      }
      return c.suit === topCard.suit || c.value === topCard.value;
    }).map(c => c.id);
  };

  const playableCardIds = getPlayableCardIds();

  // Coordinates mapping helper for flying animations
  const getCoordinates = (pos: 'South' | 'West' | 'North' | 'East' | 'DrawPile' | 'DiscardPile') => {
    switch (pos) {
      case 'South': return { left: '50%', top: '85%' };
      case 'North': return { left: '50%', top: '15%' };
      case 'West': return { left: '15%', top: '50%' };
      case 'East': return { left: '85%', top: '50%' };
      case 'DrawPile': return { left: '42%', top: '50%' };
      case 'DiscardPile': return { left: '58%', top: '50%' };
      default: return { left: '50%', top: '50%' };
    }
  };

  const prevGameStateRef = React.useRef<GameState | null>(null);

  React.useEffect(() => {
    if (!prevGameStateRef.current) {
      prevGameStateRef.current = gameState;
      return;
    }

    const prev = prevGameStateRef.current;
    const curr = gameState;

    // Round just ended — celebratory chime.
    if (prev.status !== 'finished' && curr.status === 'finished') {
      playWinSound();
    }

    if (prev.status === 'playing' && curr.status === 'playing') {
      const currTop = curr.discardPile[curr.discardPile.length - 1];

      curr.players.forEach(currPlayer => {
        const prevPlayer = prev.players.find(p => p.id === currPlayer.id);
        if (prevPlayer) {
          const prevCount = (prevPlayer.hand ? prevPlayer.hand.length : 0) || prevPlayer.cardsCount || 0;
          const currCount = (currPlayer.hand ? currPlayer.hand.length : 0) || currPlayer.cardsCount || 0;

          if (currCount < prevCount) {
            // Card played! Play the whot card snap sound (special flourish for action cards).
            const isSpecial = !!currTop && [1, 2, 5, 8, 14, 20].includes(currTop.value);
            if (isSpecial) playSpecialSound();
            else playCardSound();

            // Find seat position
            const seat = seats.find(s => s.player.id === currPlayer.id);
            if (seat) {
              const id = `play_${Date.now()}_${currPlayer.id}_${Math.random()}`;
              setFlyingCards(prevList => [
                ...prevList,
                {
                  id,
                  fromPos: seat.pos,
                  toPos: 'DiscardPile',
                  card: currTop || undefined,
                }
              ]);
              setTimeout(() => {
                setFlyingCards(prevList => prevList.filter(fc => fc.id !== id));
              }, 800);
            }
          } else if (currCount > prevCount) {
            // Card drawn! Soft swoosh from the market pile.
            playDrawSound();

            // Find seat position
            const seat = seats.find(s => s.player.id === currPlayer.id);
            if (seat) {
              const id = `draw_${Date.now()}_${currPlayer.id}_${Math.random()}`;
              setFlyingCards(prevList => [
                ...prevList,
                {
                  id,
                  fromPos: 'DrawPile',
                  toPos: seat.pos,
                }
              ]);
              setTimeout(() => {
                setFlyingCards(prevList => prevList.filter(fc => fc.id !== id));
              }, 800);
            }
          }
        }
      });
    }

    prevGameStateRef.current = gameState;
  }, [gameState, seats]);

  return (
    <div className="w-full max-w-5xl mx-auto" id="game_board_parent">
      <div className="bg-dark-card border border-slate-800 rounded-2xl sm:rounded-3xl p-3 sm:p-6 shadow-3xl relative overflow-hidden" id="game_arena_container">
        {/* Deep poker felt ambient background */}
        <div className="absolute inset-0 bg-gradient-to-b from-slate-950 via-emerald-950/30 to-slate-950 pointer-events-none" />

        {/* TOP META-HEADER OF ARENA */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-900 relative z-10">
          <div className="flex items-center gap-3">
            <Layers className="w-5 h-5 text-neon-purple animate-pulse" />
            <div>
              <h2 className="text-sm font-bold tracking-tight text-white font-mono flex items-center gap-2">
                🎰 {arenaName.toUpperCase()} TOURNAMENT TABLE
              </h2>
              <p className="text-[10px] text-slate-500 font-mono">
                {gameState.sponsorName ? <>Sponsored by <strong className="text-neon-purple">{gameState.sponsorName}</strong> • </> : null}
                Cash Prize: <strong className="text-neon-green">{formatNaira(gameState.sponsorPrize)}</strong>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <button
              onClick={toggleSound}
              title={soundOn ? 'Mute sound effects' : 'Enable sound effects'}
              aria-label={soundOn ? 'Mute sound effects' : 'Enable sound effects'}
              className={`text-[10px] px-2 py-1 rounded-full border font-mono flex items-center gap-1.5 transition-all cursor-pointer ${
                soundOn
                  ? 'bg-neon-green/5 border-neon-green/30 text-neon-green'
                  : 'bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-300'
              }`}
            >
              {soundOn ? <Volume2 className="w-3 h-3" /> : <VolumeX className="w-3 h-3" />}
              <span className="hidden sm:inline">{soundOn ? 'SOUND ON' : 'MUTED'}</span>
            </button>

            <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-900 border border-slate-800 font-mono text-slate-400 flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${gameState.status === 'playing' ? 'bg-neon-green animate-pulse' : 'bg-amber-400'}`} />
              STATUS: {gameState.status.toUpperCase()}
            </span>

            {gameState.status === 'playing' && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-950/30 border border-red-500/20 font-mono text-red-400 flex items-center gap-1.5">
                ⌛ Turn Time: {gameState.turnTimeLeft}s
              </span>
            )}
          </div>
        </div>

        {/* 1. LOBBY STATE PANEL */}
        {gameState.status === 'waiting' || gameState.status === 'betting' ? (
          <div className="py-16 flex flex-col items-center justify-center text-center max-w-lg mx-auto relative z-10" id="lobby_betting_panel">
            <div className="h-16 w-16 bg-neon-purple/10 border border-neon-purple/30 rounded-2xl flex items-center justify-center mb-6 shadow-[0_0_20px_rgba(157,78,221,0.2)] animate-bounce-slow">
              <Layers className="w-8 h-8 text-neon-purple" />
            </div>

            <h3 className="text-xl font-bold text-white tracking-tight">
              {gameState.sponsorName || 'Sponsored'} Whot! Tournament
            </h3>
            <p className="text-xs text-slate-400 mt-2 font-mono leading-relaxed">
              Enter the tournament to compete for the sponsor's cash prize. Be the first to clear your hand to win it all.
            </p>

            {/* SPONSOR PRIZE HERO */}
            <div className="w-full bg-gradient-to-br from-emerald-950/40 to-slate-950 rounded-2xl p-5 border border-emerald-500/20 my-6 flex items-center justify-between shadow-[0_0_20px_rgba(16,185,129,0.1)]">
              <div className="text-left">
                <span className="text-[10px] uppercase font-mono tracking-widest text-emerald-400/70 flex items-center gap-1.5">
                  <Trophy className="w-3.5 h-3.5" /> Sponsor Cash Prize
                </span>
                <span className="text-3xl font-black font-display text-neon-green neon-glow-green block mt-1">
                  {formatNaira(gameState.sponsorPrize)}
                </span>
              </div>
              <div className="text-right">
                <span className="text-[9px] uppercase font-mono tracking-widest text-slate-500 block">Sponsored by</span>
                <span className="text-sm font-bold font-mono text-neon-purple">{gameState.sponsorName || '—'}</span>
              </div>
            </div>

            {/* SEATED PLAYERS */}
            <div className="w-full bg-slate-950/60 rounded-2xl p-4 border border-slate-900/80 mb-6 space-y-3">
              <div className="flex items-center justify-between text-xs font-mono text-slate-400 pb-2 border-b border-slate-900/40">
                <span>Entrants Seated:</span>
                <span className="text-white font-bold">{gameState.players.length} / 4 Players</span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {gameState.players.map((p) => (
                  <div key={p.id} className="p-2 bg-slate-900/40 rounded-lg border border-slate-800/40 text-left flex items-center justify-between">
                    <div className="flex items-center gap-2 overflow-hidden">
                      <span className={`w-2 h-2 rounded-full ${p.color === 'red' ? 'bg-rose-500' : p.color === 'green' ? 'bg-emerald-500' : p.color === 'yellow' ? 'bg-amber-400' : 'bg-cyan-400'}`} />
                      <span className="text-[11px] font-bold font-mono text-slate-300 truncate">{p.name}</span>
                    </div>
                    <span className={`text-[9px] px-1.5 py-0.2 rounded font-mono font-bold ${p.ready ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/20' : 'bg-slate-950 text-slate-500'}`}>
                      {p.ready ? 'ENTERED' : 'WAITING'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* ENTRY COST + CTA */}
            <div className="text-center space-y-3 w-full">
              <div className={`text-[11px] font-mono px-3 py-2 rounded-xl border inline-flex items-center gap-1.5 ${
                hasFreeGame
                  ? 'bg-neon-green/5 border-neon-green/30 text-neon-green'
                  : ticketsLeft > 0
                    ? 'bg-neon-purple/5 border-neon-purple/30 text-neon-purple'
                    : 'bg-red-950/30 border-red-500/30 text-red-400'
              }`}>
                {hasFreeGame ? (
                  <><Gift className="w-3.5 h-3.5" /> Your first game is FREE</>
                ) : ticketsLeft > 0 ? (
                  <><Ticket className="w-3.5 h-3.5" /> Costs 1 ticket · {ticketsLeft} left</>
                ) : (
                  <><Ticket className="w-3.5 h-3.5" /> No tickets left — buy a pack to play</>
                )}
              </div>

              {canEnter ? (
                <button
                  onClick={handleEnterTournament}
                  className="w-full max-w-sm mx-auto block px-5 py-3 rounded-xl bg-neon-green hover:bg-neon-green/90 text-dark-bg font-mono text-[12px] font-bold transition-all cursor-pointer shadow-[0_0_15px_rgba(16,185,129,0.3)]"
                >
                  {hasFreeGame ? '🎁 Play Free Game + Fill Table' : `🎟️ Enter Tournament (1 Ticket) + Fill Table`}
                </button>
              ) : (
                <button
                  onClick={onGoToCashier}
                  className="w-full max-w-sm mx-auto block px-5 py-3 rounded-xl bg-neon-purple hover:bg-neon-purple/90 text-white font-mono text-[12px] font-bold transition-all cursor-pointer shadow-[0_0_15px_rgba(157,78,221,0.3)]"
                >
                  {buyPackLabel}
                </button>
              )}
            </div>
          </div>
        ) : gameState.status === 'playing' ? (
          /* 2. LIVE CARD TABLE ARENA */
          <div className="py-4 sm:py-6 flex flex-col relative z-10" id="live_card_arena">

            {/* MOBILE OPPONENTS STRIP — avoids the cramped absolute oval seating on phones */}
            <div className="sm:hidden flex flex-wrap justify-center gap-2 mb-4">
              {seats.filter(s => s.pos !== 'South').map((seat) => {
                const colorTheme =
                  seat.player.color === 'red' ? 'text-rose-400 border-rose-500/30' :
                  seat.player.color === 'green' ? 'text-emerald-400 border-emerald-500/30' :
                  seat.player.color === 'yellow' ? 'text-amber-400 border-amber-500/30' :
                  'text-cyan-400 border-cyan-500/30';
                return (
                  <div
                    key={seat.player.id}
                    className={`relative rounded-2xl border p-2 flex flex-col items-center gap-1 font-mono transition-all w-[30%] min-w-[96px] max-w-[130px] ${
                      seat.isActive
                        ? 'border-yellow-500 bg-yellow-950/20 shadow-[0_0_12px_rgba(234,179,8,0.25)]'
                        : 'border-slate-800 bg-slate-950/70'
                    }`}
                  >
                    {seat.isActive && (
                      <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-yellow-500 rounded-full animate-ping" />
                    )}
                    <div className="relative">
                      <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-sm border bg-slate-900/60 ${colorTheme} ${seat.player.predestined ? 'ring-2 ring-amber-400' : ''}`}>
                        {"👤"}
                      </div>
                      <span className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-slate-950 ${seat.player.isConnected ? 'bg-emerald-500' : 'bg-red-500'}`} />
                      {seat.player.predestined && <span className="absolute -top-2 -left-2 text-[11px]" title="Predetermined winner">👑</span>}
                    </div>
                    <span className={`text-[10px] font-bold max-w-full truncate w-full text-center ${seat.player.predestined ? 'text-amber-300' : 'text-white'}`}>{seat.player.name}</span>
                    {seat.player.predestined
                      ? <span className="text-[8px] font-mono text-amber-400 uppercase tracking-wide">👑 Winner</span>
                      : <span className="text-[9px] text-slate-400">🎴 {seat.player.cardsCount}</span>}
                  </div>
                );
              })}
            </div>

            {/* OVAL POKER/FELT TABLE DESIGN */}
            <div className="w-full aspect-[4/3] sm:aspect-[16/10] bg-slate-950/80 border-2 border-slate-900 rounded-[40px] sm:rounded-[80px] relative p-2 sm:p-4 flex items-center justify-center shadow-inner overflow-hidden max-w-4xl mx-auto">
              <div className="absolute inset-0 bg-radial-felt pointer-events-none" />

              {/* OVAL FELT INNER LINE BORDER */}
              <div className="absolute inset-4 sm:inset-8 border border-emerald-500/10 rounded-[30px] sm:rounded-[60px] pointer-events-none" />

              {/* SEATED PLAYERS PLACEMENT AROUND TABLE */}
              {seats.map((seat) => {
                const isMe = seat.player.id === activePlayerEmail;
                const topP = seat.pos === 'North';
                const leftP = seat.pos === 'West';
                const rightP = seat.pos === 'East';
                const bottomP = seat.pos === 'South';

                // Assign absolute coordinates for visual positioning
                let seatCoords = "bottom-1 sm:bottom-2 left-1/2 -translate-x-1/2"; // South (YOU)
                if (topP) seatCoords = "top-2 sm:top-4 left-1/2 -translate-x-1/2";
                if (leftP) seatCoords = "left-1 sm:left-4 top-1/2 -translate-y-1/2";
                if (rightP) seatCoords = "right-1 sm:right-4 top-1/2 -translate-y-1/2";

                const playerColorTheme = 
                  seat.player.color === 'red' ? 'text-rose-400 border-rose-500/30 bg-rose-950/10' :
                  seat.player.color === 'green' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-950/10' :
                  seat.player.color === 'yellow' ? 'text-amber-400 border-amber-500/30 bg-amber-950/10' :
                  'text-cyan-400 border-cyan-500/30 bg-cyan-950/10';

                return (
                  <div
                    key={seat.player.id}
                    className={`hidden sm:flex absolute z-20 p-1.5 sm:p-2.5 rounded-xl sm:rounded-2xl border transition-all duration-300 items-center gap-1.5 sm:gap-2.5 font-mono ${seatCoords} ${
                      seat.isActive
                        ? 'border-yellow-500 bg-yellow-950/20 shadow-[0_0_15px_rgba(234,179,8,0.25)] scale-105'
                        : 'border-slate-800 bg-slate-950/80'
                    }`}
                  >
                    {/* Active turn indicator beacon */}
                    {seat.isActive && (
                      <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-yellow-500 rounded-full animate-ping" />
                    )}

                    <div className="relative">
                      <div className={`w-6 h-6 sm:w-8 sm:h-8 rounded-lg sm:rounded-xl flex items-center justify-center font-bold text-[10px] sm:text-xs border ${playerColorTheme} ${seat.player.predestined ? 'ring-2 ring-amber-400' : ''}`}>
                        {"👤"}
                      </div>
                      <span className={`absolute -bottom-1 -right-1 w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full border border-slate-950 ${seat.player.isConnected ? 'bg-emerald-500' : 'bg-red-500'}`} />
                      {seat.player.predestined && <span className="absolute -top-2 -left-2 text-[11px]" title="Predetermined winner">👑</span>}
                    </div>

                    <div className="text-left text-[9px] sm:text-[10px]">
                      <div className={`font-bold max-w-[52px] sm:max-w-[80px] truncate ${seat.player.predestined ? 'text-amber-300' : 'text-white'}`}>{seat.player.name} {isMe && "(You)"}</div>
                      {seat.player.predestined && <div className="text-[8px] font-mono text-amber-400 uppercase tracking-wide">👑 Winner</div>}
                      <div className="text-slate-500 flex items-center gap-1">
                        <span>🎴 {seat.player.cardsCount}<span className="hidden sm:inline"> cards</span></span>
                      </div>
                      <div className="text-[8px] sm:text-[9px] text-neon-green font-bold flex items-center gap-0.5"><Ticket className="w-2.5 h-2.5" /> Entered</div>
                    </div>
                  </div>
                );
              })}

              {/* CENTER OF TABLE: DISCARD PILE, MARKET DRAW PILE & GAME STATS */}
              <div className="flex flex-row items-center justify-center gap-6 sm:gap-8 z-10" id="card_table_deck_center">
                
                {/* DRAW PILE (MARKET) */}
                <div className="flex flex-col items-center">
                  <div className="text-[9px] font-mono text-slate-500 uppercase tracking-widest mb-1.5">Draw Pile</div>
                  <motion.button
                    whileHover={{ scale: isMyTurn && !showSuitDeclaration ? 1.05 : 1 }}
                    whileTap={{ scale: isMyTurn && !showSuitDeclaration ? 0.95 : 1 }}
                    onClick={isMyTurn && !showSuitDeclaration ? handleDrawCard : undefined}
                    disabled={!isMyTurn || showSuitDeclaration}
                    className={`relative w-16 h-24 sm:w-20 sm:h-28 rounded-xl border flex flex-col items-center justify-center font-bold transition-all shadow-2xl ${
                      isMyTurn && !showSuitDeclaration
                        ? 'border-neon-purple bg-gradient-to-br from-neon-purple/20 via-slate-950 to-slate-950 shadow-[0_0_15px_rgba(157,78,221,0.4)] cursor-pointer'
                        : 'border-slate-800 bg-slate-900/60 opacity-60'
                    }`}
                  >
                    {/* Retro card back patterns */}
                    <div className="absolute inset-1 border border-slate-800/40 rounded-lg flex flex-col items-center justify-center overflow-hidden">
                      <div className="absolute inset-0 bg-grid-card opacity-20" />
                      <Layers className="w-5 h-5 text-neon-purple animate-pulse mb-1" />
                      <span className="text-[12px] text-white font-mono">{gameState.drawPileCount}</span>
                      <span className="text-[7px] text-slate-500 uppercase font-mono tracking-widest mt-1">Market</span>
                    </div>
                    {isMyTurn && !showSuitDeclaration && (
                      <span className="absolute -top-1 px-1 py-0.2 bg-neon-purple text-[7px] text-white rounded font-mono animate-pulse">DRAW</span>
                    )}
                  </motion.button>
                </div>

                {/* DISCARD PILE (TOP ACTIVE CARD) */}
                <div className="flex flex-col items-center">
                  <div className="text-[9px] font-mono text-slate-500 uppercase tracking-widest mb-1.5">Discard Pile</div>
                  <AnimatePresence mode="wait">
                    {topCard ? (
                      <motion.div
                        key={topCard.id}
                        initial={{ scale: 0.8, rotate: -10, y: -10, opacity: 0 }}
                        animate={{ scale: 1, rotate: topCard.value === 20 ? 0 : 5, y: 0, opacity: 1 }}
                        className={`relative w-16 h-24 sm:w-20 sm:h-28 rounded-xl border bg-gradient-to-br flex flex-col justify-between p-2 shadow-2xl font-mono ${getCardColorTheme(topCard.suit)}`}
                      >
                        {/* Top corner val */}
                        <div className="text-left text-xs font-black flex justify-between items-center">
                          <span>{topCard.value === 20 ? "W" : topCard.value}</span>
                          <span className="text-[10px]">{getSuitSymbol(topCard.suit)?.icon}</span>
                        </div>

                        {/* Large center suit illustration */}
                        <div className="text-center text-2xl filter drop-shadow">
                          {getSuitSymbol(topCard.suit)?.icon}
                        </div>

                        {/* Bottom corner val inverted */}
                        <div className="text-right text-xs font-black flex justify-between items-center select-none rotate-180">
                          <span>{topCard.value === 20 ? "W" : topCard.value}</span>
                          <span className="text-[10px]">{getSuitSymbol(topCard.suit)?.icon}</span>
                        </div>
                      </motion.div>
                    ) : (
                      <div className="w-16 h-24 sm:w-20 sm:h-28 rounded-xl border border-dashed border-slate-800 flex items-center justify-center font-mono text-[9px] text-slate-600">
                        Empty
                      </div>
                    )}
                  </AnimatePresence>
                </div>

              </div>

              {/* REQUESTED SUIT DEMAND DISPLAY */}
              {gameState.requestedSuit && (
                <div className="absolute top-14 sm:top-24 left-1/2 -translate-x-1/2 z-20 px-3 sm:px-4 py-1 sm:py-1.5 bg-pink-950/80 border border-pink-500/30 rounded-xl font-mono text-[9px] sm:text-[10px] text-pink-400 flex items-center gap-1.5 sm:gap-2 animate-pulse shadow-lg whitespace-nowrap">
                  <Sparkles className="w-3.5 h-3.5 text-pink-400" />
                  <span>DECLARED SUIT: <strong>{gameState.requestedSuit.toUpperCase()} {getSuitSymbol(gameState.requestedSuit)?.icon}</strong></span>
                </div>
              )}

              {/* GAME SYSTEM STATE DISPLAY */}
              {gameState.players[gameState.activePlayerIndex] && (
                <div className="absolute bottom-14 sm:bottom-20 left-1/2 -translate-x-1/2 z-20 text-center font-mono text-[9px] text-slate-400 py-1 bg-slate-950/60 px-3 border border-slate-900 rounded-full whitespace-nowrap">
                  👉 Active Turn: <strong className="text-white">{gameState.players[gameState.activePlayerIndex].name}</strong>
                </div>
              )}

              {/* FLYING CARDS ANIMATION LAYER */}
              <AnimatePresence>
                {flyingCards.map(fc => {
                  const startCoords = getCoordinates(fc.fromPos);
                  const endCoords = getCoordinates(fc.toPos);
                  if (!startCoords || !endCoords) return null;

                  return (
                    <motion.div
                      key={fc.id}
                      initial={{
                        left: startCoords.left,
                        top: startCoords.top,
                        x: "-50%",
                        y: "-50%",
                        scale: 0.5,
                        rotate: fc.fromPos === 'DrawPile' ? 0 : 45,
                        opacity: 0,
                      }}
                      animate={{
                        left: endCoords.left,
                        top: endCoords.top,
                        x: "-50%",
                        y: "-50%",
                        scale: 1.1,
                        rotate: fc.toPos === 'DiscardPile' ? [45, -15, 5] : 0,
                        opacity: [0, 1, 1, 0.9],
                      }}
                      exit={{
                        opacity: 0,
                        scale: 0.8,
                      }}
                      transition={{
                        duration: 0.6,
                        ease: "easeInOut",
                      }}
                      className="absolute z-30 pointer-events-none"
                    >
                      {fc.card ? (
                        <div className={`w-14 h-20 rounded-lg border bg-gradient-to-br flex flex-col justify-between p-1.5 shadow-2xl font-mono text-[9px] ${getCardColorTheme(fc.card.suit)}`}>
                          <div className="text-left font-black flex justify-between items-center leading-none">
                            <span>{fc.card.value === 20 ? "W" : fc.card.value}</span>
                            <span>{getSuitSymbol(fc.card.suit)?.icon}</span>
                          </div>
                          <div className="text-center text-lg filter drop-shadow leading-none">
                            {getSuitSymbol(fc.card.suit)?.icon}
                          </div>
                          <div className="text-right font-black flex justify-between items-center select-none rotate-180 leading-none">
                            <span>{fc.card.value === 20 ? "W" : fc.card.value}</span>
                            <span>{getSuitSymbol(fc.card.suit)?.icon}</span>
                          </div>
                        </div>
                      ) : (
                        <div className="w-14 h-20 rounded-lg border border-neon-purple bg-gradient-to-br from-neon-purple/20 via-slate-950 to-slate-950 flex flex-col items-center justify-center p-0.5">
                          <div className="w-full h-full border border-slate-800/40 rounded flex flex-col items-center justify-center relative overflow-hidden bg-slate-900/40">
                            <Layers className="w-4 h-4 text-neon-purple animate-pulse" />
                          </div>
                        </div>
                      )}
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>

            {/* 3. HUMAN PLAYER HAND LAYOUT CONTAINER (YOU) */}
            <div className="mt-6 sm:mt-8 relative z-10" id="human_deck_fan_portal">
              <div className="flex items-center justify-between mb-4 border-b border-slate-900 pb-2">
                <span className="text-[10px] uppercase font-mono text-slate-400 tracking-wider">Your Hand ({myPlayer?.hand.length || 0} cards)</span>
                {isMyTurn && (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-yellow-950 border border-yellow-500/30 font-mono text-yellow-500 font-bold animate-pulse">
                    ⚡ YOUR TURN TO PLAY
                  </span>
                )}
              </div>

              {/* ACTUAL HAND CARDS */}
              {myPlayer && myPlayer.hand.length > 0 ? (
                <div className="flex sm:flex-wrap items-center sm:justify-center gap-3 sm:gap-3 py-3 min-h-[112px] sm:min-h-[120px] overflow-x-auto sm:overflow-visible px-2 snap-x snap-mandatory scroll-smooth">
                  {myPlayer.hand.map((card, idx) => {
                    const isPlayable = playableCardIds.includes(card.id);
                    // Slight fan rotation effect based on card index
                    const fanRotation = (idx - (myPlayer.hand.length - 1) / 2) * 4;

                    return (
                      <motion.button
                        key={card.id}
                        whileHover={{ scale: 1.1, y: -15, rotate: 0, zIndex: 50 }}
                        whileTap={{ scale: 0.95 }}
                        initial={{ opacity: 0, y: 30 }}
                        animate={{ opacity: 1, y: 0, rotate: fanRotation }}
                        onClick={() => isPlayable && handlePlayCard(card.id)}
                        disabled={!isPlayable}
                        className={`relative w-16 h-24 sm:w-20 sm:h-28 flex-shrink-0 snap-center rounded-xl border bg-gradient-to-br flex flex-col justify-between p-2 shadow-xl font-mono text-left transition-all group ${
                          isPlayable
                            ? `${getCardColorTheme(card.suit)} cursor-pointer ring-2 ring-emerald-500/30 hover:ring-emerald-400/80 hover:shadow-[0_0_15px_rgba(16,185,129,0.3)]`
                            : 'from-slate-950 to-slate-900 border-slate-900 text-slate-600 opacity-40 select-none'
                        }`}
                        title={isPlayable ? "Click to Play Card" : "Unplayable Card"}
                      >
                        <div className="text-xs font-black flex justify-between items-center">
                          <span>{card.value === 20 ? "W" : card.value}</span>
                          <span className="text-[10px]">{getSuitSymbol(card.suit)?.icon}</span>
                        </div>

                        <div className="text-center text-2xl filter drop-shadow select-none">
                          {getSuitSymbol(card.suit)?.icon}
                        </div>

                        <div className="text-right text-xs font-black flex justify-between items-center select-none rotate-180">
                          <span>{card.value === 20 ? "W" : card.value}</span>
                          <span className="text-[10px]">{getSuitSymbol(card.suit)?.icon}</span>
                        </div>

                        {/* Special action helper badge */}
                        {[1, 2, 5, 8, 14].includes(card.value) && (
                          <span className="absolute bottom-1 right-1 text-[7px] font-bold px-1 rounded bg-slate-900 border border-slate-800 text-slate-400 uppercase tracking-tight scale-90">
                            {card.value === 1 ? "Hold" : card.value === 2 ? "Pick 2" : card.value === 5 ? "Send 3" : card.value === 8 ? "Skip" : "Market"}
                          </span>
                        )}
                      </motion.button>
                    );
                  })}
                </div>
              ) : (
                <div className="py-8 bg-slate-950/40 rounded-2xl border border-slate-900 text-center text-xs font-mono text-slate-500">
                  Spectating Seat • No cards dealt. Place a bet stake to join the active deal next round!
                </div>
              )}

              {/* DRAW HELPER PROMPT */}
              {isMyTurn && playableCardIds.length === 0 && !showSuitDeclaration && (
                <div className="mt-4 p-3 bg-indigo-950/40 border border-indigo-500/20 rounded-xl text-center font-mono text-[11px] text-indigo-400 flex items-center justify-center gap-2 animate-bounce-slow">
                  <AlertTriangle className="w-4 h-4" />
                  <span>No playable cards in hand! Click the <strong>Market Draw Pile</strong> to draw a card and skip.</span>
                </div>
              )}
            </div>

            {/* 4. WILDCARD DECLARATION POPUP MODAL */}
            <AnimatePresence>
              {showSuitDeclaration && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="absolute inset-0 bg-slate-950/90 z-50 flex items-center justify-center p-4 rounded-[80px]"
                >
                  <div className="max-w-sm text-center bg-slate-900/90 p-6 border border-slate-800 rounded-3xl shadow-2xl relative">
                    <div className="absolute -top-10 left-1/2 -translate-x-1/2 w-16 h-16 bg-pink-500/10 rounded-full flex items-center justify-center border border-pink-500/30">
                      <Sparkles className="w-8 h-8 text-pink-400 animate-pulse" />
                    </div>

                    <h4 className="text-md font-bold text-white font-mono mt-6">
                      🌟 WHOT WILD DECLARATION
                    </h4>
                    <p className="text-[10px] text-slate-500 font-mono mt-1 mb-4 leading-normal">
                      You played a Whot wildcard card! Choose the next demanded suit that opponent players must follow.
                    </p>

                    <div className="grid grid-cols-2 gap-2">
                      {(['circle', 'triangle', 'cross', 'square', 'star'] as CardSuit[]).map((suit) => {
                        const data = getSuitSymbol(suit)!;
                        return (
                          <button
                            key={suit}
                            onClick={() => handleDeclareSuit(suit)}
                            className={`p-3 border rounded-xl flex flex-col items-center gap-1 cursor-pointer transition-all hover:scale-105 hover:bg-slate-900 ${data.color}`}
                          >
                            <span className="text-xl">{data.icon}</span>
                            <span className="text-[10px] font-bold uppercase">{data.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

          </div>
        ) : (
          /* 3. FINISHED STATE PANEL */
          <div className="py-16 text-center max-w-md mx-auto relative z-10" id="game_over_panel">
            <div className="h-16 w-16 bg-neon-green/10 border border-neon-green/30 rounded-full flex items-center justify-center mb-6 mx-auto animate-pulse">
              <Award className="w-8 h-8 text-neon-green" />
            </div>

            <h3 className="text-xl font-bold text-white tracking-tight">
              Tournament Won!
            </h3>
            <p className="text-xs text-slate-400 mt-2 font-mono">
              The winner cleared all hand cards and claimed the <strong className="text-neon-green">{formatNaira(gameState.sponsorPrize)}</strong> cash prize
              {gameState.sponsorName ? <> sponsored by <strong className="text-neon-purple">{gameState.sponsorName}</strong></> : null}!
            </p>

            <div className="my-6 p-4 bg-slate-950/60 rounded-xl border border-slate-900 text-left space-y-2.5 font-mono text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Tournament Winner:</span>
                <span className="text-neon-green font-bold">
                  {gameState.players.find(p => p.id === gameState.winnerPlayerId)?.name || 'Unknown'}
                </span>
              </div>

              <div className="flex items-center justify-between border-t border-slate-900/60 pt-2.5">
                <span className="text-slate-500">Prize Payout:</span>
                <span className="text-white font-bold">{formatNaira(gameState.sponsorPrize)} → Wallet</span>
              </div>
            </div>

            {canEnter ? (
              <button
                onClick={handleEnterTournament}
                className="px-6 py-2.5 rounded-lg bg-neon-green hover:bg-neon-green/90 text-dark-bg font-mono font-bold text-xs transition-all cursor-pointer shadow-[0_0_12px_rgba(16,185,129,0.3)]"
              >
                {hasFreeGame ? '🎁 Play Free Game' : '🎟️ Enter Next Tournament (1 Ticket)'}
              </button>
            ) : (
              <button
                onClick={onGoToCashier}
                className="px-6 py-2.5 rounded-lg bg-neon-purple hover:bg-neon-purple/90 text-white font-mono font-bold text-xs transition-all cursor-pointer"
              >
                {buyPackLabel}
              </button>
            )}
          </div>
        )}

        {/* BOTTOM UTILITY ROW - SIMULATION TRIGGERS & HELP */}
        <div className="mt-8 pt-4 border-t border-slate-900 flex flex-col sm:flex-row items-center justify-between gap-4 relative z-10">
          
          {/* AUTOPLAY SIMULATION SWITCH */}
          <div className="flex items-center justify-between bg-slate-950/40 px-3 py-1.5 rounded-xl border border-slate-900 font-mono text-[11px] min-w-[260px]">
            <div className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full ${autoplay ? 'bg-indigo-400 animate-pulse' : 'bg-slate-600'}`} />
              <span className="text-slate-400">Auto-Play Card Simulation</span>
            </div>
            <button
              onClick={() => setAutoplay(!autoplay)}
              className={`px-2.5 py-1 rounded-lg font-bold text-[10px] transition-all cursor-pointer ${
                autoplay 
                  ? 'bg-indigo-600 text-white shadow-[0_0_8px_rgba(99,102,241,0.4)]' 
                  : 'bg-slate-900 text-slate-500 hover:text-slate-300'
              }`}
            >
              {autoplay ? "ENABLED" : "DISABLED"}
            </button>
          </div>

          <button
            onClick={() => {
              const ruleMsg = `Whot! Card Rules:\n1. Play a card with matching Suit or Value on the pile top.\n2. Card 20 (Whot) is wild; declares the next suit.\n3. Special action cards:\n   - 1 (Hold On): Earns an extra turn.\n   - 2 (Pick Two): Next player draws 2 cards, skips turn.\n   - 5 (Send Three): Next player draws 3 cards, skips turn.\n   - 8 (Suspension): Next player skips turn.\n   - 14 (General Market): All other players draw 1 card.\n4. First player to play all hand cards wins!`;
              alert(ruleMsg);
            }}
            className="text-[10px] font-mono text-slate-500 hover:text-slate-300 transition-colors flex items-center gap-1 cursor-pointer"
          >
            <HelpCircle className="w-3.5 h-3.5" />
            Whot Card Rulebook & Actions Guide
          </button>
        </div>

      </div>
    </div>
  );
}
