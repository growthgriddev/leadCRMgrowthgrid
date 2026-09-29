/**
 * GrowthGrid — company (tenant) + user management (callable functions).
 *
 * Kyun callable: Auth user banana, custom-claims (tid/role), license (seat) limit aur company ka state
 * client pe bharosa karke nahi hota. Sab yahan server pe enforce hota hai; Firestore rules sirf claims padhte hain.
 *
 * Super Admin (claim sa:true):  createTenant, updateTenant, setTenantStatus, recordPayment, extendGrace
 *                               (+ kisi bhi company ke liye createUser/updateUser/resetPassword/deleteUser, tid dekar)
 * Company admin (claim role=admin, tid): createUser, updateUser, resetPassword, deleteUser  (apni company ke liye)
 *
 * tid = company slug (lowercase a-z 0-9 -, immutable). Login email = <username>@<slug>.growthgrid.app (synthetic).
 * License = ACTIVE users ki ginti (tenants/{tid}.active_users), user_limit tak. Transaction mein reserve hoti hai.
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const crypto = require('crypto');

const OPTS = { region: 'asia-south1', maxInstances: 5, memory: '256MiB' };
const { FieldValue: FV, Timestamp: TS } = require('firebase-admin/firestore');
const DAY = 86400000;
const DEFAULT_GRACE_DAYS = 3;
const LOGIN_DOMAIN = 'growthgrid.app';
const ROLES = ['admin', 'md', 'tl', 'ldr', 'sales'];
const TENANT_STATUSES = ['active', 'trial', 'suspended', 'cancelled'];
const RESERVED_SLUGS = ['superadmin', 'admin', 'assets', 'api', 'app', 'login', 'www', 'static', 'index', 'manifest', 'icon', 'firebase', 'growthgrid', 'support', 'help'];

const rdb = () => admin.firestore();
const fail = (code, msg) => new HttpsError(code, msg);

// ---------- helpers ----------
// app/src/lib/loginId.js ka mirror
const cleanUsername = (u) => String(u || '').trim().toLowerCase().replace(/\s+/g, '');
const cleanSlug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
const toLoginEmail = (username, slug) => `${cleanUsername(username)}@${cleanSlug(slug)}.${LOGIN_DOMAIN}`;

function randomPassword(len = 10) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // confusing chars (0/O/1/l/I) nahi
  let out = '';
  for (let i = 0; i < len; i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}

const num = (v, name, { min = 0, max = 1e9, int = false } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw fail('invalid-argument', `${name} galat hai`);
  return n;
};
const str = (v, name, { min = 1, max = 200 } = {}) => {
  const s = String(v == null ? '' : v).trim();
  if (s.length < min || s.length > max) throw fail('invalid-argument', `${name} galat hai`);
  return s;
};

function stateOf(t, now = Date.now()) {
  if (!t || t.status === 'cancelled') return 'cancelled';
  if (t.status === 'suspended') return 'suspended';
  const paid = t.paid_until && t.paid_until.toMillis ? t.paid_until.toMillis() : null;
  if (paid == null || now <= paid) return 'active';
  const acc = t.access_until && t.access_until.toMillis ? t.access_until.toMillis()
    : paid + (t.grace_days == null ? DEFAULT_GRACE_DAYS : t.grace_days) * DAY;
  return now <= acc ? 'grace' : 'suspended';
}

const accessUntil = (paidMs, graceDays) => TS.fromMillis(paidMs + graceDays * DAY);

function requireSA(req) {
  if (!req.auth || req.auth.token.sa !== true) throw fail('permission-denied', 'Sirf super admin');
}

/** caller kaun hai? -> { tid, isSA }. Company admin ho to apni company; SA ho to data.tid dena zaroori */
function resolveTenant(req, data) {
  if (!req.auth) throw fail('unauthenticated', 'Login karo');
  if (req.auth.token.sa === true) {
    const tid = cleanSlug(data && data.tid);
    if (!tid) throw fail('invalid-argument', 'tid chahiye');
    return { tid, isSA: true };
  }
  if (req.auth.token.role !== 'admin' || !req.auth.token.tid) throw fail('permission-denied', 'Sirf company admin');
  return { tid: req.auth.token.tid, isSA: false };
}

async function loadTenant(tid, { needWritable, isSA }) {
  const ref = rdb().doc('tenants/' + tid);
  const snap = await ref.get();
  if (!snap.exists) throw fail('not-found', 'Company nahi mili');
  const t = snap.data();
  if (needWritable && !isSA) {
    const st = stateOf(t);
    if (st !== 'active' && st !== 'grace') throw fail('failed-precondition', 'tenant-suspended');
  }
  return { ref, t };
}

const userRef = (tid, uid) => rdb().doc(`tenants/${tid}/users/${uid}`);

/** ek license reserve karo (active_users < user_limit) — transaction mein, race-free */
async function reserveSeat(tenantRef) {
  await rdb().runTransaction(async (tx) => {
    const s = await tx.get(tenantRef);
    const t = s.data();
    const used = t.active_users || 0;
    const limit = t.user_limit || 0;
    if (used >= limit) throw fail('resource-exhausted', `License limit poori ho gayi (${used}/${limit}). Aur licenses ke liye admin se baat karein.`);
    tx.update(tenantRef, { active_users: used + 1 });
  });
}
const releaseSeat = (tenantRef) => tenantRef.update({ active_users: FV.increment(-1) }).catch(() => {});

async function activeAdminCount(tid) {
  const c = await rdb().collection(`tenants/${tid}/users`).where('role', '==', 'admin').where('status', '==', 'active').count().get();
  return c.data().count;
}

// ---------- default config for a NEW company (editable from Builders/Settings) ----------
function defaultConfig(companyName) {
  const stages = [
    { id: 'st_callback', name: 'Call Back', role: 'ldr', requires_date: 'Yes', color: '#f39c12', shows_form: 'No' },
    { id: 'st_qualified', name: 'Qualified', role: 'ldr', requires_date: 'No', color: '#2ecc40', shows_form: 'Yes' },
    { id: 'st_dead', name: 'Dead', role: 'ldr', requires_date: 'No', color: '#85144b', shows_form: 'No' },
    { id: 'st_followup', name: 'Followup', role: 'sales', requires_date: 'Yes', color: '#0074d9', shows_form: 'No' },
    { id: 'st_hot', name: 'Hot Lead', role: 'sales', requires_date: 'Yes', color: '#ff4136', shows_form: 'No' },
    { id: 'st_video', name: 'Video Call', role: 'sales', requires_date: 'Yes', color: '#7fdbff', shows_form: 'No' },
    { id: 'st_visit', name: 'Visit Customer', role: 'sales', requires_date: 'Yes', color: '#b10dc9', shows_form: 'No' },
    { id: 'st_order', name: 'Order Done', role: 'sales', requires_date: 'No', color: '#01ff70', shows_form: 'No' },
    { id: 'st_lost', name: 'Lost', role: 'sales', requires_date: 'No', color: '#aaaaaa', shows_form: 'No' },
  ].map((s) => ({ ...s, status: 'active' }));
  const f = (id, label, options) => ({
    id, label, type: 'dropdown', options, role_view: 'both', role_edit: 'both', status: 'active', is_mandatory: 'No',
  });
  const forms = [
    f('f_ctype', 'Customer Type', 'Existing Shop Owner,Boutique Owner,Online Seller,Reseller,New Business,Personal Use'),
    f('f_bulk', 'Bulk Requirement?', 'Yes,No'),
    f('f_intent', 'Buying Intent', 'Immediate,Exploring,Future'),
    f('f_interested', 'Customer Interested In', 'Visit Store,Video Call,WhatsApp Catalog,Not Interested'),
    f('f_qty', 'Approx Quantity Interested In', '10-20 pcs,20-50 pcs,50+ pcs'),
  ];
  const settings = {
    company_name: companyName,
    Lead_Sources: 'Facebook,Instagram,Google,JustDial,Referral,Walk-in,Direct',
    State_List: '',
    Attempt_Limit: '7',
    Work_Start: '09:00',
    Work_End: '21:00',
    SLA_FirstContact: '5m',
    SLA_FreshTouch: '30m',
    SLA_SalesTouch: '2h',
    SLA_FollowupOverdue: '2h',
    SLA_QualifiedUnassigned: '15m',
  };
  return { stages, forms, settings };
}

/** Auth user + claims + users doc (seat pehle se reserve honi chahiye). Returns { uid, email, password } */
async function provisionUser(tid, { full_name, username, phone, role, team, contact_email }) {
  const uname = cleanUsername(username);
  if (!/^[a-z0-9._-]{3,30}$/.test(uname)) throw fail('invalid-argument', 'Username 3-30 chars: a-z, 0-9, . _ -');
  if (!ROLES.includes(role)) throw fail('invalid-argument', 'Role galat hai');
  const email = toLoginEmail(uname, tid);
  const password = randomPassword();
  let rec;
  try {
    rec = await admin.auth().createUser({ email, password, displayName: str(full_name, 'Naam', { max: 80 }), emailVerified: false });
  } catch (e) {
    if (e.code === 'auth/email-already-exists') throw fail('already-exists', 'Ye username pehle se hai');
    throw e;
  }
  try {
    await admin.auth().setCustomUserClaims(rec.uid, { tid, role });
    await userRef(tid, rec.uid).set({
      full_name: str(full_name, 'Naam', { max: 80 }), login_id: uname, email, phone: String(phone || '').trim().slice(0, 30),
      role, status: 'active', attendance: 'Present', team: String(team || '').slice(0, 40),
      contact_email: String(contact_email || '').trim().toLowerCase().slice(0, 120),
      must_reset_password: true, fcm_tokens: [], created_at: FV.serverTimestamp(), updated_at: FV.serverTimestamp(),
    });
  } catch (e) {
    await admin.auth().deleteUser(rec.uid).catch(() => {});
    throw e;
  }
  return { uid: rec.uid, email, username: uname, password };
}

// =====================================================================
//  SUPER ADMIN
// =====================================================================
exports.createTenant = onCall(OPTS, async (req) => {
  requireSA(req);
  const d = req.data || {};
  const slug = cleanSlug(d.slug);
  if (!/^[a-z0-9][a-z0-9-]{2,29}$/.test(slug) || RESERVED_SLUGS.includes(slug)) throw fail('invalid-argument', 'Company code 3-30 chars (a-z, 0-9, -) aur reserved nahi hona chahiye');
  const name = str(d.name, 'Company naam', { max: 100 });
  const seats = num(d.seats, 'seats', { min: 1, max: 5000, int: true });
  const pricePerUser = num(d.price_per_user == null ? 0 : d.price_per_user, 'price_per_user', { max: 1e6 });
  const graceDays = num(d.grace_days == null ? DEFAULT_GRACE_DAYS : d.grace_days, 'grace_days', { max: 60, int: true });
  const paidUntil = d.paid_until ? num(d.paid_until, 'paid_until', { min: 1, max: 4e12 }) : Date.now() + 14 * DAY; // default: 14 din trial
  const status = d.status === 'trial' ? 'trial' : 'active';

  const tRef = rdb().doc('tenants/' + slug);
  if ((await tRef.get()).exists) throw fail('already-exists', 'Ye company code pehle se hai');

  // pehle company doc (active_users=1, admin ki seat), phir admin user — fail hua to rollback
  await tRef.set({
    name, slug, status, plan_id: String(d.plan_id || ''), user_limit: seats, price_per_user: pricePerUser, active_users: 1,
    paid_until: TS.fromMillis(paidUntil), grace_days: graceDays, access_until: accessUntil(paidUntil, graceDays),
    features: d.features && typeof d.features === 'object' ? d.features : {},
    notes: String(d.notes || '').slice(0, 500),
    created_at: FV.serverTimestamp(), created_by: req.auth.uid,
  });
  let admin_;
  try {
    admin_ = await provisionUser(slug, {
      full_name: str(d.admin_name, 'Admin naam', { max: 80 }), username: d.admin_username || 'admin', phone: d.admin_phone,
      role: 'admin', contact_email: d.admin_contact_email,
    });
  } catch (e) {
    await tRef.delete().catch(() => {});
    throw e;
  }
  const cfg = defaultConfig(name);
  const b = rdb().batch();
  b.set(rdb().doc('tenant_slugs/' + slug), { tid: slug, name, status: 'active' });
  b.set(rdb().doc(`tenants/${slug}/config/stages`), { stages: cfg.stages });
  b.set(rdb().doc(`tenants/${slug}/config/forms`), { fields: cfg.forms });
  b.set(rdb().doc(`tenants/${slug}/config/settings`), cfg.settings);
  b.set(rdb().doc(`tenants/${slug}/meta/counters`), { leads: 0 });
  await b.commit();
  return { tid: slug, admin: { username: admin_.username, password: admin_.password }, login_path: '/' + slug };
});

exports.updateTenant = onCall(OPTS, async (req) => {
  requireSA(req);
  const d = req.data || {};
  const tid = cleanSlug(d.tid);
  const { ref, t } = await loadTenant(tid, { isSA: true });
  const p = d.patch || {};
  const upd = { updated_at: FV.serverTimestamp() };
  if ('name' in p) upd.name = str(p.name, 'naam', { max: 100 });
  if ('plan_id' in p) upd.plan_id = String(p.plan_id || '');
  if ('price_per_user' in p) upd.price_per_user = num(p.price_per_user, 'price_per_user', { max: 1e6 });
  if ('notes' in p) upd.notes = String(p.notes || '').slice(0, 500);
  if ('features' in p) { if (!p.features || typeof p.features !== 'object') throw fail('invalid-argument', 'features galat'); upd.features = p.features; }
  for (const k of ['brand_color', 'logo_url', 'timezone', 'currency']) if (k in p) upd[k] = String(p[k] || '').slice(0, 300);
  if ('user_limit' in p) {
    const lim = num(p.user_limit, 'user_limit', { min: 1, max: 5000, int: true });
    if (lim < (t.active_users || 0)) throw fail('failed-precondition', `Abhi ${t.active_users} active users hain — pehle unhe kam karo`);
    upd.user_limit = lim;
  }
  if ('status' in p) {
    if (!TENANT_STATUSES.includes(p.status)) throw fail('invalid-argument', 'status galat');
    upd.status = p.status;
  }
  // paid_until / grace_days badle to access_until dobara nikalo (rules isi ko dekhte hain)
  const paidMs = 'paid_until' in p ? num(p.paid_until, 'paid_until', { min: 1, max: 4e12 }) : (t.paid_until && t.paid_until.toMillis ? t.paid_until.toMillis() : null);
  const grace = 'grace_days' in p ? num(p.grace_days, 'grace_days', { max: 60, int: true }) : (t.grace_days == null ? DEFAULT_GRACE_DAYS : t.grace_days);
  if ('paid_until' in p || 'grace_days' in p) {
    if ('paid_until' in p) upd.paid_until = TS.fromMillis(paidMs);
    upd.grace_days = grace;
    if (paidMs != null) upd.access_until = accessUntil(paidMs, grace);
  }
  await ref.update(upd);
  const pub = {};
  if (upd.name) pub.name = upd.name;
  if (upd.logo_url != null) pub.logo_url = upd.logo_url;
  if (upd.brand_color != null) pub.brand_color = upd.brand_color;
  if (Object.keys(pub).length) await rdb().doc('tenant_slugs/' + tid).set(pub, { merge: true });
  return { ok: true };
});

exports.setTenantStatus = onCall(OPTS, async (req) => {
  requireSA(req);
  const tid = cleanSlug((req.data || {}).tid);
  const status = (req.data || {}).status;
  if (!TENANT_STATUSES.includes(status)) throw fail('invalid-argument', 'status galat');
  const { ref } = await loadTenant(tid, { isSA: true });
  await ref.update({ status, updated_at: FV.serverTimestamp() });
  return { ok: true, status };
});

/** Payment aayi — ledger mein entry + paid_until aage (access_until = paid_until + grace_days) */
exports.recordPayment = onCall(OPTS, async (req) => {
  requireSA(req);
  const d = req.data || {};
  const tid = cleanSlug(d.tid);
  const { ref, t } = await loadTenant(tid, { isSA: true });
  const amount = num(d.amount, 'amount', { min: 0, max: 1e9 });
  const newPaidUntil = num(d.new_paid_until, 'new_paid_until', { min: 1, max: 4e12 });
  const prevPaid = t.paid_until && t.paid_until.toMillis ? t.paid_until.toMillis() : null;
  const grace = t.grace_days == null ? DEFAULT_GRACE_DAYS : t.grace_days;
  const payRef = rdb().collection(`tenants/${tid}/payments`).doc();
  const b = rdb().batch();
  b.set(payRef, {
    amount, paid_on: TS.fromMillis(d.paid_on ? num(d.paid_on, 'paid_on', { min: 1, max: 4e12 }) : Date.now()),
    period_from: prevPaid ? TS.fromMillis(prevPaid) : null, period_to: TS.fromMillis(newPaidUntil),
    mode: String(d.mode || '').slice(0, 30), note: String(d.note || '').slice(0, 300),
    seats: t.user_limit || 0, price_per_user: t.price_per_user || 0,
    recorded_by: req.auth.uid, created_at: FV.serverTimestamp(),
  });
  b.update(ref, { paid_until: TS.fromMillis(newPaidUntil), access_until: accessUntil(newPaidUntil, grace), updated_at: FV.serverTimestamp() });
  await b.commit();
  return { ok: true, payment_id: payRef.id };
});

/** Ek-baar ka grace badhana (is company ke liye, is cycle mein) — grace_days permanent nahi badalta */
exports.extendGrace = onCall(OPTS, async (req) => {
  requireSA(req);
  const d = req.data || {};
  const tid = cleanSlug(d.tid);
  const extra = num(d.extra_days, 'extra_days', { min: 1, max: 60, int: true });
  const { ref, t } = await loadTenant(tid, { isSA: true });
  const cur = t.access_until && t.access_until.toMillis ? t.access_until.toMillis() : Date.now();
  const base = Math.max(cur, Date.now());
  await ref.update({ access_until: TS.fromMillis(base + extra * DAY), updated_at: FV.serverTimestamp() });
  return { ok: true, access_until: base + extra * DAY };
});

// =====================================================================
//  USERS  (company admin ya super admin)
// =====================================================================
exports.createUser = onCall(OPTS, async (req) => {
  const { tid, isSA } = resolveTenant(req, req.data);
  const d = req.data || {};
  const { ref } = await loadTenant(tid, { needWritable: true, isSA });
  await reserveSeat(ref);
  try {
    const u = await provisionUser(tid, d);
    return { uid: u.uid, username: u.username, password: u.password };
  } catch (e) {
    await releaseSeat(ref);
    throw e;
  }
});

exports.updateUser = onCall(OPTS, async (req) => {
  const { tid, isSA } = resolveTenant(req, req.data);
  const d = req.data || {};
  const uid = str(d.uid, 'uid');
  const { ref } = await loadTenant(tid, { needWritable: true, isSA });
  const uRef = userRef(tid, uid);
  const snap = await uRef.get();
  if (!snap.exists) throw fail('not-found', 'User nahi mila');
  const u = snap.data();
  const p = d.patch || {};
  const upd = { updated_at: FV.serverTimestamp() };
  const self = req.auth.uid === uid;

  if ('full_name' in p) upd.full_name = str(p.full_name, 'Naam', { max: 80 });
  if ('phone' in p) upd.phone = String(p.phone || '').trim().slice(0, 30);
  if ('team' in p) upd.team = String(p.team || '').slice(0, 40);
  if ('contact_email' in p) upd.contact_email = String(p.contact_email || '').trim().toLowerCase().slice(0, 120);

  const newRole = 'role' in p ? p.role : u.role;
  const newStatus = 'status' in p ? p.status : u.status;
  if (!ROLES.includes(newRole)) throw fail('invalid-argument', 'Role galat hai');
  if (!['active', 'inactive'].includes(newStatus)) throw fail('invalid-argument', 'Status galat hai');
  const losesAdmin = u.role === 'admin' && u.status === 'active' && (newRole !== 'admin' || newStatus !== 'active');
  if (losesAdmin) {
    if (self) throw fail('failed-precondition', 'Apna admin role/status khud nahi badal sakte');
    if ((await activeAdminCount(tid)) < 2) throw fail('failed-precondition', 'Kam se kam ek active admin rehna chahiye');
  }

  let seatDelta = 0;
  if (newStatus !== u.status) seatDelta = newStatus === 'active' ? 1 : -1;
  if (seatDelta === 1) await reserveSeat(ref);
  try {
    if (newRole !== u.role) upd.role = newRole;
    if (newStatus !== u.status) upd.status = newStatus;
    if (newRole !== u.role || newStatus !== u.status) {
      await admin.auth().setCustomUserClaims(uid, { tid, role: newRole });
      await admin.auth().updateUser(uid, { disabled: newStatus !== 'active' });
      await admin.auth().revokeRefreshTokens(uid); // purana token/role turant bekaar
    }
    await uRef.update(upd);
  } catch (e) {
    if (seatDelta === 1) await releaseSeat(ref);
    throw e;
  }
  if (seatDelta === -1) await releaseSeat(ref);
  return { ok: true };
});

exports.resetPassword = onCall(OPTS, async (req) => {
  const { tid, isSA } = resolveTenant(req, req.data);
  const uid = str((req.data || {}).uid, 'uid');
  await loadTenant(tid, { needWritable: true, isSA });
  const uRef = userRef(tid, uid);
  if (!(await uRef.get()).exists) throw fail('not-found', 'User nahi mila');
  const password = randomPassword();
  await admin.auth().updateUser(uid, { password });
  await admin.auth().revokeRefreshTokens(uid);
  await uRef.update({ must_reset_password: true, updated_at: FV.serverTimestamp() });
  return { password };
});

exports.deleteUser = onCall(OPTS, async (req) => {
  const { tid, isSA } = resolveTenant(req, req.data);
  const d = req.data || {};
  const uid = str(d.uid, 'uid');
  const { ref } = await loadTenant(tid, { needWritable: true, isSA });
  const uRef = userRef(tid, uid);
  const snap = await uRef.get();
  if (!snap.exists) throw fail('not-found', 'User nahi mila');
  const u = snap.data();
  if (req.auth.uid === uid) throw fail('failed-precondition', 'Khud ko delete nahi kar sakte');
  if (u.role === 'admin' && u.status === 'active' && (await activeAdminCount(tid)) < 2) throw fail('failed-precondition', 'Kam se kam ek active admin rehna chahiye');
  if (!d.force) {
    const [l1, l2] = await Promise.all([
      rdb().collection(`tenants/${tid}/leads`).where('ldr_uid', '==', uid).limit(1).get(),
      rdb().collection(`tenants/${tid}/leads`).where('sales_uid', '==', uid).limit(1).get(),
    ]);
    if (!l1.empty || !l2.empty) throw fail('failed-precondition', 'has-leads');
  }
  await admin.auth().deleteUser(uid).catch((e) => { if (e.code !== 'auth/user-not-found') throw e; });
  await uRef.delete();
  if (u.status === 'active') await releaseSeat(ref);
  return { ok: true };
});

