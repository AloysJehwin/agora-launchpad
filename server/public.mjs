// The public listener (port 3211). Everything the outside world may reach:
//   - the agent's tools, called by Agora during a call      POST /tools/<name>   (bearer secret)
//   - each site on its own subdomain <slug>.<PUBLIC_HOST>   /  /preview  /preview/frame  /preview/events
//   - Caddy's question "may I get a certificate for X?"     GET  /internal/tls-ask?domain=X
// The operator console (which can place calls) is a different listener and is never served here.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { env, maskNumber } from './env.mjs';
import { notify } from './notify.mjs';
import { callers, registerCaller } from './callers.mjs';
import { carePublic } from './care-mount.mjs';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { root, E164 } from './env.mjs';
import { startCall, redialInLanguage } from './phone.mjs';
import { LANGUAGES } from './phone-agent.mjs';
import { publishedSites } from './sites.mjs';
import { recordEvent, signatureOk } from './call-events.mjs';
import { isAllowed } from './numbers.mjs';
import { handleSiteKit, withWidget } from './site-api.mjs';
import { addLead, leadForTalk, updateLead } from './crm.mjs';
import { googleReady, sign, signInPage, verifyGoogleCredential } from './auth.mjs';
import {
  getSite, siteForRef, startSite, changeSite, setImage, addDetails, designNow, publishSite, settled, follow, publicView, recoverRef,
  previewUrl, siteUrl, adminUrl, spokenAddress, renderPending,
} from './sites.mjs';

export { registerCaller };

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const html = (res, status, body, extra = {}) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(body);
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const readBody = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65_536) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { throw Object.assign(new Error('Body must be JSON'), { status: 400 }); }
};

const authorised = (req) => {
  const given = Buffer.from(String(req.headers.authorization ?? ''));
  const wanted = Buffer.from(`Bearer ${env.toolSecret}`);
  return Boolean(env.toolSecret) && given.length === wanted.length && timingSafeEqual(given, wanted);
};

// ------------------------------------------------------------------ tools ----
// What a tool returns is read by the voice model, never spoken verbatim. Keep it short and
// say plainly what is true and what to do next.

const text = (v, max = 600) => String(v ?? '').trim().slice(0, max);

const tools = {
  // The page exists from the moment we know the name: the link goes out at once and the page
  // grows as the conversation adds details (addDetails), then designs itself when there is enough.
  async startPreview(a) {
    const who = callers.get(a.ref) ?? {};
    const name = text(a.business_name, 80);
    if (!name) return { ok: false, note: 'The business or person name is missing. Ask for it, then call this again.' };
    const already = siteForRef(a.ref);
    const site = await startSite({ ref: a.ref, brief: { business_name: name, what_they_do: '', audience: '', highlights: '', contact: '', style: '', owner_name: text(who.name, 60) }, lang: text(a.language, 12) || 'en', to: who.to });
    if (already) return { ok: true, note: 'A preview already exists for this call. Use addDetails to add what they tell you.', status: site.status };
    const message = who.to
      ? await notify({ to: who.to, template: 'previewReady', vars: [who.name || site.name, site.name, `${site.slug}/preview`], text: `Launchpad: watch your page for ${site.name} being built: ${previewUrl(site.slug)}` })
      : { sent: false, error: 'no phone number (browser rehearsal)' };
    site.previewMessage = message;
    return {
      ok: true,
      preview_link_sent: message.sent,
      preview_address_to_say_aloud: `${spokenAddress(site.slug)} slash preview`,
      note: `${message.sent ? `The preview link was sent to their phone by ${message.channel === 'whatsapp' ? 'WhatsApp' : 'text message'}. Tell them, and ask them to open it.` : 'The message could NOT be sent, so read the address aloud slowly instead.'} The page shows only their name for now and fills in as they tell you more. Carry on with your questions, and call addDetails after every answer.`,
    };
  },

  async addDetails(a) {
    const site = siteForRef(a.ref);
    if (!site) return { ok: false, note: 'No preview exists yet. Ask for the business name and call startPreview first.' };
    const out = await addDetails(site, { what_they_do: a.what_they_do, audience: a.audience, highlights: a.highlights, contact: a.contact, style: a.style });
    if (out.started) return { ok: true, design_started: true, still_unknown: out.missing, note: 'Their page is now being fully designed; it takes about a minute and they can watch it appear in the preview. Tell them that in one sentence. Keep asking about anything still unknown (answers still go to addDetails), then call previewStatus.' };
    if (out.stage === 'collecting') return { ok: true, design_started: false, still_unknown: out.missing, note: `Noted, and it is showing on their preview. The full design starts once you know what they do plus two more of these. Ask next about: ${out.missing[0] ?? 'anything else they want on the page'}.` };
    return { ok: true, design_started: true, still_unknown: out.missing, note: out.queued ? 'Noted. It will be worked into the page as soon as the design in progress finishes.' : 'Noted and added to their page.' };
  },

  async previewStatus(a) {
    const site = siteForRef(a.ref);
    if (!site) return { ok: false, note: 'No preview has been started on this call yet. Call startPreview first.' };
    await settled(site, 9_000);
    if (site.status === 'collecting') {
      // They asked to see it before much was said: design with what there is.
      if (/see|show|build|now|ready/i.test(String(a.reason ?? '')) && site.brief.what_they_do) { designNow(site); return { ok: true, status: 'designing', note: 'The full design has started with what is known so far. It takes about a minute.' }; }
      return { ok: true, status: 'collecting', note: 'The preview shows a simple page with what they have told you so far. The full design starts once addDetails has enough: what they do, plus two of who it is for, highlights, contact details and style.' };
    }
    if (site.status === 'designing') return { ok: true, status: 'designing', now_working_on: site.step ?? 'layout', note: 'Still being designed. Keep chatting for a few seconds, then check again.' };
    if (site.status === 'failed') return { ok: false, status: 'failed', note: 'The page could not be built. Apologise and say the team will follow up.' };
    return {
      ok: true, status: site.status, sections_on_the_page: site.sections,
      note: 'The page is ready in their preview. Briefly tell them what is on it, then ask what they think and whether anything should change.',
    };
  },

  async changeWebsite(a) {
    const site = siteForRef(a.ref);
    if (!site) return { ok: false, note: 'No preview exists yet. Call startPreview first.' };
    const out = await changeSite(site, a.change);
    return out.ok
      ? { ok: true, what_changed: out.summary, note: 'The change is visible in their preview now. Tell them what changed in one sentence and ask if anything else should change.' }
      : { ok: false, note: `${out.summary} Tell them it did not work and ask them to describe it differently.` };
  },

  async switchLanguage(a) {
    const who = callers.get(a.ref) ?? {};
    const said = String(a.language ?? '').trim().toLowerCase();
    const lang = { english: 'en', hindi: 'hi', tamil: 'ta' }[said] ?? said;
    if (!LANGUAGES[lang] || lang === 'en-IN') return { ok: false, note: 'On calls I can speak English, Hindi or Tamil. Tell them that and carry on.' };
    if (!who.to) return { ok: false, note: 'This is a browser rehearsal, where the language cannot be switched. Tell them to start a new rehearsal in that language.' };
    // Give the agent a few seconds to say it is calling back before the line drops.
    setTimeout(() => redialInLanguage({ ref: a.ref, lang, details: text(a.details_so_far, 900) }).catch((err) => console.warn(`call back in ${lang} failed: ${err.message}`)), 7000);
    console.log(`switching ${maskNumber(who.to)} to ${lang}: calling back`);
    return { ok: true, note: `Say exactly this and nothing more: "Sure. I will call you right back in ${LANGUAGES[lang].label}. Please pick up in a few seconds."` };
  },

  async changeImage(a) {
    const site = siteForRef(a.ref);
    if (!site) return { ok: false, note: 'No preview exists yet. Call startPreview first.' };
    const out = await setImage(site, { which: a.which, wish: a.wish });
    return out.ok
      ? { ok: true, what_changed: out.summary, note: 'The picture is showing in their preview now. Say in one sentence what it shows and ask if they like it. If they do not, call changeImage again and a different one is made.' }
      : { ok: false, note: `${out.summary} Tell them, and offer to try once more.` };
  },

  async publishWebsite(a) {
    const site = siteForRef(a.ref);
    if (!site) return { ok: false, note: 'No preview exists yet, so there is nothing to publish.' };
    const out = await publishSite(site);
    if (!out.ok) return { ok: false, note: 'The page is not ready to publish yet. Wait a few seconds and try again.' };
    const who = callers.get(a.ref) ?? {};
    const message = who.to
      ? await notify({ to: who.to, template: 'siteLive', vars: [who.name || site.name, site.name, out.url.replace(/^https?:\/\//, ''), site.slug], text: `Launchpad: your page for ${site.name} is live: ${out.url}` })
      : { sent: false, error: 'no phone number (browser rehearsal)' };
    site.liveMessage = message;
    // The owner's private way into the admin panel, where enquiries from the site arrive.
    if (who.to) site.adminMessage = await notify({ to: who.to, template: 'adminAccess', vars: [who.name || site.name, site.name, `${site.slug}/admin/${site.claimToken}`], text: `Launchpad: see and answer enquiries for ${site.name} here (keep this link private): ${adminUrl(site)}` });
    return {
      ok: true,
      live_link_texted: message.sent,
      admin_link_texted: Boolean(site.adminMessage?.sent),
      live_address_to_say_aloud: spokenAddress(site.slug),
      note: `The site is published. ${message.sent ? `The live link was sent by ${message.channel === 'whatsapp' ? 'WhatsApp' : 'text message'}.` : 'The text could NOT be sent, so read the address aloud slowly.'} ${site.adminMessage?.sent ? 'A second text has a private link to their admin page, where enquiries from visitors arrive; mention it in one sentence.' : ''} Mention that visitors to the site can talk to an AI assistant that knows the business. Congratulate them briefly and end the call politely.`,
    };
  },
};

tools.sendDetailsForm = async (a) => {
  const site = siteForRef(a.ref);
  const who = callers.get(a.ref) ?? {};
  if (!site) return { ok: false, note: 'No website exists yet on this call. Start the preview first.' };
  if (!who.to) return { ok: false, note: 'There is no phone number to send the form to (browser rehearsal).' };
  const missing = text(a.missing, 200) || 'a few details';
  const message = await notify({ to: who.to, template: 'detailsNeeded', vars: [who.name || 'there', site.name, missing, `${site.slug}/details/${site.claimToken}`], text: `Launchpad: to finish the website for ${site.name} we still need ${missing}. Fill in this short form: ${siteUrl(site.slug)}/details?claim=${site.claimToken}` });
  return message.sent
    ? { ok: true, note: `A form was sent to their phone by ${message.channel === 'whatsapp' ? 'WhatsApp' : 'text message'}. Tell them they can fill it in after the call and the site will update by itself.` }
    : { ok: false, note: 'The form could not be sent. Ask for the details on the call instead.' };
};

tools.saveEnquiry = async (a) => {
  const who = callers.get(a.ref) ?? {};
  if (!who.slug) return { ok: false, note: 'This conversation is not linked to a website.' };
  const fields = { name: text(a.name, 80), phone: text(a.phone, 32), summary: text(a.need, 400), lang: text(a.language, 12) };
  let lead = who.leadId ? { id: who.leadId } : who.talkId ? await leadForTalk(who.slug, who.talkId) : null;
  if (lead) await updateLead(who.slug, lead.id, fields);
  else {
    lead = await addLead(who.slug, { ...fields, source: who.talkId ? 'voice' : 'call', talkId: who.talkId ?? null });
    const owner = await getSite(who.slug);
    if (owner?.to) notify({ to: owner.to, template: 'newEnquiry', vars: [owner.name, fields.name || 'A visitor', fields.summary || 'They would like to be contacted.', `${owner.slug}/admin/${owner.claimToken}`], text: `Launchpad: new enquiry for ${owner.name} from ${fields.name || 'a visitor'}: ${fields.summary}. See it: ${adminUrl(owner)}` }).catch(() => {});
  }
  return { ok: true, note: 'Saved. Tell them the owner will get back to them, and ask if there is anything else.' };
};

export const TOOL_NAMES = Object.keys(tools);

// ---------------------------------------------------- the public front page ----

const requests = new Map(); // ip -> [timestamps]
const allowRequest = (ip) => {
  const now = Date.now();
  const hits = (requests.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  if (hits.length >= 4) return false;
  hits.push(now); requests.set(ip, hits);
  return true;
};
const toE164 = (raw) => {
  const digits = String(raw ?? '').replace(/[^\d+]/g, '');
  if (E164.test(digits)) return digits;
  return /^\d{10}$/.test(digits) ? `+91${digits}` : null;
};

/** Someone on the front page asked to be called. */
const requestCall = async (req, body) => {
  const name = text(body.name, 60);
  const to = toE164(body.phone);
  const lang = LANGUAGES[body.lang] ? body.lang : 'en';
  if (!name) return [400, { error: 'Please tell us your name.', field: 'name' }];
  if (!to) return [400, { error: 'Enter your number with its country code, for example +91 98765 43210.', field: 'phone' }];
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
  if (!allowRequest(ip)) return [429, { error: 'That is several requests in a few minutes. Please wait a little and try again.' }];
  const enabled = isAllowed(to); // only numbers the operator enabled in the console
  if (!enabled) {
    // Not a number we may dial in this demo: keep the request so someone can follow up.
    await mkdir(env.sitesDir, { recursive: true }).catch(() => {});
    await appendFile(join(env.sitesDir, '_call-requests.jsonl'), `${JSON.stringify({ at: Date.now(), name, to, lang, business: text(body.business, 120) })}\n`).catch(() => {});
    return [200, { ok: true, calling: false, message: 'Thank you. During this demo we only phone numbers that have been enabled for it, so we have saved your request and will be in touch.' }];
  }
  try {
    await startCall({ to, name, lang, business: text(body.business, 120) }); // not trusted: the list applies
    return [200, { ok: true, calling: true, message: 'Your phone will ring in a few seconds.' }];
  } catch (err) {
    if (err.status === 429) return [429, { error: 'We are on another call right now. Please try again in a few minutes.' }];
    console.warn(`request-call failed: ${err.message}`);
    return [502, { error: 'We could not place the call just now. Please try again shortly.' }];
  }
};

// ---------------------------------------------------------- preview shell ----

const shell = (site, base) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Preview: ${esc(site.name)}</title>
<style>
  html, body { height: 100%; margin: 0; background: #0e1517; color: #e6eeee; font: 500 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; }
  #bar { position: fixed; inset: 0 0 auto 0; height: calc(42px + env(safe-area-inset-top, 0px)); padding: env(safe-area-inset-top, 0px) 12px 0; display: flex; align-items: center; gap: 9px; background: #0e1517; border-bottom: 1px solid #22323a; z-index: 5; }
  #dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #f2b53c; }
  #dot[data-s="designing"], #dot[data-s="revising"] { animation: pulse 1s ease-in-out infinite; }
  #dot[data-s="ready"] { background: #57c98a; }
  #dot[data-s="published"] { background: #4fb3ff; }
  #dot[data-s="failed"] { background: #ef6b5b; }
  #msg { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #msg a { color: #8fd0ff; }
  #tag { margin-left: auto; flex: none; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #8aa0a6; }
  #stage { position: fixed; inset: calc(42px + env(safe-area-inset-top, 0px)) 0 0 0; background: #fff; }
  #stage iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; opacity: 0; transition: opacity .5s ease; }
  #stage iframe.on { opacity: 1; }
  #veil { position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity .3s ease; background: linear-gradient(100deg, transparent 30%, rgba(255,255,255,.55) 50%, transparent 70%) 0 0 / 250% 100%; z-index: 3; }
  #veil.on { opacity: 1; animation: sweep 1.3s linear infinite; }
  #pill { position: fixed; left: 50%; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); transform: translate(-50%, 20px); max-width: min(92vw, 520px); padding: 10px 16px; border-radius: 999px; background: #0e1517; color: #e6eeee; box-shadow: 0 8px 30px rgba(0,0,0,.35); opacity: 0; transition: opacity .25s ease, transform .25s ease; z-index: 6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #pill.on { opacity: 1; transform: translate(-50%, 0); }
  @keyframes pulse { 50% { opacity: .35; transform: scale(.8); } }
  @keyframes sweep { to { background-position: -250% 0; } }
  @media (prefers-reduced-motion: reduce) { #stage iframe, #pill, #veil { transition: none; animation: none !important; } }
</style>
</head>
<body>
<div id="bar" role="status" aria-live="polite"><span id="dot" data-s="${esc(site.status)}"></span><span id="msg">Connecting…</span><span id="tag">Live preview</span></div>
<div id="stage"><div id="veil"></div></div>
<div id="pill"></div>
<script>
(() => {
  const base = ${JSON.stringify(base)};
  const stage = document.getElementById('stage'), veil = document.getElementById('veil');
  const dot = document.getElementById('dot'), msg = document.getElementById('msg'), pill = document.getElementById('pill');
  let current = null;        // the iframe on screen
  let stream = null;         // { frame, doc } while the page is being written live
  let hadPage = false;       // a finished version has been shown at least once
  let follow = true;         // keep the newest content in view until the person scrolls
  let pillTimer = 0;

  const say = (text, link) => { msg.textContent = text; if (link) { const a = document.createElement('a'); a.href = link; a.textContent = link.replace(/^https?:\\/\\//, ''); msg.append(' ', a); } };
  const showPill = (text, ms) => { clearTimeout(pillTimer); pill.textContent = text; pill.classList.add('on'); if (ms) pillTimer = setTimeout(() => pill.classList.remove('on'), ms); };
  const hidePill = () => { clearTimeout(pillTimer); pill.classList.remove('on'); };

  const newFrame = () => { const f = document.createElement('iframe'); f.title = 'Your page'; stage.insertBefore(f, veil); return f; };
  const show = (f) => {
    const old = current; current = f;
    requestAnimationFrame(() => f.classList.add('on'));
    if (old && old !== f) { old.classList.remove('on'); setTimeout(() => old.remove(), 650); }
  };
  const watchScroll = (f) => { try { for (const ev of ['wheel', 'touchstart', 'keydown']) f.contentWindow.addEventListener(ev, () => { follow = false; }, { passive: true }); } catch {} };

  // Live writing: the document arrives in pieces and the browser renders it as it comes.
  const write = (text) => {
    if (!stream) { const f = newFrame(); const doc = f.contentDocument; doc.open(); stream = { frame: f, doc }; follow = true; show(f); watchScroll(f); }
    try { stream.doc.write(text); } catch {}
    if (!stream.calm && stream.doc.head) { try { const st = stream.doc.createElement('style'); st.textContent = '[data-header], header { position: static !important; }'; stream.doc.head.append(st); stream.calm = true; } catch {} }
    if (follow) { try { const el = stream.doc.scrollingElement || stream.doc.documentElement; stream.frame.contentWindow.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); } catch {} }
  };
  const endStream = () => { if (stream) { try { stream.doc.close(); } catch {} stream = null; } };

  const photos = (doc) => { try { return [...doc.querySelectorAll('img')]; } catch { return []; } };
  const leafText = (doc) => { const out = []; try { doc.querySelectorAll('h1,h2,h3,h4,p,li,a,button,blockquote,figcaption,dt,dd').forEach((el) => { const t = el.textContent.replace(/\\s+/g, ' ').trim(); if (t) out.push([el, t]); }); } catch {} return out; };

  // Swap in a finished version, keeping the reader's place and pointing out what changed.
  const load = (version, highlight) => {
    const before = current && highlight ? new Set(leafText(current.contentDocument).map((x) => x[1])) : null;
    const photosBefore = current && highlight ? new Set(photos(current.contentDocument).map((i) => i.currentSrc || i.src)) : null;
    let y = 0; try { y = current ? current.contentWindow.scrollY : 0; } catch {}
    const f = newFrame();
    f.addEventListener('load', () => {
      endStream();
      try { f.contentWindow.scrollTo(0, hadPage || y ? y : 0); } catch {}
      if (before && before.size) {
        const now = leafText(f.contentDocument);
        const swapped = photosBefore ? photos(f.contentDocument).filter((i) => !photosBefore.has(i.currentSrc || i.src)) : [];
        const changed = swapped.concat(now.filter((x) => !before.has(x[1])).map((x) => x[0]).filter((el, i, all) => !all.some((o) => o !== el && o.contains(el))));
        if (changed.length && changed.length <= Math.max(14, now.length * 0.6) + swapped.length) {
          const st = f.contentDocument.createElement('style');
          st.textContent = '@keyframes lpflash{0%,35%{outline:3px solid rgba(255,186,0,.95);outline-offset:5px;background-color:rgba(255,196,0,.20)}100%{outline:3px solid rgba(255,186,0,0);outline-offset:5px;background-color:transparent}}.lp-changed{animation:lpflash 2.8s ease-out 1;border-radius:6px}';
          f.contentDocument.head.append(st);
          changed.slice(0, 14).forEach((el) => el.classList.add('lp-changed'));
          try { changed[0].scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
        }
      }
      show(f); watchScroll(f); hadPage = true; veil.classList.remove('on');
    }, { once: true });
    f.src = base + '/preview/frame?v=' + version;
  };

  const status = (e) => {
    dot.dataset.s = e.status;
    if (e.status === 'collecting') say('Getting to know your business · this page fills in as you talk');
    else if (e.status === 'designing') say('Designing your page' + (e.step ? ' · ' + e.step : '…'));
    else if (e.status === 'revising') say('Updating' + (e.step ? ' · ' + e.step : '…'));
    else if (e.status === 'published') say('Published ·', ${JSON.stringify(siteUrl(site.slug))});
    else if (e.status === 'failed') say('Something went wrong building this page.');
    else say('Preview · say on the call what you would like changed');
  };

  const connect = () => {
    const es = new EventSource(base + '/preview/events');
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === 'hello') {
        status(e);
        if (e.partial) { endStream(); write(e.partial); }
        else if (!stream) load(e.version, false);
      } else if (e.type === 'chunk') write(e.text);
      else if (e.type === 'step') { status(e); showPill('Building: ' + e.step, 2600); }
      else if (e.type === 'state') status(e);
      else if (e.type === 'reset') { endStream(); load(e.version, false); }
      else if (e.type === 'working') { veil.classList.add('on'); showPill('Changing: ' + e.label); }
      else if (e.type === 'failed') { veil.classList.remove('on'); showPill('That change did not go through', 3500); }
      else if (e.type === 'reload') { hidePill(); load(e.version, hadPage && !stream); if (hadPage) showPill('Updated', 2200); else showPill('Your page is ready', 2600); }
      else if (e.type === 'published') { status(e); showPill('Published. Your site is live.', 5000); }
    };
    es.onerror = () => { say('Reconnecting…'); };
  };
  connect();
})();
</script>
</body>
</html>`;

// ------------------------------------------------------------ site routes ----

const serveSite = async (req, res, slug, path, base, url) => {
  const site = await getSite(slug);
  if (!site) return html(res, 404, '<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font:16px system-ui;padding:40px">There is no page at this address.</p>');
  if (await handleSiteKit({ req, res, site, path, url, register: registerCaller })) return undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });

  if (path === '/' || path === '') {
    if (site.publishedHtml) return html(res, 200, withWidget(site.publishedHtml), { 'cache-control': 'no-cache' });
    res.writeHead(302, { location: `${base}/preview`, 'cache-control': 'no-store' });
    return res.end();
  }
  if (path === '/preview') return html(res, 200, shell(site, base), { 'x-robots-tag': 'noindex' });
  if (path === '/preview/frame') return html(res, 200, site.html ?? renderPending({ name: site.name }), { 'x-robots-tag': 'noindex' });
  if (path === '/preview/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: 'hello', status: site.status, version: site.version, step: site.step, partial: site.status === 'designing' ? site.partial : '' });
    const off = follow(site, send);
    const beat = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => { off(); clearInterval(beat); });
    return undefined;
  }
  return html(res, 404, '<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font:16px system-ui;padding:40px">Nothing here.</p>');
};

const slugFromHost = (host) => {
  const h = String(host ?? '').split(':')[0].toLowerCase();
  if (!env.publicHost || !h.endsWith(`.${env.publicHost}`)) return null;
  const label = h.slice(0, -env.publicHost.length - 1);
  return label.includes('.') ? null : label;
};

export const startPublicServer = () => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      // 1. A site on its own subdomain.
      const hostSlug = slugFromHost(req.headers.host);
      if (hostSlug && hostSlug !== 'console') return await serveSite(req, res, hostSlug, url.pathname.replace(/\/+$/, '') || '/', '', url);

      // The health companion app's public endpoints (base host only).
      if (await carePublic(req, res, url)) return undefined;

      // 2. Path-based sites, for local development without a wildcard domain.
      const m = url.pathname.match(/^\/s\/([a-z0-9-]+)(\/.*)?$/);
      if (m) return await serveSite(req, res, m[1], (m[2] ?? '/').replace(/\/+$/, '') || '/', `/s/${m[1]}`, url);

      // 3. Caddy asks before requesting a certificate for a hostname.
      if (url.pathname === '/internal/tls-ask') {
        const domain = String(url.searchParams.get('domain') ?? '').toLowerCase();
        const slug = slugFromHost(domain);
        const ok = domain === env.publicHost || domain === `console.${env.publicHost}` || (slug && Boolean(await getSite(slug)));
        res.writeHead(ok ? 200 : 404).end();
        return undefined;
      }

      // Agora's notifications about sessions and phone calls (answered, ended and why, transcripts).
      if (url.pathname === '/hooks/agora') {
        if (req.method !== 'POST') return json(res, 200, { ok: true });
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 2_000_000) return json(res, 413, { ok: false }); chunks.push(chunk); }
        const raw = Buffer.concat(chunks);
        if (!signatureOk(raw, req.headers)) return json(res, 401, { ok: false });
        try { await recordEvent(JSON.parse(raw.toString() || '{}')); } catch { /* a malformed notification is ignored */ }
        return json(res, 200, { ok: true });
      }

      // 4. Tools, called by Agora during a call.
      const tool = url.pathname.match(/^\/tools\/([A-Za-z]+)$/);
      if (tool) {
        if (req.method !== 'POST') return json(res, 405, { ok: false, note: 'Use POST.' });
        if (!authorised(req)) return json(res, 401, { ok: false, note: 'Not authorised.' });
        const run = tools[tool[1]];
        if (!run) return json(res, 404, { ok: false, note: 'Unknown tool.' });
        const args = await readBody(req);
        if (args.ref && !callers.has(args.ref)) {
          // The server restarted during this conversation: pick its site back up from disk.
          const known = await recoverRef(args.ref);
          if (known) registerCaller(args.ref, { to: known.to ?? null, name: known.brief?.owner_name ?? null });
        }
        if (!args.ref || !callers.has(args.ref)) return json(res, 400, { ok: false, note: 'Unknown call.' });
        const started = Date.now();
        const out = await run(args);
        console.log(`tool ${tool[1]} for ${maskNumber(callers.get(args.ref).to) ?? 'rehearsal'} -> ${out.ok ? 'ok' : 'not ok'} in ${Date.now() - started} ms`);
        return json(res, 200, out);
      }

      // 5. Google sign-in, hosted once here for every site (Google does not allow wildcard origins).
      if (url.pathname === '/auth/google' && req.method === 'GET') {
        if (!googleReady()) return html(res, 503, '<!doctype html><meta charset="utf-8"><title>Sign-in unavailable</title><p style="font:16px system-ui;padding:40px">Google sign-in is not set up on this server yet.</p>');
        const purpose = url.searchParams.get('purpose') === 'visitor' ? 'visitor' : 'admin';
        const state = { purpose, site: url.searchParams.get('site') ?? '', claim: url.searchParams.get('claim') ?? '', back: url.searchParams.get('return') ?? '' };
        const target = purpose === 'admin' ? await getSite(state.site) : null;
        if (purpose === 'admin' && !target) return html(res, 404, '<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font:16px system-ui;padding:40px">That site does not exist.</p>');
        return html(res, 200, signInPage({ title: purpose === 'admin' ? `Manage ${target.name}` : 'Share your contact details', state }), { 'referrer-policy': 'no-referrer' });
      }
      if (url.pathname === '/auth/google/verify' && req.method === 'POST') {
        const { credential, state = {} } = await readBody(req);
        let user;
        try { user = await verifyGoogleCredential(credential); } catch (err) { return json(res, 401, { error: err.message }); }
        if (state.purpose === 'visitor') {
          let back;
          try { back = new URL(String(state.back)); } catch { return json(res, 400, { error: 'Nowhere to return to.' }); }
          if (!env.publicHost || !back.hostname.endsWith(`.${env.publicHost}`)) return json(res, 400, { error: 'That return address is not one of our sites.' });
          back.hash = `lp_visitor=${Buffer.from(JSON.stringify({ name: user.name, email: user.email })).toString('base64url')}`;
          return json(res, 200, { redirect: back.toString() });
        }
        const target = await getSite(String(state.site ?? ''));
        if (!target) return json(res, 404, { error: 'That site does not exist.' });
        const code = sign('handoff', { slug: target.slug, email: user.email, name: user.name, claim: String(state.claim ?? '') }, 90);
        return json(res, 200, { redirect: `${siteUrl(target.slug)}/admin/session?code=${encodeURIComponent(code)}` });
      }

      // 6. Button links from WhatsApp templates: one fixed domain, redirecting to the right site.
      const go = url.pathname.match(/^\/go\/([a-z0-9-]+)(?:\/(preview|admin|details|callme))?(?:\/([A-Za-z0-9_-]{6,64}))?\/?$/);
      if (go) {
        const target = await getSite(go[1]);
        if (!target) return html(res, 404, '<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font:16px system-ui;padding:40px">This link is no longer valid.</p>');
        const where = go[2] === 'preview' ? '/preview' : go[2] ? `/${go[2]}${go[3] ? `?claim=${go[3]}` : ''}` : '/';
        res.writeHead(302, { location: `${siteUrl(target.slug)}${where}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return res.end();
      }

      if (url.pathname === '/healthz') return json(res, 200, { ok: true });
      if (url.pathname === '/api/request-call' && req.method === 'POST') { const [status, out] = await requestCall(req, await readBody(req)); return json(res, status, out); }
      if (url.pathname === '/api/showcase' && req.method === 'GET') {
        return json(res, 200, { sites: await publishedSites(6), languages: Object.entries(LANGUAGES).filter(([code]) => code !== 'en-IN').map(([code, l]) => ({ code, label: l.label })) });
      }
      if (url.pathname === '/') {
        const page = await readFile(join(root, 'site-kit', 'landing', 'index.html')).catch(() => null);
        if (page) return html(res, 200, page, { 'cache-control': 'no-cache' });
      }
      if (url.pathname === '/') return html(res, 200, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Launchpad</title><body style="font:17px/1.5 system-ui;max-width:34rem;margin:18vh auto;padding:0 20px"><h1 style="font-size:28px">Launchpad</h1><p>A website for your business, built on a phone call.</p>');
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error(`public ${req.method} ${url.pathname}: ${err.message}`);
      if (!res.headersSent) json(res, err.status ?? 500, { ok: false, note: 'The request failed.' });
      else res.end();
      return undefined;
    }
  });
  server.listen(env.publicPort, env.bindHost, () => console.log(`Public listener on http://${env.bindHost}:${env.publicPort}${env.publicUrl ? ` (served as ${env.publicUrl})` : ''}`));
  return server;
};

export const sitesSummary = async (ref) => publicView(siteForRef(ref));
