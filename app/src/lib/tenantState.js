// Company ka effective state — Super Admin ke set kiye tenants/{tid} fields se.
//   status        : 'active' | 'trial' | 'suspended' | 'cancelled'   (manual switch)
//   paid_until    : Timestamp — is tak paid
//   grace_days    : number (default 3) — company-wise badla ja sakta hai
//   access_until  : Timestamp — paid_until + grace_days (Cloud Function set karta hai; rules isi ko dekhte hain)
//
//   active     : paid, sab chalta hai
//   grace      : paid_until nikal gaya, access_until baaki — kaam chalta hai, banner dikhta hai
//   suspended  : access_until nikal gaya (ya manual suspend) — sirf VIEW (rules writes rokte hain)
//   cancelled  : login hi block
// NOTE: firestore.rules mein ye logic mirror hai (tenantWritable / tenantReadable) — dono saath badlo.

export const DEFAULT_GRACE_DAYS = 3;

const ms = (ts) => (ts?.toMillis ? ts.toMillis() : ts instanceof Date ? ts.getTime() : null);

export function tenantState(t, now = Date.now()) {
  if (!t) return 'cancelled';
  if (t.status === 'cancelled') return 'cancelled';
  if (t.status === 'suspended') return 'suspended';
  const paid = ms(t.paid_until);
  if (paid == null || now <= paid) return 'active';
  const acc = ms(t.access_until) ?? (paid + (t.grace_days ?? DEFAULT_GRACE_DAYS) * 86400000);
  return now <= acc ? 'grace' : 'suspended';
}

/** grace mein kitne din/ghante bache (banner ke liye) */
export function graceLeftMs(t, now = Date.now()) {
  const paid = ms(t?.paid_until);
  if (paid == null) return null;
  const acc = ms(t.access_until) ?? (paid + (t.grace_days ?? DEFAULT_GRACE_DAYS) * 86400000);
  return acc - now;
}
