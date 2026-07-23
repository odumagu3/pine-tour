import React, { useState } from 'react';
import { motion } from 'motion/react';
import { supabase } from '../supabaseClient.js';
import { Mail, Lock, Loader2, AlertCircle, LogIn, UserPlus } from 'lucide-react';

// Sign-in / sign-up gate. On success, App's onAuthStateChange picks up the
// session — this component doesn't need to do anything else.
export default function AuthGate() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !password) return;
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email: cleanEmail, password });
        if (error) { setError(error.message); return; }
        // Email confirmation is disabled, so a session is issued immediately.
        // If for any reason it isn't, fall back to an explicit sign-in.
        const { data } = await supabase.auth.getSession();
        if (!data.session) {
          const res = await supabase.auth.signInWithPassword({ email: cleanEmail, password });
          if (res.error) setNotice('Account created. Please sign in.');
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: cleanEmail, password });
        if (error) { setError(error.message); return; }
      }
    } catch {
      setError('Could not reach the authentication service.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gradient-to-tr from-neon-purple/5 via-dark-bg to-neon-cyan/5 pointer-events-none" />
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-md bg-dark-card border border-slate-800/80 rounded-2xl p-6 shadow-2xl relative overflow-hidden"
      >
        <div className="absolute -top-10 -right-10 w-24 h-24 bg-neon-purple/10 rounded-full blur-2xl animate-pulse-slow" />

        <div className="text-center mb-6">
          <span className="text-[10px] font-mono tracking-widest text-neon-purple neon-glow-purple uppercase bg-neon-purple/5 border border-neon-purple/20 px-2.5 py-0.5 rounded">
            Secure Account Access
          </span>
          <h1 className="text-3xl font-black font-display text-white mt-3 tracking-tight">
            NEON WHOT! <span className="text-neon-green neon-glow-green">BET</span>
          </h1>
          <p className="text-xs text-slate-500 font-mono mt-1">
            {mode === 'signin' ? 'Sign in to your wallet & arena' : 'Create your account to start playing'}
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-xs font-mono text-slate-400 mb-1.5">Email</label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className="w-full bg-slate-900 border border-slate-800 rounded-lg py-2.5 pl-9 pr-4 font-mono text-sm text-white focus:outline-none focus:border-neon-purple/60"
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-mono text-slate-400 mb-1.5">Password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg py-2.5 pl-9 pr-4 font-mono text-sm text-white focus:outline-none focus:border-neon-purple/60"
                required
              />
            </div>
          </div>

          {error && (
            <div className="p-3 bg-red-950/40 border border-red-500/30 rounded-lg text-xs text-red-400 font-mono flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
            </div>
          )}
          {notice && (
            <div className="p-3 bg-neon-green/10 border border-neon-green/30 rounded-lg text-xs text-neon-green font-mono">
              {notice}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full py-2.5 rounded-lg bg-neon-purple hover:bg-neon-purple/90 text-white font-mono font-bold text-xs transition-all tracking-wider shadow-[0_0_15px_rgba(157,78,221,0.3)] disabled:opacity-60 flex items-center justify-center gap-2 cursor-pointer"
          >
            {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Please wait...</>
              : mode === 'signin' ? <><LogIn className="w-4 h-4" /> Sign In</>
              : <><UserPlus className="w-4 h-4" /> Create Account</>}
          </button>
        </form>

        <div className="mt-5 pt-4 border-t border-slate-900 text-center">
          <button
            type="button"
            onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); setNotice(''); }}
            className="text-[11px] font-mono text-slate-400 hover:text-white transition-colors cursor-pointer"
          >
            {mode === 'signin'
              ? "New here? Create an account"
              : 'Already have an account? Sign in'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
