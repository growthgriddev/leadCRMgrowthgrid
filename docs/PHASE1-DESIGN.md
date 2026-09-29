# Phase 1 — Multi-tenant core: design (approval ke liye)

Status: DRAFT — code abhi nahi likha. Approve hone par hi shuru.

## 1. Data structure

```
tenants/{tid}                       company profile (Super Admin ya Cloud Function likhta hai)
  name, slug, status: active|suspended|trial|cancelled
  plan_id, features{...override}, user_limit, price, billing_cycle,
  paid_until, logo_url, brand_color, timezone, currency, created_at
tenants/{tid}/users/{uid}           (pehle: users/{uid})
tenants/{tid}/leads, activity, orders, phone_index, notifications,
                 config/{stages|forms|settings|access|...}, meta/counters,
                 stats_daily, stats_cohort, reports_weekly, audit, logs,
                 recycle, admin_tasks, tickets, help_queries, help_kb
tenants/{tid}/payments/{id}         Super Admin ka billing ledger (amount, date, mode, note, period)

tenant_slugs/{slug}                 PUBLIC read: { tid, name, logo_url, brand_color, status }  (login page ke liye)
plans/{planId}                      { name, price, user_limit, features{} }
superadmins/{uid}                   sirf aap
```

- Ek company ka poora data ek `tenants/{tid}` ke neeche => rules simple, export/delete ek jagah se.
- Existing indexes (collection-scope) subcollections par bhi lagte hain (deploy pe verify karna hai).

## 2. Login + roles

- Firebase Auth global hai. Har user ka email synthetic: `<username>@<slug>.growthgrid.app`
  (real email nahi chahiye; verification nahi hoti). Login page `app/<slug>` se slug pata karta hai,
  user sirf **username + password** daalta hai.
- **Custom claims** (Admin SDK se): `{ tid, role, sa? }`. Rules `request.auth.token.tid/role` padhte hain
  => users-doc ka `get()` har request pe nahi lagta (cost bachta hai).
- Role change / deactivate / suspend => `revokeRefreshTokens` + claims update; client token refresh karta hai.
- Roles wahi: admin, md, tl, ldr, sales (permissions.js matrix waisa hi). Company admin = tenant ka `admin`.
- Super Admin = claim `sa:true` + `superadmins/{uid}`. Alag route `/superadmin`.

## 3. User management = Cloud Functions (callable)

Abhi client `createUserWithEmailAndPassword` (secondary app) + fixed temp password. Ye SaaS mein nahi chalega:

| Callable | Kaun | Kaam |
|---|---|---|
| `createTenant` | superadmin | tenant + tenant_slugs + pehla admin user + claims, random password wapas |
| `createUser` | tenant admin | user limit **server pe** check, random password, claims, users doc |
| `updateUser` / `setUserStatus` | tenant admin | role/active badalna + claims + token revoke |
| `resetPassword` | tenant admin | naya random password (email reset nahi — synthetic email hai) |
| `setTenantStatus` | superadmin | suspend/resume/cancel + saare users ke tokens revoke |
| `updateTenantPlan` / `recordPayment` | superadmin | plan, price, limit, paid_until, ledger |

User limit + suspend ka enforcement server/rules mein hoga, sirf UI mein nahi.

## 4. Security rules (design)

```
tid()        = request.auth.token.tid
role()       = request.auth.token.role
inTenant(t)  = signedIn && tid() == t
active(t)    = get(/tenants/$(t)).data.status in ['active','trial']   // instant suspend
isSA()       = request.auth.token.sa == true

match /tenants/{t}/leads/{id}  ... existing rules, har jagah `inTenant(t) && active(t) &&`
match /tenants/{t} : read = inTenant(t) || isSA(); write = false (functions/SA-callable)
match /tenant_slugs/{s} : read = true; write = false
```
- Existing lead/notification/config rules ka logic same rahega, bas path + tenant gate.
- Suspended tenant: reads/writes sab band (active(t) false).
- **Test**: emulator + rules-unit-testing — A ka user B ka data na padhe/likhe, suspended block, role rules regress na hon.

## 5. Client (app) changes

- `src/lib/tenant.js`: `setTenant(tid)`, `tcol(path)`, `tdoc(path, ...id)` => `tenants/${tid}/...`
- ~90 jagah `collection(db,'x')` → `tcol('x')`, `doc(db,'x',id)` → `tdoc('x',id)` (mechanical, grep-verifiable).
- `auth.jsx`: claims se tid/role, users doc `tenants/{tid}/users/{uid}` sunna, tenant doc sunna (status/plan/features).
- `Login.jsx`: slug + username; first-login password change same rahega.
- `admin.js`: createUser/reset => callables.
- Route: `/<slug>` (login), `/superadmin` (Phase 2).

## 6. Cloud Functions changes

- `tdb` wrapper (AsyncLocalStorage): `tdb.collection('leads')` => `tenants/<current tid>/leads`. Existing ~69 `db.collection/doc` calls
  sed se `tdb.*`; tenant-root wale (`tenants/...`) `db.*` rahenge. Function signatures nahi badalte.
- Triggers path: `tenants/{tid}/leads/{id}` etc.; handler `runForTenant(tid, ...)` se context set.
- Schedules (`slaScan`, `dailyMaintenance`, `weeklyReport`): saare `active` tenants par loop, per-tenant settings/timezone,
  ek fail hone par baaki chalein. (Scale hone par Cloud Tasks fan-out — abhi zaroorat nahi.)
- Per-tenant secrets: mail_secret / ai_secret pehle jaise `config/*` mein (client read false).

## 7. Isme jo abhi NAHI (baad ke phase)

- Super Admin UI, billing screens (Phase 2)
- Feature flags/plans ka UI aur branding (Phase 4)
- Monday weekly-off / IST / ₹ hardcodes ko tenant setting banana (Phase 4/5)

## 8. Kaam ka order (Phase 1)

1. `tenant.js` + client path rewrite + auth/claims plumbing
2. Firestore rules (tenant-scoped) + emulator tests  ← Java chahiye
3. Callable functions (tenant/user mgmt) + `tdb` wrapper + triggers/schedules
4. Login (slug+username), tenant status gate
5. Isolation test suite (A/B tenants) — pass hone par hi Phase 2

## 9. Approval chahiye — decisions

1. Synthetic email `username@slug.growthgrid.app` OK? (Password-reset email nahi; admin reset karega.)
2. AI help bot: platform ki ek key (Premium plan feature) ya har company apni key?
3. Ek user = ek company (recommended). Same username alag companies mein chalega (slug se alag).
4. Suspended company ka data dikhe (read-only) ya login hi block? (Recommend: login block + message)
