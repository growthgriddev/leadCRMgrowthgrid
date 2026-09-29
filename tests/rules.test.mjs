// Firestore rules — tenant isolation + company state (active / grace / suspended / cancelled).
// Chalane ke liye (repo root se):  npm run test:rules   (firebase emulator + Java chahiye)
import { test, before, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, addDoc, getDocs, query, where, Timestamp } from 'firebase/firestore';

const here = path.dirname(fileURLToPath(import.meta.url));
const rules = fs.readFileSync(path.join(here, '..', 'firestore.rules'), 'utf8');

let env;
const day = 86400000;
const ts = (ms) => Timestamp.fromMillis(Date.now() + ms);

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-growthgrid',
    firestore: { rules, host: '127.0.0.1', port: 8080 },
  });
});
after(async () => { await env.cleanup(); });

// Do companies: A (active, paid), B (active). Har ek mein ek ldr-fresh lead, ek sales-owned lead.
async function seed(overrides = {}) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'tenants', 'A'), {
      name: 'Alpha', status: 'active', paid_until: ts(10 * day), access_until: ts(13 * day), grace_days: 3, ...overrides,
    });
    await setDoc(doc(db, 'tenants', 'B'), { name: 'Beta', status: 'active', paid_until: ts(10 * day), access_until: ts(13 * day) });
    await setDoc(doc(db, 'tenant_slugs', 'alpha'), { tid: 'A', name: 'Alpha' });
    for (const t of ['A', 'B']) {
      await setDoc(doc(db, 'tenants', t, 'leads', 'fresh1'), { name: 'Fresh', status: 'fresh', ldr_uid: null, sales_uid: null });
      await setDoc(doc(db, 'tenants', t, 'leads', 'sale1'), { name: 'Owned', status: 'qualified', ldr_uid: 'l1', sales_uid: 's1', sales_status: 'followup' });
      await setDoc(doc(db, 'tenants', t, 'leads', 'other'), { name: 'Other', status: 'qualified', ldr_uid: 'l9', sales_uid: 's9', sales_status: 'followup' });
      await setDoc(doc(db, 'tenants', t, 'config', 'settings'), { company_name: t });
      await setDoc(doc(db, 'tenants', t, 'config', 'mail_secret'), { pass: 'x' });
      await setDoc(doc(db, 'tenants', t, 'users', 'admin1'), { role: 'admin', full_name: 'Admin' });
      await setDoc(doc(db, 'tenants', t, 'users', 's1'), { role: 'sales', full_name: 'Sales1' });
    }
  });
}
beforeEach(() => seed());

const as = (tid, role, uid) => env.authenticatedContext(uid || `${role}-${tid}`, { tid, role }).firestore();

// ---------- isolation ----------
test('own-company admin can read + write own leads', async () => {
  const db = as('A', 'admin', 'admin1');
  await assertSucceeds(getDoc(doc(db, 'tenants', 'A', 'leads', 'sale1')));
  await assertSucceeds(updateDoc(doc(db, 'tenants', 'A', 'leads', 'sale1'), { name: 'Renamed' }));
});

test('company A user CANNOT read company B data (any role)', async () => {
  for (const role of ['admin', 'md', 'tl', 'ldr', 'sales']) {
    const db = as('A', role);
    await assertFails(getDoc(doc(db, 'tenants', 'B', 'leads', 'fresh1')));
    await assertFails(getDoc(doc(db, 'tenants', 'B', 'config', 'settings')));
    await assertFails(getDoc(doc(db, 'tenants', 'B', 'users', 'admin1')));
    await assertFails(getDocs(collection(db, 'tenants', 'B', 'leads')));
  }
});

test('company A user CANNOT write company B data', async () => {
  const db = as('A', 'admin', 'admin1');
  await assertFails(setDoc(doc(db, 'tenants', 'B', 'leads', 'new1'), { name: 'x', status: 'fresh' }));
  await assertFails(updateDoc(doc(db, 'tenants', 'B', 'leads', 'sale1'), { name: 'hacked' }));
  await assertFails(deleteDoc(doc(db, 'tenants', 'B', 'leads', 'sale1')));
  await assertFails(addDoc(collection(db, 'tenants', 'B', 'activity'), { lead_id: '1' }));
});

test('no claims / signed-out => nothing', async () => {
  const noClaims = env.authenticatedContext('u1', {}).firestore();
  await assertFails(getDoc(doc(noClaims, 'tenants', 'A', 'leads', 'fresh1')));
  const anon = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anon, 'tenants', 'A', 'leads', 'fresh1')));
  await assertFails(getDoc(doc(anon, 'tenants', 'A')));
});

test('forged tid in the document body does not help (path decides)', async () => {
  const db = as('A', 'admin', 'admin1');
  await assertFails(setDoc(doc(db, 'tenants', 'B', 'leads', 'x'), { tid: 'A', name: 'x', status: 'fresh' }));
});

// ---------- roles inside a company ----------
test('sales sees only own leads; ldr sees fresh + own', async () => {
  const s = as('A', 'sales', 's1');
  await assertSucceeds(getDoc(doc(s, 'tenants', 'A', 'leads', 'sale1')));
  await assertFails(getDoc(doc(s, 'tenants', 'A', 'leads', 'other')));
  await assertFails(getDoc(doc(s, 'tenants', 'A', 'leads', 'fresh1')));

  const l = as('A', 'ldr', 'l1');
  await assertSucceeds(getDoc(doc(l, 'tenants', 'A', 'leads', 'fresh1')));
  await assertSucceeds(getDoc(doc(l, 'tenants', 'A', 'leads', 'sale1')));
  await assertFails(getDoc(doc(l, 'tenants', 'A', 'leads', 'other')));
});

test('sales cannot reassign ldr_uid or rewrite owner fields outside the allowed set', async () => {
  const s = as('A', 'sales', 's1');
  await assertFails(updateDoc(doc(s, 'tenants', 'A', 'leads', 'sale1'), { ldr_uid: 'me' }));
  await assertFails(updateDoc(doc(s, 'tenants', 'A', 'leads', 'sale1'), { name: 'x', status: 'dead' }));
  await assertSucceeds(updateDoc(doc(s, 'tenants', 'A', 'leads', 'sale1'), { sales_status: 'hot lead' }));
});

// KNOWN (inherited from the old Paris rules, tenant ke ANDAR hi): re-inquiry clause kisi bhi user ko sirf
// {status, sales_status, next_followup, ...} badalne deta hai, isliye "ldr sales_status nahi likh sakta" sirf
// tab tak sach hai jab saath mein koi aur field ho. Cross-company isolation pe isse asar nahi. Phase 1b mein tighten karenge.
test('KNOWN: re-inquiry clause allows status-only writes inside own company', async () => {
  const s = as('A', 'sales', 's1');
  await assertSucceeds(updateDoc(doc(s, 'tenants', 'A', 'leads', 'sale1'), { status: 'call back' }));
  // ...but never across companies
  await assertFails(updateDoc(doc(as('A', 'sales', 's1'), 'tenants', 'B', 'leads', 'sale1'), { status: 'call back' }));
});

test('non-admin cannot delete leads; admin can', async () => {
  await assertFails(deleteDoc(doc(as('A', 'sales', 's1'), 'tenants', 'A', 'leads', 'sale1')));
  await assertSucceeds(deleteDoc(doc(as('A', 'admin', 'admin1'), 'tenants', 'A', 'leads', 'sale1')));
});

test('user cannot change own role/status; admin cannot either (functions only)', async () => {
  await assertFails(updateDoc(doc(as('A', 'sales', 's1'), 'tenants', 'A', 'users', 's1'), { role: 'admin' }));
  await assertFails(updateDoc(doc(as('A', 'admin', 'admin1'), 'tenants', 'A', 'users', 's1'), { role: 'admin' }));
  await assertFails(updateDoc(doc(as('A', 'admin', 'admin1'), 'tenants', 'A', 'users', 's1'), { status: 'inactive' }));
  await assertSucceeds(updateDoc(doc(as('A', 'admin', 'admin1'), 'tenants', 'A', 'users', 's1'), { phone: '999' }));
  await assertSucceeds(updateDoc(doc(as('A', 'sales', 's1'), 'tenants', 'A', 'users', 's1'), { attendance: 'Present' }));
});

test('nobody can create/delete users from the client', async () => {
  const db = as('A', 'admin', 'admin1');
  await assertFails(setDoc(doc(db, 'tenants', 'A', 'users', 'new'), { role: 'admin' }));
  await assertFails(deleteDoc(doc(db, 'tenants', 'A', 'users', 's1')));
});

test('secrets never readable; only admin writes config', async () => {
  const a = as('A', 'admin', 'admin1');
  await assertFails(getDoc(doc(a, 'tenants', 'A', 'config', 'mail_secret')));
  await assertSucceeds(setDoc(doc(a, 'tenants', 'A', 'config', 'mail_secret'), { pass: 'y' }));
  await assertSucceeds(getDoc(doc(as('A', 'sales', 's1'), 'tenants', 'A', 'config', 'settings')));
  await assertFails(setDoc(doc(as('A', 'sales', 's1'), 'tenants', 'A', 'config', 'settings'), { x: 1 }));
});

test('activity is append-only', async () => {
  const db = as('A', 'sales', 's1');
  const ref = await assertSucceeds(addDoc(collection(db, 'tenants', 'A', 'activity'), { lead_id: '1', uid: 's1' }));
  await assertFails(updateDoc(ref, { lead_id: '2' }));
  await assertFails(deleteDoc(ref));
});

// ---------- company state ----------
test('grace period: paid_until over, access_until in future => still writable', async () => {
  await seed({ paid_until: ts(-1 * day), access_until: ts(2 * day) });
  await assertSucceeds(updateDoc(doc(as('A', 'admin', 'admin1'), 'tenants', 'A', 'leads', 'sale1'), { name: 'ok' }));
});

test('expired (past access_until) => view only', async () => {
  await seed({ paid_until: ts(-5 * day), access_until: ts(-2 * day) });
  const a = as('A', 'admin', 'admin1');
  await assertSucceeds(getDoc(doc(a, 'tenants', 'A', 'leads', 'sale1')));
  await assertFails(updateDoc(doc(a, 'tenants', 'A', 'leads', 'sale1'), { name: 'no' }));
  await assertFails(setDoc(doc(a, 'tenants', 'A', 'leads', 'n1'), { name: 'no', status: 'fresh' }));
  await assertFails(addDoc(collection(a, 'tenants', 'A', 'activity'), { lead_id: '1' }));
  await assertFails(setDoc(doc(a, 'tenants', 'A', 'meta', 'counters'), { leads: 1 }));
});

test('extending grace (later access_until) re-enables writes', async () => {
  await seed({ paid_until: ts(-5 * day), access_until: ts(-2 * day) });
  await assertFails(updateDoc(doc(as('A', 'admin', 'admin1'), 'tenants', 'A', 'leads', 'sale1'), { name: 'no' }));
  await env.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), 'tenants', 'A'), { access_until: ts(2 * day) });
  });
  await assertSucceeds(updateDoc(doc(as('A', 'admin', 'admin1'), 'tenants', 'A', 'leads', 'sale1'), { name: 'yes' }));
});

test('manually suspended => view only, even if paid', async () => {
  await seed({ status: 'suspended' });
  const a = as('A', 'admin', 'admin1');
  await assertSucceeds(getDoc(doc(a, 'tenants', 'A', 'leads', 'sale1')));
  await assertFails(updateDoc(doc(a, 'tenants', 'A', 'leads', 'sale1'), { name: 'no' }));
});

test('cancelled => no reads at all (own tenant doc still readable)', async () => {
  await seed({ status: 'cancelled' });
  const a = as('A', 'admin', 'admin1');
  await assertFails(getDoc(doc(a, 'tenants', 'A', 'leads', 'sale1')));
  await assertFails(getDocs(collection(a, 'tenants', 'A', 'leads')));
  await assertSucceeds(getDoc(doc(a, 'tenants', 'A')));
});

test('trial status behaves like active', async () => {
  await seed({ status: 'trial' });
  await assertSucceeds(updateDoc(doc(as('A', 'admin', 'admin1'), 'tenants', 'A', 'leads', 'sale1'), { name: 'ok' }));
});

test('suspending company A does not affect company B', async () => {
  await seed({ status: 'suspended' });
  await assertSucceeds(updateDoc(doc(as('B', 'admin', 'admin1'), 'tenants', 'B', 'leads', 'sale1'), { name: 'fine' }));
});

// ---------- platform level ----------
test('tenant / slug / plan / payment docs are never client-writable', async () => {
  const a = as('A', 'admin', 'admin1');
  await assertFails(updateDoc(doc(a, 'tenants', 'A'), { status: 'active', access_until: ts(999 * day) }));
  await assertFails(setDoc(doc(a, 'tenants', 'C'), { name: 'mine', status: 'active' }));
  await assertFails(setDoc(doc(a, 'tenant_slugs', 'evil'), { tid: 'A' }));
  await assertFails(setDoc(doc(a, 'plans', 'free'), { price: 0 }));
  const sa = env.authenticatedContext('root', { sa: true }).firestore();
  await assertFails(updateDoc(doc(sa, 'tenants', 'A'), { status: 'active' }));
});

test('tenant_slugs is public-read; company cannot read another company doc', async () => {
  const anon = env.unauthenticatedContext().firestore();
  await assertSucceeds(getDoc(doc(anon, 'tenant_slugs', 'alpha')));
  await assertFails(getDoc(doc(as('A', 'admin', 'admin1'), 'tenants', 'B')));
  await assertSucceeds(getDoc(doc(as('A', 'admin', 'admin1'), 'tenants', 'A')));
});

test('company users cannot read payments/plans/superadmins', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'tenants', 'A', 'payments', 'p1'), { amount: 1000 });
    await setDoc(doc(ctx.firestore(), 'plans', 'pro'), { price: 100 });
  });
  const a = as('A', 'admin', 'admin1');
  await assertFails(getDoc(doc(a, 'tenants', 'A', 'payments', 'p1')));
  await assertFails(getDoc(doc(a, 'plans', 'pro')));
  await assertFails(getDoc(doc(a, 'superadmins', 'root')));
});

test('super admin: reads tenants + payments + plans, but NOT company leads', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'tenants', 'A', 'payments', 'p1'), { amount: 1000 });
    await setDoc(doc(ctx.firestore(), 'plans', 'pro'), { price: 100 });
  });
  const sa = env.authenticatedContext('root', { sa: true }).firestore();
  await assertSucceeds(getDoc(doc(sa, 'tenants', 'A')));
  await assertSucceeds(getDoc(doc(sa, 'tenants', 'A', 'payments', 'p1')));
  await assertSucceeds(getDoc(doc(sa, 'plans', 'pro')));
  await assertFails(getDoc(doc(sa, 'tenants', 'A', 'leads', 'sale1')));
});
