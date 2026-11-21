// The backend every site gets, served on the site's own subdomain:
//   customer side (no sign-in)   /_lp/widget.js  /_lp/track.js  /_lp/api/config  /talk  /enquiry  /event
//   owner side (Google sign-in)  /admin  /_lp/api/admin/*
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env, root, E164 } from './env.mjs';
import { addLead, appendTranscript, getLead, leadForTalk, listLeads, updateLead } from './crm.mjs';
import { adminSession, adminSignInUrl, clearCookie, googleReady, sessionCookie, validClaim, verify, visitorSignInUrl } from './auth.mjs';
import { buildConciergeAgent, conciergeLanguages, getTalk, startTalk, stopTalk } from './concierge.mjs';
import { adminUrl, attachRef, changeSite, publicView, publishSite, saveSite, siteUrl, siteDir } from './sites.mjs';
import { notify } from './notify.mjs';
import { buildPhoneAgent } from './phone-agent.mjs';
import { startCall } from './phone.mjs';
import { photoFile } from './site-kit.mjs';
import { acceptEvents, siteStats, talkAlive, talkEnded, talkStarted } from './analytics.mjs';

const KIT = join(root, 'site-kit');
const STATIC = {
  '/_lp/widget.js': [join(KIT, 'widget.js'), 'text/javascript; charset=utf-8'],
  '/_lp/track.js': [join(KIT, 'track.js'), 'text/javascript; charset=utf-8'],
  '/_lp/admin.js': [join(KIT, 'admin', 'admin.js'), 'text/javascript; charset=utf-8'],
  '/_lp/admin.css': [join(KIT, 'admin', 'admin.css'), 'text/css; charset=utf-8'],
  '/_lp/vendor/agora-rtc.js': [join(root, 'node_modules/agora-rtc-sdk-ng/AgoraRTC_N-production.js'), 'text/javascript; charset=utf-8'],
  '/_lp/vendor/agora-rtm.js': [join(root, 'node_modules/agora-rtm/agora-rtm.js'), 'text/javascript; charset=utf-8'],
};

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });

const readBody = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65_536) throw fail(413, 'That request is too large.');
    chunks.push(chunk);
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { throw fail(400, 'The request body must be JSON.'); }
};

const clientIp = (req) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
const phoneE164 = (raw) => {
  const digits = String(raw ?? '').replace(/[^\d+]/g, '');
  if (E164.test(digits)) return digits;
  if (/^\d{10}$/.test(digits)) return `+91${digits}`; // a bare ten-digit number is taken as Indian
  return null;
};

// Visits are counted for people, on the published page. Not for crawlers and link previewers,
// not for a browser fetching the page ahead of time, and not for the owner while they are signed
// in to the dashboard (they would otherwise be their own best visitor).
// "bot" is matched with its case (Googlebot, AdsBot) because phones such as CUBOT are people.
const BOT_NAME = /[a-z]bot\b|Bot\b|^bot/;
const BOT_KIND = /crawl|spider|slurp|headless|phantomjs|lighthouse|pagespeed|prerender|facebookexternalhit|bingpreview|inspectiontool|^(curl|wget|python|node|go-http|java|okhttp|axios|undici|ruby|php|libwww)/i;
/** Does this request come from someone whose visit should be counted? Never throws. */
export const countable = (req, site) => {
  try {
    const ua = String(req.headers['user-agent'] ?? '');
    if (!ua || BOT_NAME.test(ua) || BOT_KIND.test(ua)) return false;
    if (/prefetch|prerender|preview/i.test(`${req.headers['sec-purpose'] ?? ''} ${req.headers.purpose ?? ''} ${req.headers['x-purpose'] ?? ''} ${req.headers['x-moz'] ?? ''}`)) return false;
    return !adminSession(req, site);
  } catch {
    return false;
  }
};

/**
 * The script tags added to the published page when it is served: the assistant, and (for
 * visits that count) the visit counter. The counter goes first so the assistant finds it ready.
 */
export const withWidget = (html, { track = false } = {}) => {
  const tag = `${track ? '<script src="/_lp/track.js" defer></script>\n' : ''}<script src="/_lp/widget.js" defer></script>`;
  // Template pages carry a "no scripts at all" policy; the widget is ours, so lift it.
  const open = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, '');
  return open.includes('</body>') ? open.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${tag}\n</body>`) : `${open}\n${tag}`;
};

// ---------------------------------------------------------- customer side ----

const customer = {
  'GET /_lp/api/config': async ({ site }) => ({
    name: site.name,
    lang: site.lang ?? 'en',
    languages: conciergeLanguages(),
    voice: Boolean(env.appId && env.appCert && env.murfKey),
    greeting: `Ask the assistant about ${site.name}, or leave a message.`,
    google: { signInUrl: googleReady() ? visitorSignInUrl() : null },
  }),

  'POST /_lp/api/talk': async ({ site, body, req, register }) => {
    const visitor = body.visitor && typeof body.visitor === 'object' ? { name: String(body.visitor.name ?? '').slice(0, 80), email: String(body.visitor.email ?? '').slice(0, 120) } : null;
    const grant = await startTalk({ site, lang: String(body.lang ?? ''), visitor, ip: clientIp(req), register });
    // Counted here rather than by the page, so a blocked script cannot hide a conversation.
    if (countable(req, site)) talkStarted(site.slug, { talkId: grant.talkId, v: body.v, lang: getTalk(grant.talkId)?.lang, maxSeconds: grant.maxSeconds });
    return grant;
  },

  'POST /_lp/api/talk/transcript': async ({ site, body }) => {
    const talk = getTalk(body.talkId);
    if (!talk || talk.slug !== site.slug) return { ok: true }; // the talk is over; nothing to attach to
    talkAlive(body.talkId);
    const lines = (Array.isArray(body.lines) ? body.lines : []).filter((l) => l && typeof l.text === 'string' && l.text.trim());
    if (!lines.length) return { ok: true };
    let lead = await leadForTalk(site.slug, body.talkId);
    if (!lead) lead = await addLead(site.slug, { source: 'voice', lang: talk.lang, talkId: body.talkId, name: talk.visitor?.name, email: talk.visitor?.email, summary: '' });
    await appendTranscript(site.slug, lead.id, lines);
    return { ok: true };
  },

  'POST /_lp/api/talk/stop': async ({ site, body }) => {
    const talk = getTalk(body.talkId);
    // The statistics close the talk even when the session itself has already timed out.
    talkEnded(site.slug, String(body.talkId ?? ''), body.seconds);
    if (talk && talk.slug === site.slug) await stopTalk(body.talkId);
    return { ok: true };
  },

  'POST /_lp/api/enquiry': async ({ site, body }) => {
    const name = String(body.name ?? '').trim();
    const message = String(body.message ?? '').trim();
    const email = String(body.email ?? '').trim();
    if (!name) throw fail(400, 'Please tell us your name.', { field: 'name' });
    const phone = phoneE164(body.phone);
    if (!phone && !email) throw fail(400, 'Please give a phone number with country code, or an email.', { field: 'phone' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'That email address does not look right.', { field: 'email' });
    if (message.length < 3) throw fail(400, 'Please write a short message.', { field: 'message' });
    await addLead(site.slug, { source: 'form', name, phone: phone ?? '', email, message, summary: message.slice(0, 160), lang: String(body.lang ?? site.lang ?? 'en') });
    if (site.to) notify({ to: site.to, template: 'newEnquiry', vars: [site.name, name, message.slice(0, 200), `${site.slug}/admin/${site.claimToken}`], text: `Launchpad: new enquiry for ${site.name} from ${name}: ${message.slice(0, 160)}. See it: ${adminUrl(site)}` }).catch(() => {});
    return { ok: true };
  },
};

// What the visit counter on a published page reports (site-kit/track.js). Open to anyone, so the
// body is tiny, checked field by field and rate limited (analytics.mjs). Requests that should not
// count get the same quiet "ok" as those that do, so the endpoint tells a prober nothing.
const EVENT_BYTES = 4096;
const visitorEvent = async ({ req, res, site }) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
  // Anything past the limit is let through unread (so the sender gets a proper answer, not a
  // dropped connection) and a sender that keeps going far beyond it is cut off.
  const raw = await new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= EVENT_BYTES) chunks.push(chunk);
      else if (size > 256 * 1024) req.destroy();
    });
    req.on('end', () => resolve(size <= EVENT_BYTES ? Buffer.concat(chunks) : null));
    req.on('close', () => resolve(null));
  });
  if (!raw) return json(res, 413, { error: 'That request is too large.' });
  let body;
  try { body = JSON.parse(raw.toString()); } catch { return json(res, 400, { error: 'The request body must be JSON.' }); }
  const fetchSite = req.headers['sec-fetch-site']; // browsers say where a request came from; another site's page does not get to add visits
  const referer = String(req.headers.referer ?? '');
  const counts = Boolean(site.publishedHtml) && countable(req, site) && (!fetchSite || fetchSite === 'same-origin') && !/\/(preview|admin)(\/|\?|$)/.test(referer);
  const out = await acceptEvents(site.slug, body, { address: clientIp(req), dryRun: !counts });
  return json(res, out.status, out.status === 200 ? { ok: true } : { error: out.error });
};

// ------------------------------------------- owner pages opened from a private link ----
// These carry the site's claim token in the address, so only the owner's messages lead here.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const page = (title, inner) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #f4f6f5; --card: #fff; --ink: #14262a; --muted: #54696d; --line: #c9d3d1; --accent: #0b7285; --on: #fff; --bad: #a13d0a; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0d1a1d; --card: #14262a; --ink: #e3eeee; --muted: #94abae; --line: #2c4248; --accent: #5cc4d4; --on: #06181b; --bad: #f0a070; } }
  * { box-sizing: border-box; } body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 24px max(16px, env(safe-area-inset-right)) 48px max(16px, env(safe-area-inset-left)); }
  main { max-width: 34rem; margin: 0 auto; display: grid; gap: 18px; } h1 { font-size: 24px; line-height: 1.25; margin: 0; } p { margin: 0; color: var(--muted); }
  form { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 22px 18px; display: grid; gap: 16px; }
  label { display: grid; gap: 6px; font-weight: 600; font-size: 15px; } label span { font-weight: 400; color: var(--muted); font-size: 14px; }
  input, textarea { font: inherit; color: var(--ink); background: var(--card); border: 1px solid var(--muted); border-radius: 10px; padding: 12px; min-height: 46px; width: 100%; } textarea { min-height: 96px; resize: vertical; }
  input:focus-visible, textarea:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  button { font: 600 16px/1 inherit; border: 0; border-radius: 999px; padding: 15px 22px; background: var(--accent); color: var(--on); cursor: pointer; min-height: 48px; } button:disabled { opacity: .6; cursor: progress; }
  #msg { font-weight: 600; min-height: 1.5em; color: var(--ink); } #msg[data-bad="1"] { color: var(--bad); } a { color: var(--accent); }
</style></head><body><main>${inner}</main></body></html>`;

const detailsPage = (site, claim) => page(`A few details for ${site.name}`, `
  <h1>A few details for ${esc(site.name)}</h1>
  <p>Fill in whatever you would like on your website. Leave the rest empty. Your page updates as soon as you send this.</p>
  <form id="f" novalidate>
    <label>Phone number for customers<input name="phone" type="tel" autocomplete="tel" inputmode="tel"></label>
    <label>WhatsApp number <span>if different</span><input name="whatsapp" type="tel" inputmode="tel"></label>
    <label>Email<input name="email" type="email" autocomplete="email"></label>
    <label>Address<input name="address" autocomplete="street-address"></label>
    <label>Opening hours<input name="hours" placeholder="For example: every day, 6 am to 11 am"></label>
    <label>Anything else to add or change<textarea name="more"></textarea></label>
    <button type="submit">Update my website</button>
    <p id="msg" role="status" aria-live="polite"></p>
  </form>
  <script>
    const f = document.getElementById('f'), msg = document.getElementById('msg'), btn = f.querySelector('button');
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); if (btn.disabled) return;
      const data = Object.fromEntries(new FormData(f)); data.claim = ${JSON.stringify(claim)};
      if (!Object.entries(data).some(([k, v]) => k !== 'claim' && String(v).trim())) { msg.dataset.bad = '1'; msg.textContent = 'Please fill in at least one field.'; return; }
      btn.disabled = true; msg.dataset.bad = ''; msg.textContent = 'Updating your website. This can take up to a minute…';
      try {
        const res = await fetch('/_lp/api/details', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
        const out = await res.json(); if (!res.ok) throw new Error(out.error || 'That did not work.');
        msg.textContent = out.summary + ' '; const a = document.createElement('a'); a.href = out.url; a.textContent = 'See your website'; msg.append(a);
      } catch (err) { msg.dataset.bad = '1'; msg.textContent = err.message; }
      btn.disabled = false;
    });
  </script>`);

const callMePage = (site, claim) => page(`Call me about ${site.name}`, `
  <h1>Ready to talk about ${esc(site.name)}?</h1>
  <p>Our AI assistant will phone the number we have for you, within a few seconds, to carry on with your website.</p>
  <form id="f"><button type="submit">Call me now</button><p id="msg" role="status" aria-live="polite"></p></form>
  <script>
    const f = document.getElementById('f'), msg = document.getElementById('msg'), btn = f.querySelector('button');
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); if (btn.disabled) return; btn.disabled = true; msg.dataset.bad = ''; msg.textContent = 'Calling you…';
      try {
        const res = await fetch('/_lp/api/callme', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claim: ${JSON.stringify(claim)} }) });
        const out = await res.json(); if (!res.ok) throw new Error(out.error || 'We could not place the call.');
        msg.textContent = 'Your phone should ring in a few seconds.';
      } catch (err) { msg.dataset.bad = '1'; msg.textContent = err.message; btn.disabled = false; }
    });
  </script>`);

const ownerLink = {
  'POST /_lp/api/details': async ({ site, body }) => {
    if (!validClaim(site, body.claim)) throw fail(403, 'This link is not valid any more.');
    const field = (k, max = 200) => String(body[k] ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const parts = [
      field('phone') && `the phone number for customers is ${field('phone')}`,
      field('whatsapp') && `the WhatsApp number is ${field('whatsapp')} (add a WhatsApp button)`,
      field('email') && `the email address is ${field('email')}`,
      field('address') && `the address is ${field('address')}`,
      field('hours') && `the opening hours are ${field('hours')}`,
      field('more', 600) && `also: ${field('more', 600)}`,
    ].filter(Boolean);
    if (!parts.length) throw fail(400, 'Please fill in at least one field.');
    const wasPublic = Boolean(site.publishedAt);
    const out = await changeSite(site, `The owner sent these details through a form. Add or update them on the page, replacing any older value: ${parts.join('; ')}.`);
    if (!out.ok) throw fail(502, 'Your details could not be added just now. Please try again in a minute.');
    if (wasPublic) await publishSite(site); // a site that is already live gets the update straight away
    return { ok: true, summary: wasPublic ? 'Done. Your website has been updated.' : 'Done. Your preview has been updated.', url: wasPublic ? siteUrl(site.slug) : `${siteUrl(site.slug)}/preview` };
  },

  'POST /_lp/api/callme': async ({ site, body, register }) => {
    if (!validClaim(site, body.claim)) throw fail(403, 'This link is not valid any more.');
    if (!site.to) throw fail(400, 'We do not have a phone number for this site.');
    const call = await startCall({
      to: site.to, name: site.brief?.owner_name, lang: site.lang,
      agent: (ref) => { attachRef(ref, site.slug); return buildPhoneAgent({ name: site.brief?.owner_name, ref, lang: site.lang, followUp: { name: site.name, sections: site.sections ?? [], published: Boolean(site.publishedAt) } }); },
    });
    return { ok: true, callId: call.callId };
  },
};

// ------------------------------------------------------------- owner side ----

const admin = {
  'POST /_lp/api/admin/logout': async ({ site, res }) => { res.setHeader('set-cookie', clearCookie(site.slug)); return { ok: true }; },

  'GET /_lp/api/admin/leads': async ({ site }) => listLeads(site.slug),

  // How the site is doing over the last 7, 30 (default) or 90 days.
  'GET /_lp/api/admin/stats': async ({ site, url }) => siteStats(site, url.searchParams.get('days')),

  'GET /_lp/api/admin/site': async ({ site }) => publicView(site),

  'POST /_lp/api/admin/site/change': async ({ site, body }) => {
    const out = await changeSite(site, body.change);
    return { ok: out.ok, summary: out.summary };
  },

  'POST /_lp/api/admin/site/publish': async ({ site }) => {
    const out = await publishSite(site);
    if (!out.ok) throw fail(409, 'The page is not ready to publish yet.');
    return { ok: true, url: out.url };
  },
};

const adminLead = async ({ site, session, method, id, action, body }) => {
  const lead = await getLead(site.slug, id);
  if (!lead) throw fail(404, 'That lead no longer exists.');
  if (method === 'PATCH' && !action) {
    return { lead: await updateLead(site.slug, id, { status: body.status, note: body.note }, session.email ?? 'owner') };
  }
  if (method === 'POST' && action === 'message') {
    const text = String(body.text ?? '').trim();
    if (!text) throw fail(400, 'Write the message first.');
    const to = phoneE164(lead.phone);
    if (!to) throw fail(400, 'This lead has no usable phone number.');
    const sent = await notify({ to, template: 'enquiryReply', vars: [lead.name || 'there', site.name, text, site.slug], text: `${site.name}: ${text}` });
    if (!sent.sent) throw fail(502, `The message was not sent. ${sent.error ?? ''}`.trim());
    return { ok: true, lead: await updateLead(site.slug, id, { outMessage: { text, status: `sent by ${sent.channel === 'whatsapp' ? 'WhatsApp' : 'text message'}` }, status: lead.status === 'new' ? 'contacted' : undefined }) };
  }
  if (method === 'POST' && action === 'call') {
    const to = phoneE164(lead.phone);
    if (!to) throw fail(400, 'This lead has no usable phone number.');
    const call = await startCall({ to, name: lead.name, lang: lead.lang, agent: (ref) => buildConciergeAgent({ site, ref, lang: lead.lang, mode: 'callback', lead }), about: { slug: site.slug, leadId: lead.id } });
    await updateLead(site.slug, id, { note: 'The assistant phoned them back.', status: lead.status === 'new' ? 'contacted' : undefined }, session.email ?? 'owner');
    return { ok: true, callId: call.callId };
  }
  throw fail(404, 'Not found.');
};

// ----------------------------------------------------------------- router ----

/** Returns true when the request was for the site kit (and has been answered). */
export const handleSiteKit = async ({ req, res, site, path, url, register }) => {
  const method = req.method;

  // Static files
  if (method === 'GET' && STATIC[path]) {
    try {
      const [file, type] = STATIC[path];
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': type, 'cache-control': path.includes('/vendor/') ? 'public, max-age=86400' : 'no-cache' });
      res.end(data);
    } catch { json(res, 404, { error: 'Not found.' }); }
    return true;
  }

  // Photographs from the curated library
  const photo = method === 'GET' && path.match(/^\/_lp\/photos\/([a-z0-9-]+)\/([a-z0-9-]+\.jpg)$/);
  if (photo) {
    const file = photoFile(photo[1], photo[2]);
    if (!file) { json(res, 404, { error: 'Not found.' }); return true; }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=604800, immutable' });
    res.end(await readFile(file));
    return true;
  }

  // Pictures made for this site during a call
  const made = method === 'GET' && path.match(/^\/_lp\/img\/([a-f0-9]{12})\.(jpg|png|webp)$/);
  if (made) {
    try {
      const data = await readFile(join(siteDir(site.slug), 'img', `${made[1]}.${made[2]}`));
      res.writeHead(200, { 'content-type': made[2] === 'jpg' ? 'image/jpeg' : `image/${made[2]}`, 'cache-control': 'public, max-age=604800, immutable' });
      res.end(data);
    } catch { json(res, 404, { error: 'Not found.' }); }
    return true;
  }

  // The admin panel page itself (the page loads for anyone; its data needs a session)
  if (method === 'GET' && path === '/admin') {
    try {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' });
      res.end(await readFile(join(KIT, 'admin', 'index.html')));
    } catch { json(res, 404, { error: 'The admin panel is not installed.' }); }
    return true;
  }

  // Back from Google sign-in on the base host, carrying a short-lived signed code
  if (method === 'GET' && path === '/admin/session') {
    const code = verify('handoff', url.searchParams.get('code'));
    const denied = (why) => { res.writeHead(302, { location: `/admin?denied=${encodeURIComponent(why)}`, 'cache-control': 'no-store' }); res.end(); return true; };
    if (!code || code.slug !== site.slug) return denied('expired');
    if (!site.ownerEmail) {
      if (!validClaim(site, code.claim)) return denied('link');
      site.ownerEmail = code.email;
      await saveSite(site);
      console.log(`site ${site.slug} claimed by its owner`);
    } else if (site.ownerEmail !== code.email) return denied('account');
    res.writeHead(302, { location: '/admin', 'set-cookie': sessionCookie(site.slug, { email: code.email, name: code.name, auth: 'google' }), 'cache-control': 'no-store' });
    res.end();
    return true;
  }

  // Pages the owner reaches from a private link in a message
  if (method === 'GET' && (path === '/details' || path === '/callme')) {
    const claim = url.searchParams.get('claim') ?? '';
    res.writeHead(validClaim(site, claim) ? 200 : 403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' });
    res.end(!validClaim(site, claim) ? page('Link not valid', '<h1>This link is not valid any more.</h1><p>Open the newest message we sent you.</p>') : path === '/details' ? detailsPage(site, claim) : callMePage(site, claim));
    return true;
  }

  if (!path.startsWith('/_lp/api/')) return false;

  try {
    // The visit counter reads its own (much smaller) body, so it is answered before the rest.
    if (path === '/_lp/api/event') { await visitorEvent({ req, res, site }); return true; }

    const body = method === 'GET' ? {} : await readBody(req);

    const open = customer[`${method} ${path}`] ?? ownerLink[`${method} ${path}`];
    if (open) { json(res, 200, await open({ site, body, req, res, register })); return true; }

    if (path.startsWith('/_lp/api/admin/')) {
      // "Who am I", which is also where the private link signs the owner in when Google is off
      if (method === 'GET' && path === '/_lp/api/admin/me') {
        let session = adminSession(req, site);
        const claim = url.searchParams.get('claim');
        const headers = {};
        if (!session && !googleReady() && validClaim(site, claim) && !site.ownerEmail) {
          session = { email: null, name: site.brief?.owner_name ?? '', auth: 'link' };
          headers['set-cookie'] = sessionCookie(site.slug, session);
        }
        if (!session) {
          json(res, 401, { error: googleReady() ? 'Sign in to manage this site.' : 'Open the private link from your text message to manage this site.', google: googleReady(), signInUrl: googleReady() ? adminSignInUrl(site, claim) : null });
          return true;
        }
        json(res, 200, { email: session.email, name: session.name, auth: session.auth, site: { slug: site.slug, name: site.name, url: siteUrl(site.slug), previewUrl: '/preview', status: site.status, lang: site.lang } }, headers);
        return true;
      }
      const session = adminSession(req, site);
      if (!session) throw fail(401, 'Your session has ended. Sign in again.');
      // A cookie is sent automatically, so make sure a changing request came from this site's own pages.
      if (method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && origin !== siteUrl(site.slug)) throw fail(403, 'That request did not come from this site.');
      }
      const handler = admin[`${method} ${path}`];
      if (handler) { json(res, 200, await handler({ site, body, req, res, session, url })); return true; }
      const m = path.match(/^\/_lp\/api\/admin\/leads\/([a-f0-9]{8,32})(?:\/(message|call))?$/);
      if (m) { json(res, 200, await adminLead({ site, session, method, id: m[1], action: m[2], body })); return true; }
    }
    json(res, 404, { error: 'Not found.' });
  } catch (err) {
    const status = err.status ?? 500;
    if (status >= 500) console.error(`site ${site.slug} ${method} ${path}: ${err.message}`);
    json(res, status, { error: status >= 500 && !err.status ? 'Something went wrong on our side.' : err.message, ...(err.extra ?? {}) });
  }
  return true;
};
