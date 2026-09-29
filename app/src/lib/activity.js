import { collection, query, where, orderBy, limit, startAfter, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { tcol, tdoc } from './tenant';

/**
 * Activity feed (Call History). admin -> sabki, warna sirf apni.
 * @returns {{ rows, cursor, done }}
 */
export async function fetchActivityFeed({ role, uid, cursor = null, pageSize = 30, from = null, to = null }) {
  const parts = [tcol('activity')];
  if (role !== 'admin') parts.push(where('uid', '==', uid));
  if (from) parts.push(where('at', '>=', from));
  if (to) parts.push(where('at', '<=', to));
  parts.push(orderBy('at', 'desc'));
  if (cursor) parts.push(startAfter(cursor));
  parts.push(limit(pageSize));
  const snap = await getDocs(query(...parts));
  return {
    rows: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
    cursor: snap.docs.length ? snap.docs[snap.docs.length - 1] : null,
    done: snap.docs.length < pageSize,
  };
}

/** Ek lead ki poori activity timeline (newest first) */
export async function fetchLeadActivity(leadId, max = 60) {
  const q = query(
    tcol('activity'),
    where('lead_id', '==', leadId),
    orderBy('at', 'desc'),
    limit(max),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Ek lead ke orders (0-3 hote hain — client-side sort, extra index nahi chahiye) */
export async function fetchLeadOrders(leadId) {
  const q = query(tcol('orders'), where('lead_id', '==', leadId));
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.order_date?.seconds || 0) - (a.order_date?.seconds || 0));
}
