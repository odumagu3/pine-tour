import React, { useState } from 'react';
import { motion } from 'motion/react';
import { X, Loader2, CheckCircle2, CreditCard, Landmark, Hash, ShieldCheck, Lock } from 'lucide-react';
import { formatNaira } from '../currency.js';

// A SIMULATED Paystack checkout popup. Looks and flows like the real Paystack
// inline popup (light theme, Paystack blue, card / bank transfer / USSD), but no
// real API or money — it "pays", then the parent verifies the reference to
// credit the wallet. Fixed colors (not the app tokens) so it looks like the real
// gateway regardless of the app's light/dark theme.
type Method = 'card' | 'transfer' | 'ussd';
type Phase = 'form' | 'processing' | 'success' | 'failed';

interface Props {
  email: string;
  amount: number; // naira
  reference: string;
  onVerify: (reference: string) => Promise<{ ok: boolean; error?: string }>;
  onDone: (credited: boolean) => void;
}

const BLUE = '#0BA4DB';
const NAVY = '#011B33';

// A stable pseudo virtual-account number derived from the reference.
function virtualAccount(ref: string): string {
  let h = 0; for (const c of ref) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (90 + (h % 10)).toString() + (1000000 + (h % 9000000)).toString().padStart(7, '0');
}

export default function PaystackCheckout({ email, amount, reference, onVerify, onDone }: Props) {
  const [method, setMethod] = useState<Method>('card');
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState('');

  // Prefilled Paystack TEST card so it's one tap to try.
  const [card, setCard] = useState('4084 0840 8408 4081');
  const [expiry, setExpiry] = useState('09/30');
  const [cvv, setCvv] = useState('408');

  const vAcct = virtualAccount(reference);
  const ussd = `*000*${Math.round(amount)}#`;

  const pay = async () => {
    setError('');
    setPhase('processing');
    await new Promise(r => setTimeout(r, 1400)); // simulate authorization
    const r = await onVerify(reference);
    if (r.ok) {
      setPhase('success');
      setTimeout(() => onDone(true), 1400);
    } else {
      setError(r.error || 'Payment could not be completed.');
      setPhase('failed');
    }
  };

  const payLabel = `Pay ${formatNaira(amount)}`;

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="w-full max-w-sm rounded-2xl overflow-hidden shadow-2xl"
        style={{ background: '#ffffff', fontFamily: 'Inter, system-ui, sans-serif' }}
      >
        {/* Header */}
        <div className="px-5 pt-4 pb-5 relative" style={{ background: '#f6f9fc', borderBottom: '1px solid #e6ebf1' }}>
          <button onClick={() => onDone(false)} className="absolute top-3 right-3 text-[#9aa5b1] hover:text-[#334155] cursor-pointer" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-1.5 mb-3">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: BLUE }} />
            <span className="font-bold tracking-tight" style={{ color: NAVY }}>paystack</span>
          </div>
          <div className="text-[11px]" style={{ color: '#697386' }}>{email}</div>
          <div className="text-2xl font-extrabold mt-0.5" style={{ color: NAVY }}>{formatNaira(amount)}</div>
        </div>

        {phase === 'success' ? (
          <div className="px-6 py-10 text-center">
            <CheckCircle2 className="w-16 h-16 mx-auto mb-3" style={{ color: '#3BB75E' }} />
            <div className="font-bold text-lg" style={{ color: NAVY }}>Payment complete</div>
            <div className="text-xs mt-1" style={{ color: '#697386' }}>Ref: {reference}</div>
          </div>
        ) : phase === 'processing' ? (
          <div className="px-6 py-12 text-center">
            <Loader2 className="w-12 h-12 mx-auto mb-3 animate-spin" style={{ color: BLUE }} />
            <div className="font-semibold text-sm" style={{ color: NAVY }}>Authorizing payment…</div>
            <div className="text-xs mt-1" style={{ color: '#697386' }}>Do not close this window</div>
          </div>
        ) : (
          <div className="px-5 py-4">
            {/* Method tabs */}
            <div className="grid grid-cols-3 gap-1.5 mb-4 p-1 rounded-lg" style={{ background: '#f0f3f7' }}>
              {([['card', 'Card', CreditCard], ['transfer', 'Transfer', Landmark], ['ussd', 'USSD', Hash]] as const).map(([m, label, Icon]) => (
                <button
                  key={m}
                  onClick={() => setMethod(m)}
                  className="py-1.5 rounded-md text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer transition-colors"
                  style={method === m ? { background: '#fff', color: NAVY, boxShadow: '0 1px 2px rgba(0,0,0,0.08)' } : { color: '#697386' }}
                >
                  <Icon className="w-3.5 h-3.5" /> {label}
                </button>
              ))}
            </div>

            {method === 'card' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-[10px] font-semibold mb-1" style={{ color: '#697386' }}>CARD NUMBER</label>
                  <input value={card} onChange={e => setCard(e.target.value)}
                    className="w-full rounded-lg px-3 py-2.5 text-sm outline-none" style={{ border: '1px solid #d7dee6', color: NAVY }} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-semibold mb-1" style={{ color: '#697386' }}>EXPIRY</label>
                    <input value={expiry} onChange={e => setExpiry(e.target.value)} placeholder="MM/YY"
                      className="w-full rounded-lg px-3 py-2.5 text-sm outline-none" style={{ border: '1px solid #d7dee6', color: NAVY }} />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold mb-1" style={{ color: '#697386' }}>CVV</label>
                    <input value={cvv} onChange={e => setCvv(e.target.value)} maxLength={3}
                      className="w-full rounded-lg px-3 py-2.5 text-sm outline-none" style={{ border: '1px solid #d7dee6', color: NAVY }} />
                  </div>
                </div>
                <p className="text-[10px] flex items-center gap-1" style={{ color: '#9aa5b1' }}>
                  <Lock className="w-3 h-3" /> Test card prefilled — tap Pay to simulate.
                </p>
              </div>
            )}

            {method === 'transfer' && (
              <div className="space-y-2 text-center">
                <p className="text-xs" style={{ color: '#697386' }}>Transfer exactly <b style={{ color: NAVY }}>{formatNaira(amount)}</b> to:</p>
                <div className="rounded-lg py-3" style={{ background: '#f0f8fc', border: `1px dashed ${BLUE}` }}>
                  <div className="text-[10px]" style={{ color: '#697386' }}>Paystack-Titan · Virtual Account</div>
                  <div className="text-xl font-extrabold tracking-wider" style={{ color: NAVY }}>{vAcct}</div>
                </div>
                <p className="text-[10px]" style={{ color: '#9aa5b1' }}>Account expires in 30:00. Tap below once you've sent it.</p>
              </div>
            )}

            {method === 'ussd' && (
              <div className="space-y-2 text-center">
                <p className="text-xs" style={{ color: '#697386' }}>Dial this on your registered phone:</p>
                <div className="text-2xl font-extrabold" style={{ color: NAVY }}>{ussd}</div>
                <p className="text-[10px]" style={{ color: '#9aa5b1' }}>Approve the prompt, then tap below.</p>
              </div>
            )}

            {phase === 'failed' && error && (
              <div className="mt-3 text-[11px] rounded-lg px-3 py-2" style={{ background: '#fdecec', color: '#c0392b' }}>{error}</div>
            )}

            <button
              onClick={pay}
              className="w-full mt-4 py-3 rounded-lg font-bold text-sm cursor-pointer transition-opacity hover:opacity-90"
              style={{ background: BLUE, color: '#fff' }}
            >
              {method === 'card' ? payLabel : method === 'transfer' ? "I've sent the transfer" : "I've dialed the code"}
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="px-5 py-2.5 flex items-center justify-between" style={{ background: '#f6f9fc', borderTop: '1px solid #e6ebf1' }}>
          <span className="text-[10px] flex items-center gap-1" style={{ color: '#9aa5b1' }}>
            <ShieldCheck className="w-3 h-3" /> Secured by Paystack
          </span>
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ background: '#fff4e5', color: '#b26a00' }}>TEST MODE</span>
        </div>
      </motion.div>
    </div>
  );
}
