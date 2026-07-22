import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Bell, Volume2, ShieldAlert, Zap, X } from 'lucide-react';

interface InAppNotificationsProps {
  isMyTurn: boolean;
  playerName: string;
  gameStatus: 'waiting' | 'betting' | 'playing' | 'finished';
  onNotificationDismissed?: () => void;
}

export default function InAppNotifications({ 
  isMyTurn, 
  playerName, 
  gameStatus,
  onNotificationDismissed 
}: InAppNotificationsProps) {
  const [inAppAlert, setInAppAlert] = useState<{ id: string; title: string; body: string; type: 'turn' | 'capture' | 'win' | 'info' } | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [pushStatus, setPushStatus] = useState<'default' | 'granted' | 'denied'>('default');
  const [showPushPrompt, setShowPushPrompt] = useState(true);

  // Sync native HTML5 push notification permission on mount
  useEffect(() => {
    if ('Notification' in window) {
      setPushStatus(Notification.permission);
    }
  }, []);

  const handleRequestPush = async () => {
    if ('Notification' in window) {
      try {
        const permission = await Notification.requestPermission();
        setPushStatus(permission);
        if (permission === 'denied') {
          // If denied, don't show prompt again
          setShowPushPrompt(false);
        }
      } catch (err) {
        console.warn('Notification permission request blocked or failed:', err);
        // Fallback: hide the prompt since it fails in sandboxed iframe environments
        setShowPushPrompt(false);
      }
    } else {
      setShowPushPrompt(false);
    }
  };

  // Synthesize an retro arcade audio frequency beep using HTML5 AudioContext
  const playBeep = (type: 'turn' | 'capture' | 'win') => {
    if (!audioEnabled) return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      if (type === 'turn') {
        // High double ding
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
        osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.12); // E5
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
      } else if (type === 'capture') {
        // Exploding sweep down
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(330, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.4);
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.45);
        osc.start();
        osc.stop(ctx.currentTime + 0.5);
      } else if (type === 'win') {
        // Triumph fanfare
        osc.type = 'sine';
        osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
        osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.1); // E5
        osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.2); // G5
        osc.frequency.setValueAtTime(1046.50, ctx.currentTime + 0.3); // C6
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);
        osc.start();
        osc.stop(ctx.currentTime + 0.75);
      }
    } catch (e) {
      console.warn('Audio synthesis bypassed or muted by browser gesture lock', e);
    }
  };

  // Monitor turn changes to fire notifications
  useEffect(() => {
    if (gameStatus === 'playing' && isMyTurn) {
      // 1. Fire native browser push notification
      if ('Notification' in window && Notification.permission === 'granted') {
        try {
          new Notification("🔥 Your turn in Neon Whot!", {
            body: `Hi ${playerName}, play a card to win the sponsor's cash prize!`,
            icon: '/favicon.ico',
            tag: 'whot-turn-alert',
          });
        } catch (err) {
          console.warn('Silent fallback on push notification', err);
        }
      }

      // 2. Play synthesized double beep
      playBeep('turn');

      // 3. Set custom sliding in-app alert
      setInAppAlert({
        id: 'turn_' + Date.now(),
        title: "🔥 It is Your Turn!",
        body: "Play a matching card to clear your hand and win the prize.",
        type: 'turn'
      });

      // Clear alert after 2.5 seconds
      const t = setTimeout(() => setInAppAlert(null), 2500);
      return () => clearTimeout(t);
    }
  }, [isMyTurn, gameStatus]);

  return (
    <>
    {/* TURN TOAST — top banner on mobile (clear of your hand), bottom-left on desktop */}
    <AnimatePresence>
      {inAppAlert && (
        <motion.div
          initial={{ opacity: 0, y: -24, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -24, scale: 0.95 }}
          className="fixed z-[60] p-3 sm:p-4 rounded-xl shadow-2xl border flex gap-3 overflow-hidden bg-dark-card border-neon-purple
                     top-3 left-1/2 -translate-x-1/2 w-[92%] max-w-sm
                     sm:top-auto sm:bottom-4 sm:left-4 sm:translate-x-0 sm:w-auto sm:max-w-[340px]"
          style={{ boxShadow: '0 0 15px rgba(157, 78, 221, 0.25)' }}
        >
          {/* Animated background laser pulse */}
          <div className="absolute top-0 left-0 w-1 h-full bg-neon-purple animate-pulse" />

          <div className="p-2 bg-neon-purple/15 border border-neon-purple/20 rounded-lg h-fit text-neon-purple">
            <Zap className="w-4 h-4 animate-bounce" />
          </div>

          <div className="pr-5">
            <h4 className="text-xs font-bold font-display text-white">{inAppAlert.title}</h4>
            <p className="text-[10px] text-slate-400 font-mono mt-1 leading-relaxed">{inAppAlert.body}</p>
          </div>

          <button
            onClick={() => setInAppAlert(null)}
            className="text-slate-500 hover:text-white p-1 absolute top-2 right-2 rounded hover:bg-slate-900"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>

    <div className="fixed bottom-4 left-4 z-50 flex flex-col gap-3 max-w-[340px]" id="notifications_hub_portal">
      {/* NATIVE PUSH PERMISSIONS CHIP */}
      {pushStatus !== 'granted' && showPushPrompt && (
        <div className="p-3 bg-dark-card border border-slate-800 rounded-xl shadow-2xl flex items-center justify-between gap-3 font-mono text-[10px] relative">
          <div className="flex items-center gap-2">
            <Bell className="w-4 h-4 text-neon-purple" />
            <span className="text-slate-400">Enable Turn Notifications</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleRequestPush}
              className="px-2.5 py-1 bg-neon-purple text-white font-bold rounded hover:bg-neon-purple/90 transition-all cursor-pointer text-[9px]"
            >
              Enable
            </button>
            <button
              onClick={() => setShowPushPrompt(false)}
              className="p-1 hover:bg-slate-900 rounded text-slate-500 hover:text-white transition-colors cursor-pointer"
              title="Dismiss notification prompt"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* AUDIO VOLUME TRIGGER ICON (CHROME REQUIREMENT) */}
      <button
        onClick={() => {
          setAudioEnabled(!audioEnabled);
          // Play a small beep test
          if (!audioEnabled) {
            setTimeout(() => playBeep('turn'), 100);
          }
        }}
        className={`p-2.5 rounded-full border shadow-lg flex items-center justify-center w-fit transition-all cursor-pointer ${
          audioEnabled 
            ? 'bg-neon-purple/10 border-neon-purple text-neon-purple shadow-[0_0_8px_rgba(157,78,221,0.2)]' 
            : 'bg-slate-900 border-slate-800 text-slate-500'
        }`}
        title={audioEnabled ? "Synth chime sound active" : "Synth chime sound muted"}
      >
        <Volume2 className="w-4 h-4" />
      </button>
    </div>
    </>
  );
}
export { InAppNotifications };
