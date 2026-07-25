// Referral link capture (client side).
//
// A referral link (…/?ref=CODE) is almost always opened by someone who has no
// account yet, so the code has to survive the whole sign-up detour: landing
// page → AuthGate → create account → first profile load. We read it off the URL
// before React even mounts, stash it on the device, and hand it to the server
// once we know which account it belongs to.
//
// Nothing is paid out at capture time. The referrer earns their free ticket
// later, when the invited account actually buys tickets.

const REF_KEY = 'pine_referral_code';
const CODE_LENGTH = 6;

// Mirror of the server's normalizer: accept whatever was pasted (lowercase,
// stray punctuation) and reduce it to the canonical stored form.
export function normalizeReferralCode(code: string): string {
  return (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
}

// Read ?ref=CODE off the current URL, remember it, then strip it from the
// address bar so a refresh (or a screenshot of the URL) doesn't carry it on.
// Call this once, before the app mounts.
export function captureReferralFromUrl(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('ref');
    if (!raw) return;

    const code = normalizeReferralCode(raw);
    // First link wins — a second link must not overwrite a pending capture.
    if (code.length === CODE_LENGTH && !localStorage.getItem(REF_KEY)) {
      localStorage.setItem(REF_KEY, code);
    }

    params.delete('ref');
    const qs = params.toString();
    window.history.replaceState(
      {}, '',
      window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
    );
  } catch {
    // Private mode / storage blocked — the referral simply doesn't stick.
  }
}

export function getStoredReferral(): string {
  try { return localStorage.getItem(REF_KEY) || ''; } catch { return ''; }
}

export function clearStoredReferral(): void {
  try { localStorage.removeItem(REF_KEY); } catch { /* ignore */ }
}

// The link a player shares. Prefer what the server computed (it knows the real
// public origin); fall back to this browser's own origin.
export function buildReferralLink(code: string, serverLink?: string): string {
  if (serverLink) return serverLink;
  if (!code) return '';
  return `${window.location.origin}/?ref=${code}`;
}
