// Sign-in for the per-site admin panel.
//
// Primary: Google. Google only allows sign-in buttons on origins listed in the OAuth client, and
// it does not accept wildcards, so every site signs in through ONE page on the base host
// (PUBLIC_URL/auth/google). That page verifies the Google account and hands the browser back to
// the site's own subdomain with a short-lived signed code, which becomes a session cookie there.
//
// Ownership: the first Google account that arrives with the site's private claim link (texted to
// the owner when the site is published) becomes the owner. After that only that account gets in.
//
// Fallback, when no Google client is configured: the private claim link alone signs the owner in.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env.mjs';

const key = (purpose) => createHmac('sha256', env.sessionSecret || env.toolSecret || env.appCert || 'dev-only').update(`launchpad:${purpose}`).digest();

export const sign = (purpose, payload, ttlSeconds) => {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })).toString('base64url');
  return `${body}.${createHmac('sha256', key(purpose)).update(body).digest('base64url')}`;
};

export const verify = (purpose, token) => {
  const [body, mac] = String(token ?? '').split('.');
  if (!body || !mac) return null;
  const want = createHmac('sha256', key(purpose)).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
};

export const googleReady = () => Boolean(env.googleClientId);

/** Check a Google ID token with Google and return { email, name } or throw. */
export const verifyGoogleCredential = async (credential) => {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(String(credential ?? ''))}`, { signal: AbortSignal.timeout(10_000) });
  const info = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Google did not accept that sign-in.');
  if (info.aud !== env.googleClientId) throw new Error('That sign-in was issued for a different app.');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(info.iss)) throw new Error('Unexpected sign-in issuer.');
  if (Number(info.exp) * 1000 < Date.now()) throw new Error('That sign-in has expired.');
  if (String(info.email_verified) !== 'true' || !info.email) throw new Error('That Google account has no verified email.');
  return { email: String(info.email).toLowerCase(), name: String(info.name ?? '').slice(0, 80) };
};

export const cookies = (req) => Object.fromEntries(String(req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2).map(([k, v]) => [k, decodeURIComponent(v)]));

const secure = () => env.publicUrl.startsWith('https://');
const cookieName = (slug) => `lp_admin_${slug.replace(/[^a-z0-9]/g, '_')}`;

export const sessionCookie = (slug, user) =>
  `${cookieName(slug)}=${encodeURIComponent(sign('session', { slug, email: user.email ?? null, name: user.name ?? '', auth: user.auth }, 7 * 24 * 3600))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}${secure() ? '; Secure' : ''}`;
export const clearCookie = (slug) => `${cookieName(slug)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure() ? '; Secure' : ''}`;

/** The signed-in admin for this site, or null. */
export const adminSession = (req, site) => {
  const session = verify('session', cookies(req)[cookieName(site.slug)]);
  if (!session || session.slug !== site.slug) return null;
  // If the site has since been claimed by a Google account, a link-only session no longer counts.
  if (session.auth === 'link' && site.ownerEmail) return null;
  if (session.auth === 'google' && site.ownerEmail && session.email !== site.ownerEmail) return null;
  return session;
};

const sameToken = (a, b) => {
  const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
};
export const validClaim = (site, claim) => sameToken(claim, site.claimToken);

/** Where the browser goes to sign in with Google for this site's admin panel. */
export const adminSignInUrl = (site, claim) =>
  `${env.publicUrl}/auth/google?purpose=admin&site=${encodeURIComponent(site.slug)}${claim ? `&claim=${encodeURIComponent(claim)}` : ''}`;
export const visitorSignInUrl = () => `${env.publicUrl}/auth/google?purpose=visitor`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The one page that hosts the Google button. `state` is passed back untouched on verify. */
export const signInPage = ({ title, state }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Sign in · Launchpad</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: #f4f6f5; color: #14262a; padding: 24px; }
  main { width: min(100%, 26rem); background: #fff; border: 1px solid #d6dedc; border-radius: 16px; padding: 32px 28px; display: grid; gap: 14px; }
  h1 { font-size: 22px; line-height: 1.25; margin: 0; }
  p { margin: 0; color: #54696d; }
  #msg { color: #a13d0a; font-weight: 600; min-height: 1.5em; }
  @media (prefers-color-scheme: dark) { body { background: #0d1a1d; color: #e3eeee; } main { background: #14262a; border-color: #25393e; } p { color: #94abae; } #msg { color: #f0a070; } }
</style>
<script src="https://accounts.google.com/gsi/client" async defer></script>
</head><body><main>
  <h1>${esc(title)}</h1>
  <p>Sign in with your Google account to continue.</p>
  <div id="button"></div>
  <p id="msg" role="alert"></p>
</main>
<script>
  const state = ${JSON.stringify(state)};
  const msg = document.getElementById('msg');
  const onCredential = async (response) => {
    msg.textContent = 'Signing you in…';
    try {
      const res = await fetch('/auth/google/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: response.credential, state }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sign-in failed.');
      location.replace(data.redirect);
    } catch (err) { msg.textContent = err.message; }
  };
  window.addEventListener('load', () => {
    if (!window.google || !google.accounts) { msg.textContent = 'Google sign-in could not load. Check your connection and reload.'; return; }
    google.accounts.id.initialize({ client_id: ${JSON.stringify(env.googleClientId)}, callback: onCredential, ux_mode: 'popup' });
    google.accounts.id.renderButton(document.getElementById('button'), { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', width: 300 });
  });
</script>
</body></html>`;
