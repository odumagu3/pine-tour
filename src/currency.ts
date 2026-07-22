// Naira (₦) formatting + shared tournament economy constants.
// Kept in one place so the client and any future integration stay consistent.

export const TICKET_PACK_SIZE = 8;
export const TICKET_PACK_PRICE = 3800; // ₦ for a pack of 8 tournament tickets

// Format an amount as Naira, e.g. 75000 -> "₦75,000".
export function formatNaira(amount: number): string {
  const n = Math.round(amount || 0);
  return '₦' + n.toLocaleString('en-NG');
}
