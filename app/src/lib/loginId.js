// Login ID — user sirf username + company slug jaanta hai. Firebase Auth ko email chahiye,
// isliye peeche synthetic email banti hai (asli inbox nahi; verification/reset mail nahi jaati).
// functions/index.js mein bhi yahi logic hai (toLoginEmail) — dono ek jaise rakho.
export const LOGIN_DOMAIN = 'growthgrid.app';

export const cleanUsername = (u) => String(u || '').trim().toLowerCase().replace(/\s+/g, '');
export const cleanSlug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');

export const toLoginEmail = (username, slug) => `${cleanUsername(username)}@${cleanSlug(slug)}.${LOGIN_DOMAIN}`;

/** URL ka pehla path segment = company slug (app.com/<slug>) */
export function slugFromPath(pathname = window.location.pathname) {
  const seg = pathname.split('/').filter(Boolean)[0] || '';
  if (['superadmin', 'assets', 'index.html'].includes(seg)) return '';
  return cleanSlug(seg);
}
