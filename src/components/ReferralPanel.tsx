import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Gift, Copy, Check, Share2, Users, Ticket, Loader2, AlertCircle, Link2 } from 'lucide-react';
import { ReferralSummary } from '../types.js';
import { apiUrl } from '../config.js';
import { buildReferralLink } from '../referral.js';
import { REFERRAL_REWARD_CAP, REFERRAL_REWARD_TICKETS } from '../currency.js';

interface ReferralPanelProps {
  email: string;
}

// "Refer & Earn" — the player's shareable link and their progress toward the
// reward cap. The reward is NOT paid when someone signs up; it lands when that
// person buys tickets, so the copy here is careful to say so.
export default function ReferralPanel({ email }: ReferralPanelProps) {
  const [summary, setSummary] = useState<ReferralSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!email) return;
    try {
      const res = await fetch(apiUrl(`/api/referral?email=${encodeURIComponent(email)}`));
      if (!res.ok) throw new Error('request failed');
      setSummary(await res.json());
      setError('');
    } catch {
      setError('Could not load your referral link. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [email]);

  useEffect(() => { load(); }, [load]);

  // A referral pays out on someone else's action, so refresh when the player
  // comes back to the tab — that's when a new reward is most likely waiting.
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const code = summary?.code ?? '';
  const link = buildReferralLink(code, summary?.link);
  const cap = summary?.cap ?? REFERRAL_REWARD_CAP;
  const perReferral = summary?.rewardTickets ?? REFERRAL_REWARD_TICKETS;
  const invited = summary?.invited ?? 0;
  const rewarded = summary?.rewarded ?? 0;
  const remaining = summary?.remaining ?? cap;
  const pending = Math.max(0, invited - rewarded);
  const progress = cap > 0 ? Math.min(100, Math.round((rewarded / cap) * 100)) : 0;

  // navigator.clipboard needs a secure context and isn't there in every in-app
  // browser, so fall back to the old textarea trick rather than silently failing.
  const copy = async () => {
    if (!link) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(link);
      ok = true;
    } catch {
      try {
        const el = document.createElement('textarea');
        el.value = link;
        el.setAttribute('readonly', '');
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.select();
        ok = document.execCommand('copy');
        document.body.removeChild(el);
      } catch { ok = false; }
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } else {
      setError('Copy failed — select the link above and copy it manually.');
    }
  };

  const share = async () => {
    if (!link) return;
    const text = 'Come play Whot! on Pine Tour. Sign up with my link:';
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ title: 'Pine Tour', text, url: link });
        return;
      } catch { /* user dismissed the sheet — fall through to copying */ }
    }
    copy();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 gap-2 text-slate-400 font-mono text-xs">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading your referral link…
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      {/* How it works */}
      <div className="bg-gradient-to-br from-neon-green/10 to-slate-950 border border-neon-green/30 rounded-2xl p-5 relative overflow-hidden">
        <div className="absolute -top-8 -right-8 w-24 h-24 bg-neon-green/10 rounded-full blur-2xl" />
        <div className="relative">
          <h3 className="text-md font-bold font-display text-white flex items-center gap-2">
            <Gift className="w-5 h-5 text-neon-green" /> Refer &amp; Earn
          </h3>
          <p className="text-[11px] text-slate-400 font-mono mt-2 leading-relaxed">
            Share your link. When someone signs up through it <strong className="text-white">and buys
            tickets</strong>, you get{' '}
            <strong className="text-neon-green">
              {perReferral} free ticket{perReferral === 1 ? '' : 's'}
            </strong>{' '}
            — up to <strong className="text-white">{cap}</strong> in total.
          </p>
        </div>
      </div>

      {/* The link itself */}
      <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800/80 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono text-slate-500 uppercase flex items-center gap-1.5">
            <Link2 className="w-3 h-3" /> Your referral link
          </span>
          {code && (
            <span className="text-[10px] font-mono text-slate-500">
              Code <strong className="text-neon-cyan tracking-widest">{code}</strong>
            </span>
          )}
        </div>

        <input
          type="text"
          value={link}
          readOnly
          onFocus={(e) => e.currentTarget.select()}
          className="w-full bg-slate-950 border border-slate-800 rounded-lg py-2.5 px-3 font-mono text-xs text-neon-cyan focus:outline-none focus:border-neon-cyan/60 select-all"
        />

        <div className="flex gap-2">
          <button
            onClick={copy}
            disabled={!link}
            className="flex-1 py-2.5 rounded-lg bg-neon-green/10 border border-neon-green/40 text-neon-green font-mono font-bold text-xs transition-all hover:bg-neon-green/20 disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
          >
            {copied ? <><Check className="w-4 h-4" /> Copied!</> : <><Copy className="w-4 h-4" /> Copy Link</>}
          </button>
          <button
            onClick={share}
            disabled={!link}
            className="flex-1 py-2.5 rounded-lg bg-neon-purple/10 border border-neon-purple/40 text-neon-purple font-mono font-bold text-xs transition-all hover:bg-neon-purple/20 disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
          >
            <Share2 className="w-4 h-4" /> Share
          </button>
        </div>
      </div>

      {/* Progress toward the cap */}
      <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800/80 space-y-3">
        <div className="flex items-end justify-between">
          <div>
            <span className="text-[10px] font-mono text-slate-500 block uppercase">Free tickets earned</span>
            <span className="text-3xl font-bold font-display text-neon-green flex items-center gap-2">
              <Ticket className="w-6 h-6" /> {rewarded}
              <span className="text-sm text-slate-500 font-mono">/ {cap}</span>
            </span>
          </div>
          <span className="text-[10px] font-mono text-slate-400">
            {remaining > 0 ? `${remaining} still to earn` : 'Cap reached'}
          </span>
        </div>

        <div className="h-2 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
          <motion.div
            className="h-full bg-neon-green shadow-[0_0_10px_rgba(0,255,102,0.5)]"
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.6 }}
          />
        </div>

        <div className="grid grid-cols-2 gap-2 pt-1">
          <div className="bg-slate-950/60 rounded-lg p-3 border border-slate-800/60">
            <span className="text-[10px] font-mono text-slate-500 uppercase flex items-center gap-1">
              <Users className="w-3 h-3" /> Signed up
            </span>
            <span className="text-xl font-bold font-display text-white">{invited}</span>
          </div>
          <div className="bg-slate-950/60 rounded-lg p-3 border border-slate-800/60">
            <span className="text-[10px] font-mono text-slate-500 uppercase block">Yet to buy</span>
            <span className="text-xl font-bold font-display text-slate-300">{pending}</span>
          </div>
        </div>

        {pending > 0 && (
          <p className="text-[10px] text-slate-500 font-mono leading-relaxed">
            {pending} {pending === 1 ? 'person has' : 'people have'} signed up through your link but
            {pending === 1 ? " hasn't" : " haven't"} bought tickets yet — you'll be credited the moment
            they do.
          </p>
        )}
      </div>

      {error && (
        <div className="p-3 bg-red-950/40 border border-red-500/30 rounded-lg text-xs text-red-400 font-mono flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}
    </motion.div>
  );
}
