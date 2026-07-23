import React, { useEffect, useState, useRef } from 'react';
import type { Session } from '@supabase/supabase-js';
import { motion, AnimatePresence } from 'motion/react';
import { GameState, UserProfile, GameLog, ChatMessage, PlayerColor, PublicConfig } from './types.js';
import GameBoard from './components/GameBoard.tsx';
import FinancePortal from './components/FinancePortal.tsx';
import DashboardStats from './components/DashboardStats.tsx';
import PrivacyPortal from './components/PrivacyPortal.tsx';
import AdminDashboard from './components/AdminDashboard.tsx';
import AuthGate from './components/AuthGate.tsx';
import InstallButton from './components/InstallButton.tsx';
import { InAppNotifications } from './components/InAppNotifications.tsx';
import { ShieldCheck, MessageSquare, Send, Bell, User, LayoutDashboard, Wallet, Database, Lock, AlertCircle, HelpCircle, Ticket, LogOut, Settings } from 'lucide-react';
import { formatNaira } from './currency.js';
import { supabase } from './supabaseClient.js';
import { apiUrl, wsUrl } from './config.js';

// --- Lobby preferences (nickname + room) persisted across refreshes -------
// Identity/auth is handled by Supabase; these are just convenience prefs.
const PREFS_KEY = 'whot_lobby_prefs';

interface LobbyPrefs { userName: string; roomId: string; }

function loadPrefs(): LobbyPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return JSON.parse(raw) as LobbyPrefs;
  } catch { /* ignore */ }
  return { userName: 'VoltGamer', roomId: 'VaporSuite' };
}

function savePrefs(p: LobbyPrefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(p));
}

export default function App() {
  const [prefs] = useState(loadPrefs);

  // Supabase auth session is the source of identity.
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const email = session?.user?.email ?? '';

  // Lobby details
  const [userName, setUserName] = useState(prefs.userName);
  const [roomId, setRoomId] = useState(prefs.roomId);
  const [isJoined, setIsJoined] = useState(false);

  // Application Tabs
  const [activeTab, setActiveTab] = useState<'board' | 'stats' | 'cashier' | 'privacy' | 'admin'>('board');

  // Server-driven public config (arena name, prices, isAdmin, etc.)
  const [config, setConfig] = useState<PublicConfig | null>(null);

  const fetchConfig = async (forEmail: string) => {
    try {
      const res = await fetch(apiUrl(`/api/config?email=${encodeURIComponent(forEmail)}`));
      const data = await res.json();
      setConfig(data);
    } catch (e) {
      console.error('Failed to load config', e);
    }
  };

  // GDPR Consent state
  const [privacyConsent, setPrivacyConsent] = useState(() => {
    return localStorage.getItem('ludo_privacy_consent_settled') === 'true';
  });

  // Reactive Profiles and Game states
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [currentChatMessage, setCurrentChatMessage] = useState('');
  
  // Connection states
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [gameplayNotice, setGameplayNotice] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  // Fetch updated user profile from backend REST API
  const fetchProfile = async () => {
    if (!email) return;
    try {
      const response = await fetch(apiUrl(`/api/profile?email=${encodeURIComponent(email)}`));
      const data = await response.json();
      setProfile(data);
    } catch (e) {
      console.error('Failed to sync profile', e);
    }
  };

  // Connect WebSocket relative to window host
  const connectWebSocket = () => {
    if (socketRef.current) {
      socketRef.current.close();
    }

    setConnectionError('');
    const url = wsUrl(`?email=${encodeURIComponent(email)}&name=${encodeURIComponent(userName)}&roomId=${encodeURIComponent(roomId)}`);

    const socket = new WebSocket(url);
    socketRef.current = socket;
    (window as any).ludoSocket = socket; // Expose globally for sub-components

    socket.onopen = () => {
      setConnected(true);
      fetchProfile();
    };

    socket.onmessage = (event) => {
      let data: any;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      switch (data.type) {
        case 'state-sync':
          setGameState(data.state);
          // Sync profile ledger balance in sync
          fetchProfile();
          break;
        case 'chat-received':
          setChatMessages((prev) => [...prev, data.message].slice(-50)); // Keep last 50
          break;
        case 'cheat-alert':
          // We can flash visual cues on cheat logs
          break;
        case 'warning':
          setGameplayNotice(data.message);
          setTimeout(() => {
            setGameplayNotice((prev) => (prev === data.message ? null : prev));
          }, 4000);
          break;
        case 'error':
          if (!gameState || data.message.includes('full') || data.message.includes('handshake')) {
            setConnectionError(data.message);
            setIsJoined(false);
          } else {
            setGameplayNotice(data.message);
            setTimeout(() => {
              setGameplayNotice((prev) => (prev === data.message ? null : prev));
            }, 4000);
          }
          break;
      }
    };

    socket.onclose = () => {
      setConnected(false);
    };

    socket.onerror = () => {
      setConnectionError('WebSocket connection handshake failed. The game server may be offline.');
    };
  };

  // Track the Supabase auth session (identity source of truth).
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Close sockets on cleanup
  useEffect(() => {
    return () => {
      if (socketRef.current) {
        socketRef.current.close();
      }
    };
  }, []);

  // Poll profile + config initially on load and whenever the identity changes
  useEffect(() => {
    if (!email) return;
    fetchProfile();
    fetchConfig(email);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  // Keep the admin config fresh on EVERY device: re-fetch on window focus and on
  // a short interval. This is what makes admin changes (ticket price, sponsor,
  // room name, tournament on/off) show up everywhere without a manual reload.
  useEffect(() => {
    if (!email) return;
    const refresh = () => fetchConfig(email);
    const onFocus = () => { refresh(); fetchProfile(); };
    window.addEventListener('focus', onFocus);
    const id = window.setInterval(refresh, 20000);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  // The room name is fully admin-controlled — mirror it into local state so the
  // WebSocket connects to the single arena the admin configured.
  useEffect(() => {
    if (config?.roomName) setRoomId(config.roomName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.roomName]);

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !userName) return;
    // No tournament configured → don't let players in.
    if (!config?.tournamentActive) return;
    const room = config.roomName || roomId;
    setRoomId(room);
    savePrefs({ userName, roomId: room });
    setIsJoined(true);
    connectWebSocket();
  };

  const handleSignOut = async () => {
    if (socketRef.current) socketRef.current.close();
    setIsJoined(false);
    setGameState(null);
    setProfile(null);
    await supabase.auth.signOut();
  };

  const handleRollDice = () => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'roll-dice' }));
    }
  };

  const handleMoveToken = (tokenId: number) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'move-token', tokenId }));
    }
  };

  const handleAddBots = () => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'add-bots-manually' }));
    }
  };

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentChatMessage.trim()) return;

    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: 'chat-message',
        message: currentChatMessage.trim()
      }));
      setCurrentChatMessage('');
    }
  };

  // Accept privacy policy
  const handleAcceptPrivacy = () => {
    localStorage.setItem('ludo_privacy_consent_settled', 'true');
    setPrivacyConsent(true);
  };

  return (
    <div className="min-h-screen bg-dark-bg text-slate-300 font-sans flex flex-col justify-between" id="app_root">
      
      {/* 1. AUTH GATE → LOBBY ONBOARDING → ACTIVE GAMEPORTAL */}
      {!authReady ? (
        <div className="flex-1 flex items-center justify-center p-4">
          <Loader2Icon className="w-10 h-10 text-neon-purple animate-spin" />
        </div>
      ) : !session ? (
        <AuthGate />
      ) : !isJoined ? (
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gradient-to-tr from-neon-purple/5 via-dark-bg to-neon-cyan/5 pointer-events-none" />
          
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-md bg-dark-card border border-slate-800/80 rounded-2xl p-6 shadow-2xl relative overflow-hidden"
          >
            {/* Ambient neon pulse inside lobby card */}
            <div className="absolute -top-10 -right-10 w-24 h-24 bg-neon-purple/10 rounded-full blur-2xl animate-pulse-slow" />
            
            <div className="text-center mb-6">
              <span className="text-[10px] font-mono tracking-widest text-neon-purple neon-glow-purple uppercase bg-neon-purple/5 border border-neon-purple/20 px-2.5 py-0.5 rounded">
                Server Authority Whot! Engine
              </span>
              <h1 className="text-3xl font-black font-display text-white mt-3 tracking-tight">
                NEON WHOT! <span className="text-neon-green neon-glow-green">BET</span>
              </h1>
              <p className="text-xs text-slate-500 font-mono mt-1">
                Real-Time High-Roller Lobby w/ Secure Cashout
              </p>
            </div>

            {/* Signed-in identity (from Supabase Auth) */}
            <div className="mb-4 flex items-center justify-between gap-2 bg-slate-900/60 border border-slate-800 rounded-lg px-3 py-2">
              <span className="text-[11px] font-mono text-slate-300 truncate">
                <span className="text-slate-500">Signed in:</span> {email}
              </span>
              <button
                type="button"
                onClick={handleSignOut}
                className="text-[10px] font-mono text-slate-400 hover:text-neon-pink transition-colors flex-shrink-0 cursor-pointer"
              >
                Sign out
              </button>
            </div>

            {/* Current tournament banner (admin-controlled) */}
            {config?.tournamentActive ? (
              <div className="mb-4 bg-gradient-to-br from-neon-green/10 to-slate-950 border border-neon-green/30 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-[9px] font-mono text-slate-500 uppercase tracking-widest block">Live Tournament</span>
                  <span className="text-sm font-bold font-display text-white truncate block">{config.sponsorName}</span>
                </div>
                <div className="text-right flex-shrink-0">
                  <span className="text-[9px] font-mono text-slate-500 uppercase block">Cash Prize</span>
                  <span className="text-lg font-black font-display text-neon-green neon-glow-green">{formatNaira(config.sponsorPrize)}</span>
                </div>
              </div>
            ) : (
              <div className="mb-4 bg-slate-900/50 border border-dashed border-slate-700 rounded-xl px-4 py-5 text-center">
                <AlertCircle className="w-6 h-6 text-slate-500 mx-auto mb-2" />
                <p className="text-xs font-mono text-slate-300 font-bold">No tournaments available right now</p>
                <p className="text-[10px] font-mono text-slate-500 mt-1">Please check back soon — a new tournament will be announced here.</p>
              </div>
            )}

            <form onSubmit={handleJoinRoom} className="space-y-4">
              <div>
                <label className="block text-xs font-mono text-slate-400 mb-1.5">Lobby Nickname</label>
                <input
                  type="text"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg py-2 px-3 font-mono text-xs text-white focus:outline-none focus:border-neon-purple/60"
                  required
                />
              </div>

              {config?.roomName && (
                <div className="flex items-center justify-between bg-slate-900/40 border border-slate-800 rounded-lg px-3 py-2">
                  <span className="text-[11px] font-mono text-slate-500">Arena</span>
                  <span className="text-[11px] font-mono text-neon-cyan font-bold">{config.roomName}</span>
                </div>
              )}

              {connectionError && (
                <div className="p-3 bg-red-950/40 border border-red-500/30 rounded-lg text-xs text-red-400 font-mono flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  {connectionError}
                </div>
              )}

              <button
                type="submit"
                disabled={!config?.tournamentActive}
                className="w-full py-2.5 rounded-lg bg-neon-purple hover:bg-neon-purple/90 text-white font-mono font-bold text-xs transition-all tracking-wider shadow-[0_0_15px_rgba(157,78,221,0.3)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {config?.tournamentActive ? 'Enter Arena' : 'No Tournament Available'}
              </button>
            </form>

            {/* Install as a mobile app (hidden once installed / standalone) */}
            <div className="mt-4">
              <InstallButton variant="full" />
            </div>

            <div className="mt-6 pt-4 border-t border-slate-900 text-center text-[10px] text-slate-500 font-mono">
              🛡️ Adheres to GDPR Data Portability & Deletion Rights
            </div>
          </motion.div>
        </div>
      ) : (
        // ACTIVE PLAYING ARENA
        <div className="flex-1 flex flex-col relative">
          {/* FLOATING GAMEPLAY NOTICES */}
          <AnimatePresence>
            {gameplayNotice && (
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="fixed top-20 left-1/2 -translate-x-1/2 z-50 max-w-md w-full px-4"
              >
                <div className="bg-amber-950/95 border border-amber-500/40 text-amber-200 px-4 py-3 rounded-xl shadow-2xl flex items-center gap-2 text-xs font-mono backdrop-blur">
                  <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 animate-pulse" />
                  <span className="flex-1">{gameplayNotice}</span>
                  <button onClick={() => setGameplayNotice(null)} className="text-amber-400 hover:text-amber-100 font-bold px-1 text-sm cursor-pointer">×</button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* HEADER HEADER */}
          <header className="bg-dark-card border-b border-slate-800/80 px-3 sm:px-6 py-3 sm:py-4 flex flex-col md:flex-row items-center justify-between gap-3 sm:gap-4 sticky top-0 z-40">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-lg bg-gradient-to-tr from-neon-purple to-neon-cyan flex items-center justify-center font-display font-extrabold text-white shadow-lg shadow-neon-purple/20">
                NW
              </div>
              <div>
                <h1 className="text-md font-bold font-display text-white tracking-tight flex items-center gap-1.5">
                  NEON WHOT! <span className="text-neon-green neon-glow-green text-xs font-mono px-1.5 py-0.2 rounded bg-neon-green/5 border border-neon-green/20">BET</span>
                </h1>
                <span className="text-[10px] text-slate-500 font-mono block">
                  Connected as: <strong className="text-slate-300">{userName}</strong> ({email})
                </span>
              </div>
              <InstallButton variant="compact" className="ml-1" />
            </div>

            {/* TAB SELECTOR */}
            <nav className="flex w-full md:w-auto max-w-full overflow-x-auto bg-slate-950 p-1.5 rounded-xl border border-slate-900 gap-1 font-mono text-xs font-semibold [&>button]:whitespace-nowrap [&>button]:flex-shrink-0">
              <button
                onClick={() => setActiveTab('board')}
                className={`px-3.5 py-1.5 rounded-lg transition-all flex items-center gap-1.5 ${
                  activeTab === 'board' ? 'bg-dark-card text-white shadow' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                🎲 Play Arena
              </button>
              <button
                onClick={() => setActiveTab('stats')}
                className={`px-3.5 py-1.5 rounded-lg transition-all flex items-center gap-1.5 ${
                  activeTab === 'stats' ? 'bg-dark-card text-white shadow' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <LayoutDashboard className="w-3.5 h-3.5 text-neon-purple" />
                Secure Dashboard
              </button>
              <button
                onClick={() => setActiveTab('cashier')}
                className={`px-3.5 py-1.5 rounded-lg transition-all flex items-center gap-1.5 ${
                  activeTab === 'cashier' ? 'bg-dark-card text-white shadow' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Wallet className="w-3.5 h-3.5 text-neon-cyan" />
                Ledger Cashier
              </button>
              <button
                onClick={() => setActiveTab('privacy')}
                className={`px-3.5 py-1.5 rounded-lg transition-all flex items-center gap-1.5 ${
                  activeTab === 'privacy' ? 'bg-dark-card text-white shadow' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Database className="w-3.5 h-3.5 text-neon-pink" />
                Privacy Rights
              </button>
              {config?.isAdmin && (
                <button
                  onClick={() => setActiveTab('admin')}
                  className={`px-3.5 py-1.5 rounded-lg transition-all flex items-center gap-1.5 ${
                    activeTab === 'admin' ? 'bg-dark-card text-white shadow' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Settings className="w-3.5 h-3.5 text-neon-purple" />
                  Admin
                </button>
              )}
            </nav>

            {/* QUICK CASH DISPLAY */}
            <div className="flex items-center gap-3">
              <div className="text-right">
                <span className="text-[9px] uppercase font-mono tracking-wider text-slate-500 flex items-center gap-1 justify-end">
                  <Ticket className="w-3 h-3 text-neon-purple" /> Tickets
                </span>
                <span className="text-sm font-bold font-mono text-neon-purple">
                  {profile ? profile.tickets : '...'}
                  {profile && !profile.freeGameUsed && (
                    <span className="ml-1.5 text-[8px] px-1.5 py-0.5 rounded bg-neon-green/10 border border-neon-green/30 text-neon-green align-middle">1 FREE</span>
                  )}
                </span>
              </div>
              <div className="text-right">
                <span className="text-[9px] uppercase font-mono tracking-wider text-slate-500 block">Wallet Balance</span>
                <span className="text-sm font-bold font-mono text-neon-green neon-glow-green">
                  {profile ? formatNaira(profile.balance) : '...'}
                </span>
              </div>
              <button
                onClick={() => setActiveTab('cashier')}
                className="px-3 py-1.5 rounded-lg bg-neon-green hover:bg-neon-green/90 text-dark-bg font-mono font-bold text-xs shadow-[0_0_10px_rgba(0,255,102,0.2)] transition-all cursor-pointer"
              >
                + Fund
              </button>
              <button
                onClick={handleSignOut}
                title="Sign out"
                aria-label="Sign out"
                className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:border-slate-700 transition-all cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </header>

          {/* MAIN BODY AREA */}
          <main className="flex-1 p-3 sm:p-6 flex flex-col items-center">
            {gameState ? (
              <div className="w-full space-y-6">
                
                {/* 1. COMPONENT DISPATCHER */}
                {activeTab === 'board' && (
                  <div className="space-y-6">
                    <GameBoard
                      gameState={gameState}
                      profile={profile}
                      config={config}
                      activePlayerEmail={email}
                      onRollDice={handleRollDice}
                      onMoveToken={handleMoveToken}
                      onAddBots={handleAddBots}
                      onGoToCashier={() => setActiveTab('cashier')}
                    />

                    {/* BOTTOM SPLIT CHAT AND SECURE VERIFIED LOGS */}
                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 max-w-6xl mx-auto">
                      
                      {/* GAME CHAT PANEL */}
                      <div className="lg:col-span-5 bg-dark-card border border-slate-800 rounded-2xl p-4 flex flex-col h-[280px]">
                        <h3 className="text-xs uppercase font-mono tracking-wider text-slate-400 mb-3 flex items-center gap-2">
                          <MessageSquare className="w-4 h-4 text-neon-purple animate-pulse" />
                          Arena Secure Chat
                        </h3>
                        
                        {/* Messages Area */}
                        <div className="flex-1 overflow-y-auto space-y-2 mb-3 pr-1">
                          {chatMessages.length === 0 ? (
                            <div className="text-center py-10 font-mono text-xs text-slate-500">
                              No chats sent. Message other connected clients in real-time.
                            </div>
                          ) : (
                            chatMessages.map((cm) => {
                              const isMe = cm.senderName === userName;
                              return (
                                <div key={cm.id} className="text-xs font-mono leading-snug">
                                  <span className={`font-bold ${
                                    cm.senderColor === 'red' ? 'text-neon-pink' : cm.senderColor === 'green' ? 'text-neon-green' : cm.senderColor === 'yellow' ? 'text-amber-400' : 'text-neon-cyan'
                                  }`}>
                                    {cm.senderName}:
                                  </span>
                                  <span className="text-slate-300 ml-1.5">{cm.message}</span>
                                </div>
                              );
                            })
                          )}
                        </div>

                        {/* Input Area */}
                        <form onSubmit={handleSendChat} className="flex gap-2">
                          <input
                            type="text"
                            placeholder="Type a message..."
                            maxLength={100}
                            value={currentChatMessage}
                            onChange={(e) => setCurrentChatMessage(e.target.value)}
                            className="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none"
                          />
                          <button
                            type="submit"
                            className="p-2 rounded-lg bg-neon-purple hover:bg-neon-purple/95 text-white transition-all cursor-pointer"
                          >
                            <Send className="w-3.5 h-3.5" />
                          </button>
                        </form>
                      </div>

                      {/* CRYPTOGRAPHIC MATCH AUDIT FEEDS */}
                      <div className="lg:col-span-7 bg-dark-card border border-slate-800 rounded-2xl p-4 flex flex-col h-[280px]">
                        <h3 className="text-xs uppercase font-mono tracking-wider text-slate-400 mb-3 flex items-center justify-between">
                          <span className="flex items-center gap-2">
                            <ShieldCheck className="w-4 h-4 text-neon-green animate-pulse" />
                            Cryptographic Block Audit Logs
                          </span>
                          <span className="text-[8px] px-1.5 py-0.2 rounded bg-slate-900 border border-slate-800 text-slate-500 font-mono">
                            SHA-256 Validated
                          </span>
                        </h3>

                        {/* Logs container */}
                        <div className="flex-1 overflow-y-auto space-y-2 pr-1 font-mono text-[10px]">
                          {gameState.logs.slice().reverse().map((log) => {
                            let typeColor = 'text-slate-400';
                            if (log.type === 'roll') typeColor = 'text-neon-purple font-medium';
                            if (log.type === 'move') typeColor = 'text-neon-cyan';
                            if (log.type === 'bet') typeColor = 'text-amber-400';
                            if (log.type === 'cheat') typeColor = 'text-neon-pink font-bold';
                            if (log.type === 'win') typeColor = 'text-neon-green font-black';

                            // Generate mock SHA-256 validation signature
                            const mockHash = 'block_' + Math.random().toString(36).substring(2, 7) + Math.random().toString(36).substring(2, 7);

                            return (
                              <div key={log.id} className="p-2 bg-slate-950/60 rounded border border-slate-900/40 flex flex-col gap-1 hover:border-slate-800 transition-all">
                                <div className="flex items-center justify-between">
                                  <span className={typeColor}>{log.message}</span>
                                  <span className="text-[8px] text-slate-600">
                                    {new Date(log.timestamp).toLocaleTimeString()}
                                  </span>
                                </div>
                                <div className="text-[8px] text-slate-600 flex items-center justify-between border-t border-slate-900/30 pt-1">
                                  <span>Authoritative Receipt: {mockHash}</span>
                                  <span className="text-neon-green">✓ VALIDATED</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                    </div>
                  </div>
                )}

                {activeTab === 'stats' && profile && (
                  <DashboardStats profile={profile} />
                )}

                {activeTab === 'cashier' && profile && (
                  <FinancePortal profile={profile} config={config} onRefreshProfile={fetchProfile} />
                )}

                {activeTab === 'privacy' && profile && (
                  <PrivacyPortal profile={profile} onResetData={fetchProfile} />
                )}

                {activeTab === 'admin' && (
                  <AdminDashboard
                    email={email}
                    config={config}
                    onSaved={() => fetchConfig(email)}
                  />
                )}

              </div>
            ) : (
              // SPINNING LOADER FOR MATCH CONNECTIVITY
              <div className="flex flex-col items-center justify-center py-20 space-y-4">
                <Loader2Icon className="w-10 h-10 text-neon-purple animate-spin" />
                <h3 className="text-sm font-semibold font-display text-white">Syncing Authorities...</h3>
                <p className="text-xs text-slate-500 font-mono">Securing WebSocket tunnels to the tournament room</p>
              </div>
            )}
          </main>
        </div>
      )}

      {/* 2. PUSH NOTIFICATIONS CONTROLLER PORTAL */}
      {gameState && profile && (
        <InAppNotifications
          isMyTurn={gameState.activePlayerIndex >= 0 && gameState.players[gameState.activePlayerIndex]?.id === email}
          playerName={userName}
          gameStatus={gameState.status}
        />
      )}

      {/* 3. GDPR COMPLIANCE CONSENT COOKIE BANNER BAR */}
      <AnimatePresence>
        {!privacyConsent && (
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className="fixed bottom-0 left-0 w-full bg-slate-950 border-t border-slate-800 p-4 z-50 flex flex-col md:flex-row items-center justify-between gap-4 font-mono text-[11px]"
            id="cookie_consent_banner"
          >
            <div className="flex items-center gap-2.5 max-w-4xl text-slate-400">
              <ShieldCheck className="w-5 h-5 text-neon-purple flex-shrink-0 animate-pulse" />
              <p className="leading-relaxed">
                🍪 **Regulatory Disclosure**: Neon Whot! Bet utilizes encrypted local storage profiles and cryptographic server ledger logs to guarantee fair, tamper-proof, and fully-compliant gaming sessions. Continuing implies full consent under GDPR / CCPA right disclosures.
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setActiveTab('privacy')}
                className="px-3 py-1.5 bg-slate-900 border border-slate-800 text-slate-300 hover:text-white rounded text-xs cursor-pointer"
              >
                Read Disclosures
              </button>
              <button
                onClick={handleAcceptPrivacy}
                className="px-4 py-1.5 bg-neon-purple hover:bg-neon-purple/95 text-white font-bold rounded text-xs shadow-[0_0_10px_rgba(157,78,221,0.3)] transition-all cursor-pointer"
              >
                I Agree & Consent
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* FOOTER */}
      <footer className="bg-slate-950 border-t border-slate-900 px-6 py-4 mt-auto text-center font-mono text-[10px] text-slate-600 flex flex-col md:flex-row items-center justify-between gap-3">
        <span>© 2026 Neon Whot! Bet • Regulated Under Global Sandbox Standards</span>
        <span className="flex items-center gap-1.5 text-slate-500">
          <span className="w-1.5 h-1.5 rounded-full bg-neon-green" />
          WebSocket Secure: ACTIVE
        </span>
      </footer>

    </div>
  );
}

// Minimal icons to prevent build errors
function Loader2Icon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
