// Paystack Inline v2 loader.
//
// The transaction is initialized on OUR server with the secret key, which hands
// back an access code. The browser only resumes that access code — it never
// sees a key and never states an amount, so a tampered client cannot change
// what gets charged.
//
// The callbacks here are a UX signal only. Value is delivered exclusively by
// the server after it verifies the reference with Paystack (or after the
// webhook arrives) — never on the strength of onSuccess alone.

const SCRIPT_SRC = 'https://js.paystack.co/v2/inline.js';

let loader: Promise<void> | null = null;

function loadInline(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('No browser environment.'));
  if ((window as any).PaystackPop) return Promise.resolve();
  if (loader) return loader;

  loader = new Promise<void>((resolve, reject) => {
    const fail = () => {
      loader = null; // let a later attempt retry rather than caching the failure
      reject(new Error('Could not load Paystack checkout. Check your connection.'));
    };

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', fail);
      return;
    }

    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = fail;
    document.head.appendChild(script);
  });

  return loader;
}

export type PaystackOutcome = 'success' | 'cancelled' | 'error';

// Open the Paystack popup for a server-initialized access code.
// Resolves once the popup reaches a terminal state; the caller then asks the
// server to verify. Rejects only if the script itself could not be loaded.
export async function openPaystackCheckout(accessCode: string): Promise<PaystackOutcome> {
  await loadInline();

  const PaystackPop = (window as any).PaystackPop;
  if (!PaystackPop) throw new Error('Paystack checkout is unavailable.');

  return new Promise<PaystackOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: PaystackOutcome) => {
      if (settled) return; // Paystack can fire more than one callback
      settled = true;
      resolve(outcome);
    };

    try {
      const popup = new PaystackPop();
      popup.resumeTransaction(accessCode, {
        onSuccess: () => settle('success'),
        onCancel: () => settle('cancelled'),
        onError: () => settle('error'),
        onclose: () => settle('cancelled'), // v1-style name, harmless if unused
      });
    } catch {
      settle('error');
    }
  });
}
