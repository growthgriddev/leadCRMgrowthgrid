// Tenant-scoped Firestore paths. Har company ka data `tenants/{tid}/...` ke neeche hota hai.
// tid login ke baad auth.jsx custom-claim se set karta hai; uske pehle koi data access nahi hona chahiye.
import { collection, doc } from 'firebase/firestore';
import { db } from '../firebase';

let _tid = null;

export function setTenant(tid) { _tid = tid || null; }
export function getTenantId() { return _tid; }

function need() {
  if (!_tid) throw new Error('no-tenant');
  return _tid;
}

/** collection(db, 'tenants', tid, ...segments) */
export const tcol = (...seg) => collection(db, 'tenants', need(), ...seg);
/** doc(db, 'tenants', tid, ...segments) */
export const tdoc = (...seg) => doc(db, 'tenants', need(), ...seg);
