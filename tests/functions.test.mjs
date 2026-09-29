// End-to-end: Auth + Firestore + Functions emulators. Real callables (functions/tenants.js) + triggers (tenant context).
// Chalane ke liye (repo root se):  npm run test:functions   (Java chahiye)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import admin from 'firebase-admin';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';

const PROJECT = 'demo-growthgrid';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
admin.initializeApp({ projectId: PROJECT });
const adb = admin.firestore();

const apps = [];
let n = 0;
async function clientFor(email, password) {
  const app = initializeApp({ apiKey: 'fake', projectId: PROJECT, authDomain: 'x' }, 'c' + (n++));
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const fns = getFunctions(app, 'asia-south1');
  connectFunctionsEmulator(fns, '127.0.0.1', 5001);
  const cred = await signInWithEmailAndPassword(auth, email, password);
  const claims = (await cred.user.getIdTokenResult(true)).claims;
  const call = async (name, data) => (await httpsCallable(fns, name)(data)).data;
  return { auth, call, claims, uid: cred.user.uid };
}
const code = async (p) => { try { await p; return null; } catch (e) { return String(e.code || e.message); } };

let sa; const creds = {};
before(async () => {
  const u = await admin.auth().createUser({ email: 'root@sa.growthgrid.app', password: 'rootpass1' });
  await admin.auth().setCustomUserClaims(u.uid, { sa: true });
  sa = await clientFor('root@sa.growthgrid.app', 'rootpass1');
});
after(async () => { await Promise.all(apps.map((a) => deleteApp(a))); });

const waitFor = async (fn, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 400)); }
  return null;
};

test('super admin creates two companies', async () => {
  for (const [slug, name] of [['alpha', 'Alpha Traders'], ['beta', 'Beta Textiles']]) {
    const r = await sa.call('createTenant', { slug, name, seats: 3, price_per_user: 200, admin_name: name + ' Admin', admin_username: 'boss' });
    assert.equal(r.tid, slug);
    creds[slug] = r.admin;
    assert.ok(r.admin.password.length >= 10);
  }
  const t = (await adb.doc('tenants/alpha').get()).data();
  assert.equal(t.user_limit, 3); assert.equal(t.active_users, 1); assert.equal(t.grace_days, 3);
  assert.ok(t.access_until.toMillis() - t.paid_until.toMillis() === 3 * 86400000);
  assert.ok((await adb.doc('tenant_slugs/alpha').get()).exists);
  assert.ok((await adb.doc('tenants/alpha/config/stages').get()).exists, 'default stages seeded');
});

test('non-super-admin cannot create a company; reserved / duplicate codes rejected', async () => {
  const boss = await clientFor('boss@alpha.growthgrid.app', creds.alpha.password);
  assert.equal(boss.claims.tid, 'alpha'); assert.equal(boss.claims.role, 'admin');
  assert.match(await code(boss.call('createTenant', { slug: 'gamma', name: 'G', seats: 1, admin_name: 'x' })), /permission-denied/);
  assert.match(await code(sa.call('createTenant', { slug: 'alpha', name: 'dup', seats: 1, admin_name: 'x' })), /already-exists/);
  assert.match(await code(sa.call('createTenant', { slug: 'superadmin', name: 'r', seats: 1, admin_name: 'x' })), /invalid-argument/);
});

test('license limit: seats enforced on the server', async () => {
  const boss = await clientFor('boss@alpha.growthgrid.app', creds.alpha.password);
  const l = await boss.call('createUser', { full_name: 'Lead Dev', username: 'ldr1', role: 'ldr', phone: '1' });
  const s = await boss.call('createUser', { full_name: 'Sales One', username: 'sales1', role: 'sales' });
  creds.ldr1 = l; creds.sales1 = s;
  assert.match(await code(boss.call('createUser', { full_name: 'Extra', username: 'extra', role: 'ldr' })), /resource-exhausted/);
  assert.equal((await adb.doc('tenants/alpha').get()).data().active_users, 3);
  assert.match(await code(boss.call('createUser', { full_name: 'Dup', username: 'ldr1', role: 'ldr' })), /already-exists|resource-exhausted/);
});

test('non-admin cannot manage users', async () => {
  const ldr = await clientFor('ldr1@alpha.growthgrid.app', creds.ldr1.password);
  assert.equal(ldr.claims.role, 'ldr');
  assert.match(await code(ldr.call('createUser', { full_name: 'x', username: 'hack', role: 'admin' })), /permission-denied/);
  assert.match(await code(ldr.call('updateUser', { uid: ldr.uid, patch: { role: 'admin' } })), /permission-denied/);
});

test('company A admin cannot touch company B users (cross-tenant attack)', async () => {
  const alphaBoss = await clientFor('boss@alpha.growthgrid.app', creds.alpha.password);
  const betaBoss = await clientFor('boss@beta.growthgrid.app', creds.beta.password);
  const victim = creds.sales1.uid; // alpha ka user
  // beta admin alpha ke user ka uid jaanta ho tab bhi — uske tenant mein wo user hai hi nahi
  assert.match(await code(betaBoss.call('deleteUser', { uid: victim, force: true })), /not-found/);
  assert.match(await code(betaBoss.call('updateUser', { uid: victim, patch: { status: 'inactive' } })), /not-found/);
  assert.match(await code(betaBoss.call('resetPassword', { uid: victim })), /not-found/);
  // tid param bhejna kaam nahi karta (sirf super admin ke liye)
  const r = await code(betaBoss.call('createUser', { tid: 'alpha', full_name: 'Sneaky', username: 'sneaky', role: 'ldr' }));
  assert.equal(r, null);
  assert.ok((await adb.doc('tenants/beta/users/' + (await admin.auth().getUserByEmail('sneaky@beta.growthgrid.app')).uid).get()).exists, 'user went to OWN company');
  assert.equal((await admin.auth().getUserByEmail('sales1@alpha.growthgrid.app')).disabled, false);
  assert.ok(alphaBoss);
});

test('role change updates claims; deactivate frees seat and blocks login', async () => {
  const boss = await clientFor('boss@alpha.growthgrid.app', creds.alpha.password);
  await boss.call('updateUser', { uid: creds.ldr1.uid, patch: { role: 'tl' } });
  const tl = await clientFor('ldr1@alpha.growthgrid.app', creds.ldr1.password);
  assert.equal(tl.claims.role, 'tl');

  await boss.call('updateUser', { uid: creds.ldr1.uid, patch: { status: 'inactive' } });
  assert.equal((await adb.doc('tenants/alpha').get()).data().active_users, 2);
  assert.match(await code(clientFor('ldr1@alpha.growthgrid.app', creds.ldr1.password)), /user-disabled|disabled/);
  // seat khaali hui => naya user ban sakta hai
  const nu = await boss.call('createUser', { full_name: 'New Guy', username: 'newguy', role: 'ldr' });
  assert.ok(nu.uid);
  // wapas active karna ab seat maangega (3/3 full)
  assert.match(await code(boss.call('updateUser', { uid: creds.ldr1.uid, patch: { status: 'active' } })), /resource-exhausted/);
});

test('admin cannot demote/deactivate self or the last admin', async () => {
  const boss = await clientFor('boss@alpha.growthgrid.app', creds.alpha.password);
  assert.match(await code(boss.call('updateUser', { uid: boss.uid, patch: { status: 'inactive' } })), /failed-precondition/);
  assert.match(await code(boss.call('updateUser', { uid: boss.uid, patch: { role: 'sales' } })), /failed-precondition/);
  assert.match(await code(boss.call('deleteUser', { uid: boss.uid })), /failed-precondition/);
});

test('reset password issues a new working password', async () => {
  const boss = await clientFor('boss@alpha.growthgrid.app', creds.alpha.password);
  const r = await boss.call('resetPassword', { uid: creds.sales1.uid });
  assert.ok(r.password && r.password !== creds.sales1.password);
  const again = await clientFor('sales1@alpha.growthgrid.app', r.password);
  assert.equal(again.claims.tid, 'alpha');
  creds.sales1.password = r.password;
});

test('payment extends paid_until; grace can be extended per company', async () => {
  const before = (await adb.doc('tenants/alpha').get()).data();
  const newPaid = Date.now() + 30 * 86400000;
  await sa.call('recordPayment', { tid: 'alpha', amount: 1800, new_paid_until: newPaid, mode: 'upi', note: 'Sep' });
  let t = (await adb.doc('tenants/alpha').get()).data();
  assert.equal(t.paid_until.toMillis(), newPaid);
  assert.equal(t.access_until.toMillis(), newPaid + 3 * 86400000);
  const pays = await adb.collection('tenants/alpha/payments').get();
  assert.equal(pays.size, 1); assert.equal(pays.docs[0].data().amount, 1800);
  assert.ok(before.paid_until.toMillis() < newPaid);

  await sa.call('extendGrace', { tid: 'alpha', extra_days: 2 });
  t = (await adb.doc('tenants/alpha').get()).data();
  assert.equal(t.access_until.toMillis(), newPaid + 5 * 86400000);
  assert.equal(t.grace_days, 3, 'one-off extension: grace_days permanent nahi badla');

  await sa.call('updateTenant', { tid: 'alpha', patch: { grace_days: 5 } });
  t = (await adb.doc('tenants/alpha').get()).data();
  assert.equal(t.access_until.toMillis(), newPaid + 5 * 86400000);
  // seats current active users se kam nahi ho sakte
  assert.match(await code(sa.call('updateTenant', { tid: 'alpha', patch: { user_limit: 1 } })), /failed-precondition/);
  await sa.call('updateTenant', { tid: 'alpha', patch: { user_limit: 10 } });
});

test('trigger runs in the right company: lead auto-assigned only to that company sales user', async () => {
  const boss = await clientFor('boss@alpha.growthgrid.app', creds.alpha.password);
  const bBoss = await clientFor('boss@beta.growthgrid.app', creds.beta.password);
  const bSales = await bBoss.call('createUser', { full_name: 'Beta Sales', username: 'bsales', role: 'sales' });
  await adb.doc('tenants/alpha/leads/L1').set({ name: 'Test Lead', status: 'qualified', ldr_uid: boss.uid, sales_uid: null, outcome: '', created_at: admin.firestore.Timestamp.now() });
  const got = await waitFor(async () => (await adb.doc('tenants/alpha/leads/L1').get()).data().sales_uid);
  assert.equal(got, creds.sales1.uid, 'alpha ke sales user ko mila');
  assert.notEqual(got, bSales.uid);
  const notif = await waitFor(async () => { const q = await adb.collection('tenants/alpha/notifications').where('to_uid', '==', got).get(); return q.size; });
  assert.ok(notif, 'notification bhi company ke andar bani');
  assert.equal((await adb.collection('notifications').get()).size, 0, 'top-level pe kuch nahi likha');
  assert.equal((await adb.collection('tenants/beta/notifications').get()).size, 0);
});

test('suspended company: admin cannot manage users; resume works', async () => {
  const boss = await clientFor('boss@alpha.growthgrid.app', creds.alpha.password);
  await sa.call('setTenantStatus', { tid: 'alpha', status: 'suspended' });
  assert.match(await code(boss.call('createUser', { full_name: 'x', username: 'zzz', role: 'ldr' })), /failed-precondition/);
  // super admin phir bhi kar sakta hai
  await sa.call('setTenantStatus', { tid: 'alpha', status: 'active' });
  const ok = await code(boss.call('createUser', { full_name: 'After Resume', username: 'afterresume', role: 'ldr' }));
  assert.equal(ok, null);
});
