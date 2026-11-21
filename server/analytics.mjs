// Visitor statistics for every published site, shown on the owner's dashboard.
//
// Storage is one append-only file per site (sites/<slug>/events.jsonl, one JSON object per line)
// mirrored in memory; the mirror is rebuilt from the file the first time a site is asked about
// after a restart. Nothing here may break page serving: record() never throws or rejects, and a
// failed write costs a line in the log, not a request.
//
// Privacy: first-party only, no cookies, no IP address or user agent is ever written. A visitor
// is a random id their browser made up for this one site (v), a session is that id plus thirty
// quiet minutes (s), a page load is p. Enquiries are NOT stored here: they are counted from the
// lead store (crm.mjs), so the dashboard's numbers and its leads list cannot disagree.
//
// One line:  { t, e, v?, s?, p?, ... }  with e one of
//   view      ref (referrer host), utm, dev (mobile|tablet|desktop), lang      from the page
//   engaged   stayed ten seconds or scrolled past half the page                from the page
//   leave     sec (time on page so far; the largest per page load wins)        from the page
//   sections  l (labels of sections scrolled into view)                        from the page
//   click     kind (call|whatsapp|email|map|other), label                      from the page
//   open      the assistant was opened                                         from the page
//   talk_start  k (talk id), lang      talk_end  k, sec                        from the server
import { appendFile, mkdir, open } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { siteDir } from './sites.mjs';
import { listLeads } from './crm.mjs';

export const TIMEZONE = 'Asia/Kolkata';
const IST = 5.5 * 3600_000; // India has no daylight saving, so a fixed offset is exact
const DAY = 86_400_000;
const RETAIN_DAYS = 185;    // the longest report is 90 days plus the 90 before it
const MAX_IN_MEMORY = 300_000;
const MAX_PER_DAY = 5_000;  // page events one site may add in a day; a flood cannot fill the disk
const PER_VISITOR = 60;     // events a minute
const PER_ADDRESS = 300;    // events a minute from one network address (a shop's wifi is many people)
const MAX_BATCH = 12;
const MAX_SECONDS = 30 * 60;

const CONTACT = ['call', 'whatsapp', 'email', 'map'];
const KINDS = [...CONTACT, 'other'];
const DEVICES = ['mobile', 'tablet', 'desktop'];
const ID = /^[A-Za-z0-9_-]{8,32}$/;

const file = (slug) => join(siteDir(slug), 'events.jsonl');
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const dayIndex = (ts) => Math.floor((ts + IST) / DAY);
const dateOf = (index) => new Date(index * DAY).toISOString().slice(0, 10);
const hourOf = (ts) => new Date(ts + IST).getUTCHours();

// ------------------------------------------------------------------ store ----

/** slug -> { events, ready, writing, day, dayCount, warned } */
const cache = new Map();

const load = (slug) => {
  let entry = cache.get(slug);
  if (entry) return entry.ready;
  entry = { events: [], ready: null, writing: Promise.resolve(), made: false, day: dayIndex(Date.now()), dayCount: 0, warned: false };
  entry.ready = (async () => {
    try {
      if (!existsSync(file(slug))) return entry;
      const oldest = Date.now() - RETAIN_DAYS * DAY;
      for await (const line of createInterface({ input: createReadStream(file(slug), 'utf8'), crlfDelay: Infinity })) {
        if (!line) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; } // a torn last line after a crash is skipped
        if (!e || typeof e.t !== 'number' || typeof e.e !== 'string' || e.t < oldest) continue;
        entry.events.push(e);
        if (dayIndex(e.t) === entry.day && !e.e.startsWith('talk_')) entry.dayCount += 1;
      }
      if (entry.events.length > MAX_IN_MEMORY) entry.events.splice(0, entry.events.length - MAX_IN_MEMORY);
    } catch (err) {
      console.warn(`analytics load ${slug}: ${err.message}`); // carry on with what was read
    }
    return entry;
  })();
  cache.set(slug, entry);
  return entry.ready;
};

// A crash mid-write can leave half a line at the end of the file. The first write after a start
// begins on a fresh line then, so the half line costs one event and not the next one too.
const tornTail = async (path) => {
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    if (!size) return '';
    const { buffer } = await handle.read(Buffer.alloc(1), 0, 1, size - 1);
    return buffer[0] === 0x0a ? '' : '\n';
  } catch {
    return ''; // no file yet
  } finally {
    await handle?.close().catch(() => {});
  }
};

/**
 * Add events to a site's log. Safe to call without awaiting: it never throws and never rejects.
 * Each event gets the time it arrived unless it brings its own `t` (used by tests and imports).
 */
export const record = (slug, ...events) => load(slug).then((entry) => {
  const now = Date.now();
  const rows = events.filter(Boolean).map((e) => ({ t: now, ...e }));
  if (!rows.length) return undefined;
  entry.events.push(...rows);
  if (entry.events.length > MAX_IN_MEMORY) entry.events.splice(0, entry.events.length - MAX_IN_MEMORY);
  const lines = rows.map((e) => `${JSON.stringify(e)}\n`).join('');
  entry.writing = entry.writing.then(async () => {
    let mend = '';
    if (!entry.made) {
      await mkdir(siteDir(slug), { recursive: true });
      mend = await tornTail(file(slug));
      entry.made = true;
    }
    await appendFile(file(slug), mend + lines);
  }).catch((err) => {
    if (!entry.warned) console.warn(`analytics write ${slug}: ${err.message}`); // say it once, not per visitor
    entry.warned = true;
  });
  return entry.writing;
}).catch(() => undefined);

// ---------------------------------------------------- the public endpoint ----
// POST /_lp/api/event takes { v, s, p, ev: [ { e, ... } ] } from anyone, so everything is
// checked, cut to size and rate limited before it is kept.

const SALT = randomBytes(16); // address keys live in memory only and change on every restart
const windows = new Map();    // key -> { from, n }
const allow = (key, n, limit) => {
  const now = Date.now();
  let w = windows.get(key);
  if (!w || now - w.from >= 60_000) { w = { from: now, n: 0 }; windows.set(key, w); }
  if (w.n + n > limit) return false;
  w.n += n;
  return true;
};
setInterval(() => { const now = Date.now(); for (const [key, w] of windows) if (now - w.from >= 60_000) windows.delete(key); }, 5 * 60_000).unref();

const bad = (error) => ({ status: 400, error });

const SHAPES = {
  view: (d) => {
    if (!DEVICES.includes(d.dev)) return null;
    const ref = String(d.ref ?? '').toLowerCase();
    const utm = String(d.utm ?? '').toLowerCase();
    const lang = String(d.lang ?? '').toLowerCase();
    return {
      dev: d.dev,
      ...(/^[a-z0-9.-]{1,80}$/.test(ref) && { ref }),
      ...(/^[a-z0-9._-]{1,40}$/.test(utm) && { utm }),
      ...(/^[a-z]{2,3}(-[a-z0-9]{2,8}){0,2}$/.test(lang) && { lang }),
    };
  },
  engaged: () => ({}),
  open: () => ({}),
  leave: (d) => (typeof d.sec === 'number' && Number.isFinite(d.sec) && d.sec >= 0 ? { sec: Math.min(MAX_SECONDS, Math.round(d.sec)) } : null),
  sections: (d) => {
    if (!Array.isArray(d.l)) return null;
    const l = [...new Set(d.l.slice(0, 12).map((label) => clean(label, 60)).filter(Boolean))];
    return l.length ? { l } : null;
  },
  click: (d) => (KINDS.includes(d.kind) ? { kind: d.kind, label: clean(d.label, 60) || { call: 'Call', whatsapp: 'WhatsApp', email: 'Email', map: 'Map', other: 'Button' }[d.kind] } : null),
};

/**
 * Check and keep one batch from a page. Returns { status, error? }. With `dryRun` the batch is
 * checked and then dropped (the owner's own visits, crawlers): the answer is the same either way.
 */
export const acceptEvents = async (slug, body, { address = '', dryRun = false } = {}) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('The body must be a JSON object.');
  const { v, s, p, ev } = body;
  if (!ID.test(v ?? '') || !ID.test(s ?? '') || !ID.test(p ?? '')) return bad('Missing or malformed ids.');
  if (!Array.isArray(ev) || !ev.length || ev.length > MAX_BATCH) return bad(`Send between 1 and ${MAX_BATCH} events.`);
  const rows = [];
  for (const d of ev) {
    const shape = d && typeof d === 'object' && Object.hasOwn(SHAPES, d.e) ? SHAPES[d.e] : null;
    if (!shape) return bad('Unknown event type.');
    const fields = shape(d);
    if (!fields) return bad(`Malformed ${d.e} event.`);
    rows.push({ e: d.e, v, s, p, ...fields });
  }
  if (dryRun) return { status: 200 };
  const slow = { status: 429, error: 'Too many events. Slow down.' };
  if (!allow(`v:${slug}:${v}`, rows.length, PER_VISITOR)) return slow;
  if (address && !allow(`a:${createHash('sha256').update(SALT).update(address).digest('base64url').slice(0, 16)}`, rows.length, PER_ADDRESS)) return slow;
  const entry = await load(slug);
  const today = dayIndex(Date.now());
  if (entry.day !== today) { entry.day = today; entry.dayCount = 0; }
  if (entry.dayCount + rows.length > MAX_PER_DAY) return slow;
  entry.dayCount += rows.length;
  record(slug, ...rows);
  return { status: 200 };
};

// ------------------------------------------------------------------ talks ----
// Counted here, on the server, so a blocked script cannot hide a conversation. The browser says
// when a talk ends; if it never does (tab killed, signal lost) the books are closed from the last
// transcript line that arrived.

const liveTalks = new Map(); // talkId -> { slug, startedAt, lastSeen, max, timer }

export const talkStarted = (slug, { talkId, v, lang, maxSeconds = 240 }) => {
  if (!talkId || liveTalks.has(talkId)) return;
  const now = Date.now();
  const talk = { slug, startedAt: now, lastSeen: now, max: maxSeconds };
  talk.timer = setTimeout(() => talkEnded(slug, talkId, undefined, { lost: true }), (maxSeconds + 30) * 1000);
  talk.timer.unref();
  liveTalks.set(talkId, talk);
  record(slug, { e: 'talk_start', k: talkId, ...(ID.test(v ?? '') && { v }), lang: clean(lang, 12) || 'en' });
};

export const talkAlive = (talkId) => { const talk = liveTalks.get(talkId); if (talk) talk.lastSeen = Date.now(); };

/** `seconds` is what the browser says it was live for; it can only shorten what the server saw. */
export const talkEnded = (slug, talkId, seconds, { lost = false } = {}) => {
  const talk = liveTalks.get(talkId);
  if (!talk || talk.slug !== slug) return; // unknown, another site's, or already closed
  liveTalks.delete(talkId);
  clearTimeout(talk.timer);
  let sec = ((lost ? talk.lastSeen : Date.now()) - talk.startedAt) / 1000;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) sec = Math.min(sec, seconds);
  record(slug, { e: 'talk_end', k: talkId, sec: Math.max(0, Math.min(talk.max, Math.round(sec))) });
};

// ----------------------------------------------------------------- report ----

const decode = (s) => String(s).replace(/&(amp|lt|gt|quot|apos|nbsp|#39|#x27|#(\d+)|#x([0-9a-f]+));/gi, (m, name, dec, hex) => {
  if (dec || hex) { const code = parseInt(dec ?? hex, dec ? 10 : 16); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''; }
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" }[name.toLowerCase()] ?? m;
});
const attr = (tag, name) => { const m = new RegExp(`(?<![\\w-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag); return m ? decode(m[1] ?? m[2]) : ''; };
const norm = (label) => String(label).replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The sections of a published page in reading order: the `<!-- section: Label -->` markers the
 * designer writes, or (template pages have none) each <section>'s aria-label, first heading or
 * id. site-kit/track.js finds the same labels in the browser.
 */
export const pageSections = (html) => {
  const doc = String(html ?? '');
  let labels = [...doc.matchAll(/<!--\s*section:\s*([^\n]*?)\s*-->/gi)].map((m) => clean(decode(m[1]), 60));
  if (!labels.filter(Boolean).length) {
    labels = [...doc.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section\s*>/gi)].map(([, attrs, inner]) =>
      clean(attr(attrs, 'aria-label') || decode((/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(inner)?.[1] ?? '').replace(/<[^>]*>/g, ' ')) || attr(attrs, 'id'), 60));
  }
  const seen = new Set();
  return labels.filter((label) => label && !seen.has(norm(label)) && seen.add(norm(label)));
};

/** Referrer host (or utm_source) to the name an owner would use. */
export const sourceName = (ref = '', utm = '') => {
  const s = String(utm || ref).toLowerCase();
  if (!s) return 'Direct';
  if (/whatsapp|(^|\.)wa\.me$/.test(s)) return 'WhatsApp';
  if (/instagram|(^|\.)ig\.me$|^ig$/.test(s)) return 'Instagram';
  if (/facebook|messenger|(^|\.)fb\.(com|me)$|^fb$/.test(s)) return 'Facebook';
  if (/(^|\.)google\.|^com\.google\.|^google$/.test(s)) return 'Google'; // includes android-app packages
  return s.replace(/^www\./, '');
};

const LANGUAGE = { en: 'English', hi: 'Hindi', ta: 'Tamil' };
const ON_DEVICE = { mobile: 'on a phone', tablet: 'on a tablet', desktop: 'on a computer' };
const duration = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)} min${sec % 60 ? ` ${sec % 60} s` : ''}` : `${sec} s`);
const rate = (part, whole) => (whole > 0 ? Math.min(1, Math.round((part / whole) * 10_000) / 10_000) : 0);

/** Everything about one period [from, to): the totals, and the breakdowns the current period shows. */
const tally = (events, leads, ends, from, to) => {
  const firstDay = dayIndex(from);
  const days = Array.from({ length: Math.round((to - from) / DAY) }, () => ({ views: 0, visitors: new Set(), engaged: new Set(), talks: 0, enquiries: 0 }));
  const visitors = new Set(); const engaged = new Set(); const reached = new Set();
  const pages = new Map();     // page load -> seconds
  const sections = new Map();  // label -> page loads that saw it
  const clicks = new Map();    // kind|label -> count
  const sources = new Map();   // name -> visitors
  const devices = { mobile: new Set(), desktop: new Set(), tablet: new Set() };
  const hourly = new Set();    // visitor|day|hour
  const hours = Array(24).fill(0);
  const languages = new Map(); // lang -> talks
  const sessions = new Set();  // sessions already in the feed
  const recent = [];
  let views = 0; let contactClicks = 0; let assistantOpens = 0; let talks = 0; let talkSeconds = 0; let unknownTalkers = 0;

  for (const e of events) {
    if (e.t < from || e.t >= to) continue;
    const day = days[dayIndex(e.t) - firstDay];
    if (!day) continue;
    if (e.e === 'view') {
      views += 1; day.views += 1;
      visitors.add(e.v); day.visitors.add(e.v);
      const source = sourceName(e.ref, e.utm);
      if (!sources.has(source)) sources.set(source, new Set());
      sources.get(source).add(e.v);
      devices[e.dev]?.add(e.v);
      const slot = `${e.v}|${dayIndex(e.t)}|${hourOf(e.t)}`;
      if (!hourly.has(slot)) { hourly.add(slot); hours[hourOf(e.t)] += 1; }
      if (!sessions.has(e.s ?? e.p)) { // one line per visit, not per reload
        sessions.add(e.s ?? e.p);
        recent.push({ at: e.t, type: 'view', text: `Someone visited${source === 'Direct' ? '' : ` from ${source}`} ${ON_DEVICE[e.dev] ?? 'on a computer'}` });
      }
    } else if (e.e === 'engaged') {
      engaged.add(e.v); day.engaged.add(e.v);
    } else if (e.e === 'leave') {
      pages.set(e.p, Math.max(pages.get(e.p) ?? 0, Number(e.sec) || 0));
    } else if (e.e === 'sections') {
      for (const label of e.l ?? []) {
        const key = norm(label);
        if (!sections.has(key)) sections.set(key, new Set());
        sections.get(key).add(e.p);
      }
    } else if (e.e === 'click') {
      const key = `${e.kind}|${e.label}`;
      clicks.set(key, (clicks.get(key) ?? 0) + 1);
      if (!CONTACT.includes(e.kind)) continue;
      contactClicks += 1;
      if (e.kind !== 'map') reached.add(e.v); // looking up the way is interest, not yet reaching out
      recent.push({ at: e.t, type: 'click', text: `Someone tapped ${{ call: 'to call', whatsapp: 'the WhatsApp button', email: 'to send an email', map: 'the map link' }[e.kind]}` });
    } else if (e.e === 'open') {
      assistantOpens += 1;
      reached.add(e.v);
    } else if (e.e === 'talk_start') {
      const sec = ends.get(e.k);
      if (sec !== undefined && sec < 1) continue; // the assistant was asked for but the call never connected
      talks += 1; day.talks += 1; talkSeconds += sec ?? 0;
      languages.set(e.lang, (languages.get(e.lang) ?? 0) + 1);
      if (e.v) reached.add(e.v); else unknownTalkers += 1;
      recent.push({ at: e.t, type: 'talk', text: `Someone talked to the assistant${sec ? ` for ${duration(sec)}` : ''}${LANGUAGE[e.lang] ? ` in ${LANGUAGE[e.lang]}` : ''}` });
    }
  }

  let enquiries = 0;
  for (const lead of leads) {
    if (!(lead.createdAt >= from && lead.createdAt < to)) continue;
    enquiries += 1;
    const day = days[dayIndex(lead.createdAt) - firstDay];
    if (day) day.enquiries += 1;
    recent.push({ at: lead.createdAt, type: 'enquiry', text: { voice: 'Someone left an enquiry while talking to the assistant', call: 'An enquiry came in on a phone call' }[lead.source] ?? 'Someone sent a written enquiry' });
  }

  // "Engaged" only counts people who are also counted as visitors, so the rate cannot pass 1.
  const engagedCount = [...engaged].filter((v) => visitors.has(v)).length;
  const timed = [...pages.values()];
  return {
    totals: {
      views, visitors: visitors.size, engaged: engagedCount, engagementRate: rate(engagedCount, visitors.size),
      avgSeconds: timed.length ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : 0,
      contactClicks, assistantOpens, talks, talkSeconds, enquiries, conversionRate: rate(enquiries, visitors.size),
    },
    days, sections, clicks, sources, devices, hours, languages, recent,
    reachedOut: reached.size + unknownTalkers,
  };
};

/** The dashboard's statistics for the last 7, 30 or 90 days (Asia/Kolkata calendar days, today included). */
export const siteStats = async (site, days, now = Date.now()) => {
  const span = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
  const today = dayIndex(now);
  const first = today - span + 1;
  const from = first * DAY - IST;
  const to = (today + 1) * DAY - IST;

  const { events } = await load(site.slug);
  const leads = await listLeads(site.slug).then((out) => out.leads, () => []);
  const ends = new Map(); // talk id -> seconds, wherever in the log the end landed
  for (const e of events) if (e.e === 'talk_end') ends.set(e.k, e.sec);

  const cur = tally(events, leads, ends, from, to);
  const prev = tally(events, leads, ends, from - span * DAY, from);
  const count = (set) => set?.size ?? 0;

  return {
    range: { days: span, from: dateOf(first), to: dateOf(today), timezone: TIMEZONE },
    totals: cur.totals,
    previous: prev.totals,
    daily: cur.days.map((d, i) => ({ date: dateOf(first + i), views: d.views, visitors: d.visitors.size, engaged: [...d.engaged].filter((v) => d.visitors.has(v)).length, talks: d.talks, enquiries: d.enquiries })),
    funnel: [
      { key: 'visitors', label: 'Visited', count: cur.totals.visitors },
      { key: 'engaged', label: 'Stayed and read', count: cur.totals.engaged },
      { key: 'reached_out', label: 'Tapped call, WhatsApp or the assistant', count: cur.reachedOut },
      { key: 'enquiries', label: 'Left an enquiry', count: cur.totals.enquiries },
    ],
    // Only what is on the page today, in page order; a section nobody reached shows as 0.
    sections: pageSections(site.publishedHtml).map((label) => ({ label, views: count(cur.sections.get(norm(label))) })),
    clicks: [...cur.clicks].map(([key, n]) => ({ kind: key.slice(0, key.indexOf('|')), label: key.slice(key.indexOf('|') + 1), count: n })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 20),
    sources: [...cur.sources].map(([source, set]) => ({ source, visitors: set.size })).sort((a, b) => b.visitors - a.visitors || a.source.localeCompare(b.source)).slice(0, 8),
    devices: { mobile: cur.devices.mobile.size, desktop: cur.devices.desktop.size, tablet: cur.devices.tablet.size },
    hours: cur.hours,
    languages: [...cur.languages].map(([lang, talks]) => ({ lang, talks })).sort((a, b) => b.talks - a.talks || a.lang.localeCompare(b.lang)),
    recent: cur.recent.sort((a, b) => b.at - a.at).slice(0, 20),
    updatedAt: now,
  };
};
