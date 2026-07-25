// Naira (₦) formatting + shared tournament economy constants.
// Kept in one place so the client and any future integration stay consistent.

// Ticket economy fallbacks (the live values come from the admin config).
export const TICKET_PRICE = 300;  // ₦ per tournament ticket
export const MIN_TICKETS = 4;     // fewest tickets buyable at once
export const MAX_TICKETS = 64;    // most tickets buyable at once

// Referral rewards. A player earns REFERRAL_REWARD_TICKETS free ticket(s) each
// time someone who signed up through their link buys tickets, up to
// REFERRAL_REWARD_CAP rewards in total. The server is authoritative; these are
// the client's fallbacks before /api/referral responds.
export const REFERRAL_REWARD_TICKETS = 1;
export const REFERRAL_REWARD_CAP = 10;

// Format an amount as Naira, e.g. 75000 -> "₦75,000".
export function formatNaira(amount: number): string {
  const n = Math.round(amount || 0);
  return '₦' + n.toLocaleString('en-NG');
}
