# GrowthGrid CRM (SaaS)

Multi-tenant lead CRM. Firebase project: `growthgrid-saas`. Paris ke project/data se koi lena-dena nahi.

- `app/` — React + Vite PWA (login: company code + username)
- `functions/` — Cloud Functions (Node 22). `tenants.js` = company/user/license/billing callables, `index.js` = triggers + schedules (per-tenant)
- `firestore.rules`, `firestore.indexes.json`, `firebase.json`
- `tests/` — rules isolation tests + end-to-end functions tests (emulators; Java chahiye)
- `docs/PHASE1-DESIGN.md` — design + decisions

## Model
- Data: `tenants/{tid}/...` (tid = company slug). Company state (`tenants/{tid}`): status, paid_until, grace_days (default 3, company-wise), access_until, user_limit (licenses), price_per_user.
- Login: `<username>@<slug>.growthgrid.app` (synthetic), claims `{tid, role}` / `{sa:true}`.
- States: active → grace (banner, kaam chalta hai) → suspended (view-only) ; cancelled = login block. Rules enforce.
- Licence = ACTIVE users, server-side enforced.

## Tests
```
npm run test:rules        # 24 rules tests
npm run test:functions    # 11 end-to-end tests
npm test                  # dono
```

## Status
Phase 0 done. Phase 1 (multi-tenant core) code + tests done, NOT yet deployed.
Next: Phase 2 Super Admin panel (companies, seats, payments, suspend/resume, grace).
