// Auth context — Firebase user + custom claims {tid, role, sa} + tenant doc (status/plan) + users/{uid} profile.
// Security rules claims par chalte hain (firestore.rules); yahan ka state sirf UI ke liye hai.
import { createContext, useContext, useEffect, useState } from 'react';
import { onAuthStateChanged, signOut as fbSignOut, getIdTokenResult } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, db } from './firebase';
import { tdoc, setTenant } from './lib/tenant';
import { tenantState } from './lib/tenantState';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [fbUser, setFbUser] = useState(undefined); // undefined = loading, null = logged out
  const [claims, setClaims] = useState(null);      // { tid, role, sa }
  const [profile, setProfile] = useState(undefined);
  const [tenant, setTenantDoc] = useState(undefined);

  // tid claim se set hona chahiye PEHLE, warna config/leads ke listeners bina tenant ke chal padenge.
  useEffect(() => onAuthStateChanged(auth, async (u) => {
    if (!u) {
      setTenant(null); setClaims(null); setProfile(null); setTenantDoc(null); setFbUser(null);
      return;
    }
    try {
      const r = await getIdTokenResult(u);
      setTenant(r.claims.tid || null);
      setClaims({ tid: r.claims.tid || null, role: r.claims.role || null, sa: r.claims.sa === true });
    } catch (e) {
      setTenant(null); setClaims({ tid: null, role: null, sa: false });
    }
    setFbUser(u);
  }), []);

  useEffect(() => {
    if (!fbUser || !claims) return undefined;
    if (!claims.tid) { setProfile(null); setTenantDoc(null); return undefined; } // superadmin ya bekaar account
    const offP = onSnapshot(
      tdoc('users', fbUser.uid),
      (snap) => setProfile(snap.exists() ? { id: snap.id, ...snap.data() } : null),
      () => setProfile(null),
    );
    const offT = onSnapshot(
      doc(db, 'tenants', claims.tid),
      (snap) => setTenantDoc(snap.exists() ? { id: snap.id, ...snap.data() } : null),
      () => setTenantDoc(null),
    );
    return () => { offP(); offT(); };
  }, [fbUser, claims]);

  const isSuper = !!claims?.sa;
  const loading = fbUser === undefined || (fbUser && !claims)
    || (fbUser && claims?.tid && (profile === undefined || tenant === undefined));
  const tState = tenantState(tenant);            // active | grace | suspended | cancelled
  const value = {
    loading,
    fbUser,
    claims,
    isSuper,
    user: profile,                       // { id, full_name, role, must_reset_password, ... }
    role: profile?.role || null,
    tenant,                              // tenants/{tid} doc (name, plan, features, paid_until, ...)
    tenantState: tState,
    readOnly: tState === 'suspended',
    signOut: () => fbSignOut(auth),
  };
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
