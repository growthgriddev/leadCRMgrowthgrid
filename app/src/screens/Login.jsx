import { useState, useEffect } from 'react';
import { signInWithEmailAndPassword, updatePassword, signOut } from 'firebase/auth';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { toLoginEmail, cleanSlug, slugFromPath } from '../lib/loginId';
import { auth, db } from '../firebase';
import { useAuth } from '../auth';
import { useT, LANGS } from '../i18n';
import { tcol, tdoc } from '../lib/tenant';

const MSG = {
  'auth/invalid-credential': { en: 'Wrong email or password.', hi: 'ईमेल या पासवर्ड ग़लत है।', hinglish: 'Email ya password galat hai.' },
  'auth/invalid-email': { en: 'Email is not valid.', hi: 'ईमेल सही नहीं है।', hinglish: 'Email theek nahi hai.' },
  'auth/user-disabled': { en: 'This account is disabled. Contact admin.', hi: 'यह अकाउंट बंद है। एडमिन से बात करें।', hinglish: 'Ye account band hai. Admin se baat karein.' },
  'auth/too-many-requests': { en: 'Too many attempts. Try again later.', hi: 'बहुत बार कोशिश हुई। बाद में करें।', hinglish: 'Bahut baar try hua. Baad me karein.' },
  'auth/network-request-failed': { en: 'No internet. Check connection.', hi: 'इंटरनेट नहीं है।', hinglish: 'Internet nahi mil raha.' },
};

export default function Login() {
  const { fbUser, user } = useAuth();
  const { t, lang, setLang } = useT();
  const [slug, setSlug] = useState(slugFromPath());
  const [company, setCompany] = useState(null); // tenant_slugs/{slug}: naam/logo (public doc)
  const [username, setUsername] = useState('');
  const [pass, setPass] = useState('');
  const [np1, setNp1] = useState('');
  const [np2, setNp2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const mustReset = fbUser && user && user.must_reset_password;
  const em = (code, fb) => (MSG[code] && (MSG[code][lang] || MSG[code].en)) || fb;

  // company ka naam dikhane ke liye (public doc; na mile to bhi login try ho sakta hai)
  useEffect(() => {
    const sl = cleanSlug(slug);
    if (!sl) { setCompany(null); return undefined; }
    let alive = true;
    getDoc(doc(db, 'tenant_slugs', sl)).then((d) => { if (alive) setCompany(d.exists() ? d.data() : false); }).catch(() => {});
    return () => { alive = false; };
  }, [slug]);

  async function doLogin(e) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const sl = cleanSlug(slug);
      if (!sl) { setErr('Company code daalo.'); return; }
      await signInWithEmailAndPassword(auth, toLoginEmail(username, sl), pass);
    } catch (e2) {
      setErr(em(e2.code, 'Login failed. Try again.'));
    } finally { setBusy(false); }
  }

  async function doReset(e) {
    e.preventDefault();
    setErr('');
    if (np1.length < 6) return setErr(t('pwShort'));
    if (np1 !== np2) return setErr(t('pwMismatch'));
    setBusy(true);
    try {
      await updatePassword(auth.currentUser, np1);
      await updateDoc(tdoc('users', auth.currentUser.uid), { must_reset_password: false });
    } catch (e2) {
      if (e2.code === 'auth/requires-recent-login') { setErr(t('firstLogin')); await signOut(auth); }
      else setErr(em(e2.code, 'Could not set password.'));
    } finally { setBusy(false); }
  }

  return (
    <div className="login-wrap">
      <div className="login-box">
        <div className="login-logo"><i className="fas fa-gem" /></div>
        <h1>{company?.name || t('appName')}</h1>
        <p className="sub">{mustReset ? t('resetSub') : t('loginSub')}</p>

        {err && <div className="alert alert-error">{err}</div>}

        {!mustReset ? (
          <form onSubmit={doLogin}>
            {!slugFromPath() && (
              <div className="form-group">
                <label>Company code</label>
                <input className="form-control" autoCapitalize="none" required
                  value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="company-code" />
                {company === false && <small style={{ color: '#c00' }}>Company nahi mili</small>}
              </div>
            )}
            <div className="form-group">
              <label>Username</label>
              <input className="form-control" autoComplete="username" autoCapitalize="none" required
                value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" />
            </div>
            <div className="form-group">
              <label>{t('password')}</label>
              <input className="form-control" type="password" autoComplete="current-password" required
                value={pass} onChange={(e) => setPass(e.target.value)} placeholder="••••••••" />
            </div>
            <button className="btn btn-primary btn-block" disabled={busy}>{busy ? t('wait') : t('login')}</button>
          </form>
        ) : (
          <form onSubmit={doReset}>
            <div className="alert alert-info">{t('firstLogin')}</div>
            <div className="form-group">
              <label>{t('newPassword')}</label>
              <input className="form-control" type="password" autoComplete="new-password" required
                value={np1} onChange={(e) => setNp1(e.target.value)} />
            </div>
            <div className="form-group">
              <label>{t('confirmPassword')}</label>
              <input className="form-control" type="password" autoComplete="new-password" required
                value={np2} onChange={(e) => setNp2(e.target.value)} />
            </div>
            <button className="btn btn-primary btn-block" disabled={busy}>{busy ? t('wait') : t('setPassword')}</button>
            <button type="button" className="btn btn-ghost btn-block" style={{ marginTop: 8 }} onClick={() => signOut(auth)}>
              {t('cancel')}
            </button>
          </form>
        )}

        <div className="lang-row">
          {LANGS.map((l) => (
            <button key={l.code} className={lang === l.code ? 'active' : ''} onClick={() => setLang(l.code)}>{l.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
