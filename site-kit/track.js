// Launchpad visit counter: tells the site's owner how their page is doing.
// One static file, no build step. Loaded as <script src="/_lp/track.js" defer>, only on the
// published page and only for visits that count (the server leaves it out for the signed-in
// owner and for crawlers; see countable() in server/site-api.mjs).
//
// What it reports, to this site's own server and nowhere else (POST /_lp/api/event):
//   view      the page was opened and seen: referrer host, device class, browser language
//   engaged   the visitor stayed ten seconds or scrolled past half the page
//   leave     seconds the page was on screen so far (sent when it is hidden or closed)
//   sections  which sections were scrolled into view
//   click     a tap on a link or button: call, WhatsApp, email, map or other, with its label
//   open      the assistant was opened (the widget tells us; talks and enquiries are counted
//             by the server itself)
//
// No cookies, no fingerprinting, nothing from other sites. The visitor is a random id kept in
// this site's localStorage (each site has its own subdomain, so the id means nothing anywhere
// else); when storage is blocked every page load is simply its own visitor.
(() => {
  'use strict';

  // Never in a frame (the dashboard and the live preview show pages that way), never on the
  // preview or admin pages, never for automated browsers, and only once per page.
  try { if (window.self !== window.top) return; } catch { return; }
  if (/\/(preview|admin)(\/|$)/.test(location.pathname)) return;
  const ua = navigator.userAgent || '';
  if (navigator.webdriver || /[a-z]bot\b|Bot\b|^bot/.test(ua) || /crawl|spider|slurp|headless|phantomjs|lighthouse|pagespeed|prerender/i.test(ua)) return;
  const LOADED = Symbol.for('lp.track');
  if (window[LOADED]) return;
  window[LOADED] = true;

  const ENDPOINT = (() => { try { return new URL('api/event', document.currentScript.src).pathname; } catch { return '/_lp/api/event'; } })();
  const SESSION_GAP_MS = 30 * 60_000;
  const ENGAGED_AFTER_MS = 10_000;
  const MAX_SECONDS = 30 * 60;
  const ID = /^[A-Za-z0-9_-]{8,32}$/;

  const id = () => {
    try { return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join(''); } catch { /* very old browser */ }
    return (Math.random().toString(36).slice(2) + Date.now().toString(36)).padEnd(16, '0').slice(0, 24);
  };
  const tidy = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

  // ------------------------------------------------------------ who is this ----

  const page = id();
  let visitor = page; // storage blocked: this page load is its own visitor and session
  let session = page;
  let lastActive = Date.now();
  try {
    const kept = window.localStorage.getItem('lp_v');
    visitor = ID.test(kept ?? '') ? kept : id();
    window.localStorage.setItem('lp_v', visitor);
    const last = JSON.parse(window.localStorage.getItem('lp_s') || 'null');
    session = last && ID.test(last.id ?? '') && lastActive - last.at < SESSION_GAP_MS ? last.id : id();
  } catch { visitor = page; session = page; }
  const touch = () => {
    const now = Date.now();
    if (now - lastActive >= SESSION_GAP_MS) session = id(); // back after a long pause: a new visit
    lastActive = now;
    try { window.localStorage.setItem('lp_s', JSON.stringify({ id: session, at: now })); } catch { /* storage is blocked: carry on without it */ }
  };

  // ---------------------------------------------------------------- sending ----

  const queue = [];
  let timer = 0;
  const post = (body) => {
    const text = JSON.stringify(body);
    // A beacon still leaves when the page is closing; fetch is for browsers without it.
    try { if (navigator.sendBeacon(ENDPOINT, new Blob([text], { type: 'application/json' }))) return; } catch { /* fall through */ }
    try { fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', keepalive: true, body: text }).catch(() => {}); } catch { /* nothing more to try */ }
  };
  const flush = () => {
    clearTimeout(timer);
    timer = 0;
    if (!queue.length) return;
    touch();
    while (queue.length) {
      // The server takes at most twelve events and 4 KB a request; stay well inside both.
      const batch = [queue.shift()];
      let size = JSON.stringify(batch[0]).length;
      while (queue.length && batch.length < 10 && size + JSON.stringify(queue[0]).length < 1000) { size += JSON.stringify(queue[0]).length; batch.push(queue.shift()); }
      post({ v: visitor, s: session, p: page, ev: batch });
    }
  };
  const send = (e, data, now) => {
    queue.push({ e, ...data });
    if (now) flush();
    else timer ||= setTimeout(flush, 1500);
  };

  // --------------------------------------------------------------- the view ----

  const referrer = () => {
    const raw = document.referrer || '';
    const app = /^android-app:\/\/([a-z0-9._]+)/i.exec(raw); // opened from an Android app: its package name
    if (app) return app[1].toLowerCase();
    try { const host = new URL(raw).hostname.toLowerCase(); return host === location.hostname ? '' : host; } catch { return ''; }
  };
  const campaign = () => { try { return tidy(new URLSearchParams(location.search).get('utm_source'), 40).toLowerCase().replace(/[^a-z0-9._-]/g, ''); } catch { return ''; } };
  const device = () => {
    const width = Math.min(window.innerWidth || 9999, window.screen?.width || 9999);
    const touch = navigator.maxTouchPoints > 0;
    if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return 'tablet';
    if (/Mobi|iPhone|iPod|Android/i.test(ua) || width < 600) return 'mobile';
    return touch && width < 1024 ? 'tablet' : 'desktop';
  };

  // Time on page counts only while the page is actually on screen.
  let shownAt = 0;
  let shownMs = 0;
  const onScreen = () => shownMs + (shownAt ? performance.now() - shownAt : 0);

  // ---------------------------------------------------------------- engaged ----

  let engaged = false;
  let engageTimer = 0;
  const engage = () => {
    if (engaged) return;
    engaged = true;
    clearInterval(engageTimer);
    window.removeEventListener('scroll', onScroll);
    send('engaged', {}, true);
  };
  // "Past half the page": the middle of the screen has passed the middle of the page. Only
  // checked when they scroll, so a page that fits on one screen does not count by itself.
  function onScroll() {
    const full = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
    const tall = window.innerHeight;
    if (full > tall * 1.2 && window.scrollY + tall / 2 >= full / 2) engage();
  }

  // --------------------------------------------------------------- sections ----
  // The designer puts a comment <!-- section: Label --> before each top-level block; comments
  // survive into the DOM, so the block is the comment's next element. Template pages have no
  // markers: there each <section> is named by its aria-label, first heading or id. The server
  // reads the same labels from the published HTML (pageSections in analytics.mjs).

  const findSections = () => {
    const found = [];
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const m = /^\s*section:\s*(.*?)\s*$/i.exec(node.nodeValue ?? '');
        const el = m && (node.nextElementSibling || node.parentElement);
        if (el && el !== document.body && tidy(m[1], 60)) found.push([tidy(m[1], 60), el]);
      }
    } catch { /* no tree walker: fall back to the elements */ }
    if (!found.length) {
      for (const el of document.querySelectorAll('section')) {
        const label = tidy(el.getAttribute('aria-label') || el.querySelector('h1,h2,h3')?.textContent || el.id, 60);
        if (label) found.push([label, el]);
      }
    }
    return found;
  };

  const seenLabels = [];
  let sectionTimer = 0;
  const flushSections = () => {
    clearTimeout(sectionTimer);
    sectionTimer = 0;
    while (seenLabels.length) queue.push({ e: 'sections', l: seenLabels.splice(0, 8) });
  };
  const watchSections = () => {
    if (!('IntersectionObserver' in window)) return;
    const labels = new Map(); // element -> label
    const waiting = new Map(); // element -> timer while it is in view but not yet "seen"
    const told = new Set();
    for (const [label, el] of findSections()) if (!labels.has(el)) labels.set(el, label);
    if (!labels.size) return;
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target;
        // Seen = half of it, or (for a block taller than the screen) a good part of the screen,
        // for a full second: flying past on the way down does not count.
        const inView = entry.isIntersecting && (entry.intersectionRatio >= 0.5 || entry.intersectionRect.height >= window.innerHeight * 0.4);
        if (inView && !waiting.has(el)) {
          waiting.set(el, setTimeout(() => {
            waiting.delete(el);
            io.unobserve(el);
            const label = labels.get(el);
            if (told.has(label)) return;
            told.add(label);
            seenLabels.push(label);
            sectionTimer ||= setTimeout(() => { flushSections(); flush(); }, 2000);
          }, 1000));
        } else if (!inView && waiting.has(el)) {
          clearTimeout(waiting.get(el));
          waiting.delete(el);
        }
      }
    }, { threshold: [0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.5, 0.75, 1] });
    for (const el of labels.keys()) io.observe(el);
  };

  // ----------------------------------------------------------------- clicks ----

  const kindOf = (href) => {
    const h = String(href ?? '').trim().toLowerCase();
    if (h.startsWith('tel:')) return 'call';
    if (h.startsWith('mailto:')) return 'email';
    if (/^whatsapp:|^https?:\/\/(wa\.me|(api|web|chat)\.whatsapp\.com)(\/|\?|$)/.test(h)) return 'whatsapp';
    if (/^geo:|^https?:\/\/((www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/maps|maps\.apple\.com|(www\.)?openstreetmap\.org|(www\.)?bing\.com\/maps)/.test(h)) return 'map';
    return 'other';
  };
  let lastClick = { el: null, at: 0 };
  const onClick = (event) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest('lp-widget')) return; // the assistant reports for itself
    const el = target.closest('a[href], button, [role="button"], input[type="submit"], input[type="button"]');
    if (!el) return;
    const now = Date.now();
    if (lastClick.el === el && now - lastClick.at < 1000) return; // a double tap is one click
    lastClick = { el, at: now };
    const kind = kindOf(el.tagName === 'A' ? el.getAttribute('href') : '');
    const label = tidy(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.value, 60);
    send('click', { kind, label }, kind !== 'other'); // a contact tap may leave the page: send it at once
  };

  // -------------------------------------------------------------------- leave ----

  let reported = -1;
  const leave = () => {
    const sec = Math.min(MAX_SECONDS, Math.round(onScreen() / 1000));
    flushSections();
    if (sec !== reported) { reported = sec; queue.push({ e: 'leave', sec }); }
    flush();
  };

  // ------------------------------------------------------- for the assistant ----
  // widget.js calls these when it is on the page; nothing breaks when either file is missing.

  let started = false;
  let opened = false;
  window.lpTrack = {
    /** Sent along with a talk so the server can tell which visit it belongs to. */
    ids: () => (started ? { v: visitor } : {}),
    event: (name) => {
      if (!started || name !== 'open' || opened) return; // the first opening per page load is enough
      opened = true;
      send('open', {}, true);
    },
  };

  // -------------------------------------------------------------------- start ----

  const start = () => {
    if (started) return;
    started = true;
    shownAt = performance.now();
    touch();
    const ref = referrer();
    const utm = campaign();
    send('view', { dev: device(), lang: tidy(navigator.language, 12).toLowerCase(), ...(ref && { ref }), ...(utm && { utm }) }, true);

    engageTimer = setInterval(() => { if (onScreen() >= ENGAGED_AFTER_MS) engage(); }, 1000);
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('click', onClick, true);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (shownAt) { shownMs += performance.now() - shownAt; shownAt = 0; }
        leave();
      } else if (!shownAt) shownAt = performance.now();
    });
    window.addEventListener('pagehide', leave);
    watchSections();
  };

  // A page fetched ahead of time, or opened in a background tab, is not a view until it is seen.
  const whenSeen = () => {
    if (document.visibilityState === 'visible') { start(); return; }
    const onShow = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', onShow); start(); } };
    document.addEventListener('visibilitychange', onShow);
  };
  if (document.prerendering) document.addEventListener('prerenderingchange', whenSeen, { once: true });
  else whenSeen();
})();
