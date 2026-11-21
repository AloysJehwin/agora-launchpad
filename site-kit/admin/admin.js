/*
  Launchpad owner panel.
  Plain script, no dependencies. Everything that comes from the server is treated
  as untrusted text: it only ever reaches the page through textContent, or through
  href values that have been checked first.
*/
(function () {
  'use strict';

  var API = '/_lp/api/admin';
  var DRAFT_KEY = 'lp-admin-drafts';
  var DAYS_KEY = 'lp-admin-days';
  var LEADS_EVERY = 15000;
  var STATS_EVERY = 60000;
  var STATS_RECHECK = 300000;   // how often to look again for numbers an older server does not have yet
  var PERIODS = [7, 30, 90];
  var SITE_EVERY_BUSY = 5000;
  var TRANSCRIPT_PEEK = 6;

  var STATUS_ORDER = ['new', 'contacted', 'won', 'lost'];
  var STATUS = {
    new: { label: 'New', icon: 'dot' },
    contacted: { label: 'Contacted', icon: 'half' },
    won: { label: 'Won', icon: 'check' },
    lost: { label: 'Lost', icon: 'x' }
  };
  var SOURCE = {
    voice: { label: 'Talked to the assistant', icon: 'mic' },
    form: { label: 'Left a message', icon: 'note' },
    call: { label: 'Phone call', icon: 'phone' }
  };
  var SITE_STATUS = {
    designing: { label: 'Being designed', tone: 'neutral', icon: 'half' },
    ready: { label: 'Not public yet', tone: 'contacted', icon: 'half' },
    revising: { label: 'Being updated', tone: 'neutral', icon: 'half' },
    published: { label: 'Live', tone: 'won', icon: 'check' },
    failed: { label: 'Needs attention', tone: 'alarm', icon: 'alert' }
  };
  var VIEW_TITLE = { overview: 'Overview', leads: 'Enquiries', website: 'Website', account: 'Account' };

  var ICONS = {
    back: ['M15 5l-7 7 7 7'],
    phone: ['M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z'],
    chat: ['M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 20l1.2-5A8.5 8.5 0 1 1 21 11.5z'],
    mail: ['M3 6h18v12H3z', 'M3 7l9 6 9-6'],
    copy: ['M9 9h11v11H9z', 'M5 15V4h11'],
    check: ['M5 12.5l4.5 4.5L19 7.5'],
    x: ['M6 6l12 12', 'M18 6L6 18'],
    mic: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M5 11a7 7 0 0 0 14 0', 'M12 18v3'],
    note: ['M5 4h14v16H5z', 'M8 9h8', 'M8 13h8', 'M8 17h4'],
    external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v6H4V6h6'],
    alert: ['M12 3.5l9.5 16.5h-19z', 'M12 10v4.5', 'M12 17.2v.1'],
    share: ['M12 15V4', 'M8 8l4-4 4 4', 'M5 13v6h14v-6'],
    dot: ['F:M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z'],
    half: ['M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'F:M12 5a7 7 0 0 1 0 14z'],
    go: ['M9 5l7 7-7 7'],
    up: ['M12 19V5', 'M6 11l6-6 6 6'],
    down: ['M12 5v14', 'M6 13l6 6 6-6'],
    refresh: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4v3.5H16'],
    eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
    pin: ['M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z', 'M12 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'],
    tap: ['M9 11.5V5a1.5 1.5 0 0 1 3 0v5.5', 'M12 10a1.5 1.5 0 0 1 3 0v1.5', 'M15 11a1.5 1.5 0 0 1 3 0v4a6 6 0 0 1-6 6h-.6a5 5 0 0 1-4.1-2.1L4.9 15.4a1.4 1.4 0 0 1 2.2-1.7L9 15.5'],
    smartphone: ['M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M11 18h2'],
    desktop: ['M3 5h18v11H3z', 'M9 20h6', 'M12 16v4'],
    tablet: ['M6 3h12v18H6z', 'M11 18h2']
  };

  var state = {
    me: null,
    view: 'overview',
    leadId: null,
    leads: [],
    counts: null,
    leadsLoaded: false,
    leadsError: null,
    filter: 'all',
    site: null,
    siteLoaded: false,
    siteError: null,
    stats: null,                 // the last numbers the server gave us, tidied
    statsDays: loadDays(),
    statsStatus: 'loading',      // 'loading' | 'ok' | 'stale' | 'error' | 'unavailable'
    statsError: null,
    statsOkAt: 0,
    drafts: loadDrafts()
  };

  var ui = {};            // long-lived element references
  var detail = null;      // the open lead's DOM and local state
  var epoch = 0;          // bumped around every write, so a poll that overlapped one is thrown away
  var leadsLoading = false;
  var siteLoading = false;
  var lastLeadsAt = 0;
  var lastSiteAt = 0;
  var ticker = null;
  var gateShown = false;
  var listScrollY = 0;
  var uid = 0;
  var wide = window.matchMedia('(min-width: 900px)');

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                       */
  /* ------------------------------------------------------------------ */

  function $(id) { return document.getElementById(id); }
  function nextId(prefix) { uid += 1; return prefix + '-' + uid; }
  function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function enc(v) { return encodeURIComponent(v); }

  function append(el, kids) {
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k == null || k === false) continue;
      if (Array.isArray(k)) append(el, k);
      else el.append(k.nodeType ? k : document.createTextNode(String(k)));
    }
  }

  // h('div', { class: 'x', onclick: fn }, child, 'text', [more])
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      });
    }
    append(el, Array.prototype.slice.call(arguments, 2));
    return el;
  }

  function icon(name, extraClass) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'icon' + (extraClass ? ' ' + extraClass : ''));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    (ICONS[name] || []).forEach(function (d) {
      var p = document.createElementNS(NS, 'path');
      if (d.slice(0, 2) === 'F:') { p.setAttribute('class', 'fill'); d = d.slice(2); }
      p.setAttribute('d', d);
      svg.append(p);
    });
    return svg;
  }

  function stamp(tone, label, iconName, big) {
    return h('span', { class: 'stamp' + (big ? ' stamp-big' : ''), 'data-tone': tone }, icon(iconName), label);
  }

  function statusStamp(status, big) {
    var s = STATUS[status] || STATUS.new;
    return stamp(STATUS[status] ? status : 'new', s.label, s.icon, big);
  }

  // Only http(s) URLs may become links, iframes or redirects.
  function safeUrl(value) {
    var raw = str(value).trim();
    if (!raw) return '';
    try {
      var u = new URL(raw, window.location.href);
      return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : '';
    } catch (e) { return ''; }
  }

  function prettyUrl(value) {
    return str(value).replace(/^https?:\/\//i, '').replace(/\/$/, '');
  }

  function telHref(phone) {
    var p = str(phone).replace(/[^\d+]/g, '');
    return p.replace(/\D/g, '').length >= 5 ? 'tel:' + p : '';
  }

  function whatsappHref(phone) {
    var digits = str(phone).replace(/\D/g, '');
    return digits.length >= 8 ? 'https://wa.me/' + digits : '';
  }

  function mailHref(email) {
    var e = str(email).trim();
    return /^[^\s@<>"'`\\]+@[^\s@<>"'`\\]+\.[^\s@<>"'`\\]+$/.test(e) ? 'mailto:' + e : '';
  }

  function validTime(ts) { return typeof ts === 'number' && isFinite(ts) && ts > 0; }

  function relTime(ts) {
    if (!validTime(ts)) return '';
    var now = new Date();
    var then = new Date(ts);
    var secs = Math.round((now - then) / 1000);
    if (secs < 60) return 'Just now';
    var mins = Math.round(secs / 60);
    if (mins < 60) return mins + ' min ago';
    var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var startOfThen = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
    var days = Math.round((startOfToday - startOfThen) / 86400000);
    if (days <= 0 || secs < 6 * 3600) return Math.round(mins / 60) + ' hr ago';
    if (days === 1) return 'Yesterday';
    if (days < 7) return days + ' days ago';
    var opts = { day: 'numeric', month: 'short' };
    if (then.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return then.toLocaleDateString(undefined, opts);
  }

  function fullTime(ts) {
    if (!validTime(ts)) return '';
    return new Date(ts).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function clockTime(ts) {
    if (!validTime(ts)) return '';
    return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  // <time> that keeps itself current: refreshTimes() rewrites every data-rel element.
  function timeEl(ts, className) {
    if (!validTime(ts)) return null;
    return h('time', { class: className || null, datetime: new Date(ts).toISOString(), title: fullTime(ts), 'data-rel': ts }, relTime(ts));
  }

  function refreshTimes() {
    var nodes = document.querySelectorAll('time[data-rel]');
    for (var i = 0; i < nodes.length; i++) {
      var next = relTime(Number(nodes[i].getAttribute('data-rel')));
      if (nodes[i].textContent !== next) nodes[i].textContent = next;
    }
  }

  function announce(text, urgent) {
    var region = $(urgent ? 'live-assertive' : 'live-polite');
    if (!region) return;
    region.textContent = '';
    window.setTimeout(function () { region.textContent = text; }, 60);
  }

  // One line of feedback under an action. kind: 'pending' | 'ok' | 'error'.
  function setLine(el, kind, text, action) {
    el.replaceChildren();
    if (!text) { el.hidden = true; el.removeAttribute('data-kind'); return; }
    el.hidden = false;
    el.setAttribute('data-kind', kind);
    el.append(
      kind === 'pending' ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : icon(kind === 'ok' ? 'check' : 'alert', 'icon-sm'),
      h('span', { class: 'status-text' }, text, action ? [' ', action] : null)
    );
    if (kind === 'error') announce(text, true);
    else if (kind === 'ok') announce(text);
  }

  function statusLine() { return h('p', { class: 'status-line', hidden: true }); }

  // Busy buttons stay focusable (aria-disabled, not disabled) so focus is never dropped.
  function setBusy(btn, busy, busyLabel) {
    if (busy) {
      if (!btn._idle) btn._idle = Array.prototype.slice.call(btn.childNodes);
      btn.setAttribute('aria-busy', 'true');
      btn.setAttribute('aria-disabled', 'true');
      btn.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), busyLabel);
    } else {
      btn.removeAttribute('aria-busy');
      btn.removeAttribute('aria-disabled');
      if (btn._idle) { btn.replaceChildren.apply(btn, btn._idle); btn._idle = null; }
    }
  }
  function isOff(btn) { return btn.getAttribute('aria-disabled') === 'true'; }

  function focusEl(el, keepScroll) {
    if (!el) return;
    try { el.focus({ preventScroll: !!keepScroll }); } catch (e) { el.focus(); }
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall through to the old way */ }
    try {
      var ta = h('textarea', { class: 'sr-only', readonly: true, 'aria-hidden': 'true', tabindex: '-1' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) { return false; }
  }

  // The site's address with a copy button. Used in the empty state, Website and Account.
  function addressRow(url) {
    var href = safeUrl(url);
    var shown = prettyUrl(url) || 'Address not ready yet';
    // Long addresses wrap between the dots, never in the middle of a name.
    var pieces = [];
    shown.split('.').forEach(function (part, i) {
      if (i > 0) pieces.push(h('wbr'));
      pieces.push(h('span', { class: 'address-part' }, (i > 0 ? '.' : '') + part));
    });
    var link = href
      ? h('a', { class: 'address-link', href: href, target: '_blank', rel: 'noopener' }, pieces, h('span', { class: 'sr-only' }, ' (opens in a new tab)'))
      : h('span', { class: 'address-link' }, href ? pieces : shown);
    var row = h('div', { class: 'address' }, link);
    if (href) {
      var btn = h('button', { type: 'button', class: 'btn' }, icon('copy', 'icon-sm'), 'Copy');
      var timer = null;
      btn.addEventListener('click', async function () {
        var ok = await copyText(href);
        btn.replaceChildren(icon(ok ? 'check' : 'alert', 'icon-sm'), ok ? 'Copied' : 'Copy failed');
        announce(ok ? 'Address copied.' : 'Could not copy. Press and hold the address to copy it.', !ok);
        window.clearTimeout(timer);
        timer = window.setTimeout(function () { btn.replaceChildren(icon('copy', 'icon-sm'), 'Copy'); }, 2200);
      });
      row.append(btn);
    }
    return row;
  }

  /* ------------------------------------------------------------------ */
  /* Drafts: whatever the owner has typed survives polls, navigation and  */
  /* a reload or a trip through sign-in.                                  */
  /* ------------------------------------------------------------------ */

  function loadDrafts() {
    try {
      var parsed = JSON.parse(window.sessionStorage.getItem(DRAFT_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) { return {}; }
  }

  function setDraft(key, value) {
    if (value) state.drafts[key] = value; else delete state.drafts[key];
    try { window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(state.drafts)); } catch (e) { /* private mode: memory only */ }
  }

  /* ------------------------------------------------------------------ */
  /* Talking to the server                                               */
  /* ------------------------------------------------------------------ */

  function fallbackMessage(status) {
    if (status === 400) return 'That did not go through. Check it and try again.';
    if (status === 401) return 'You have been signed out.';
    if (status === 403) return 'That is not allowed for this account.';
    if (status === 404) return 'We could not find that. It may have been removed.';
    if (status === 429) return 'Too much at once. Wait a moment and try again.';
    if (status === 502 || status === 503 || status === 504) return 'A service we rely on did not answer. Try again in a minute.';
    return 'Something went wrong on our side. Try again in a minute.';
  }

  // opts: { method, body, isMe, fallbacks: { [status]: message } }
  async function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    var res;
    try {
      res = await fetch(API + path, init);
    } catch (e) {
      var offline = new Error('No connection. Check your internet and try again.');
      offline.status = 0;
      throw offline;
    }
    var data = null;
    try { data = await res.json(); } catch (e2) { data = null; }
    if (!res.ok) {
      var serverSays = data && typeof data.error === 'string' && data.error.trim();
      var err = new Error(serverSays || (opts.fallbacks && opts.fallbacks[res.status]) || fallbackMessage(res.status));
      err.status = res.status;
      err.data = data;
      if (res.status === 401 && !opts.isMe) sessionLost();
      throw err;
    }
    return data && typeof data === 'object' ? data : {};
  }

  // Wrap every write so an overlapping background refresh cannot overwrite its result.
  async function mutate(fn) {
    epoch += 1;
    try { return await fn(); } finally { epoch += 1; }
  }

  function normalizeLead(l) {
    l = l && typeof l === 'object' ? l : {};
    return {
      id: str(l.id),
      createdAt: Number(l.createdAt) || 0,
      updatedAt: Number(l.updatedAt) || 0,
      name: str(l.name).trim(),
      phone: str(l.phone).trim(),
      email: str(l.email).trim(),
      source: str(l.source),
      lang: str(l.lang).trim(),
      summary: str(l.summary).trim(),
      message: str(l.message).trim(),
      status: STATUS[l.status] ? l.status : 'new',
      notes: arr(l.notes).map(function (n) { n = n || {}; return { at: Number(n.at) || 0, text: str(n.text), by: str(n.by) }; }),
      transcript: arr(l.transcript).map(function (t) { t = t || {}; return { role: t.role === 'assistant' ? 'assistant' : 'visitor', text: str(t.text), at: Number(t.at) || 0 }; })
        .filter(function (t) { return t.text.trim() !== ''; }),
      messages: arr(l.messages).map(function (m) { m = m || {}; return { at: Number(m.at) || 0, text: str(m.text), status: str(m.status), channel: str(m.channel) }; })
    };
  }

  function normalizeSite(s, previous) {
    s = s && typeof s === 'object' ? s : {};
    previous = previous || {};
    return {
      slug: str(s.slug),
      name: str(s.name).trim(),
      status: str(s.status),
      url: str(s.url),
      address: str(s.url) || str(previous.address),   // where the site lives, or will live once published
      previewUrl: str(s.previewUrl),
      lang: str(s.lang),
      sections: Array.isArray(s.sections) ? s.sections.map(str).filter(Boolean) : arr(previous.sections),
      unpublishedChanges: typeof s.unpublishedChanges === 'boolean' ? s.unpublishedChanges : !!previous.unpublishedChanges,
      madeBy: s.madeBy != null ? str(s.madeBy) : str(previous.madeBy)
    };
  }

  function recount() {
    var c = { total: state.leads.length, new: 0, contacted: 0, won: 0, lost: 0 };
    state.leads.forEach(function (l) { c[l.status] += 1; });
    state.counts = c;
  }

  function findLead(id) {
    for (var i = 0; i < state.leads.length; i++) if (state.leads[i].id === id) return state.leads[i];
    return null;
  }

  function leadName(lead) { return lead.name || 'Unknown caller'; }
  function siteName() { return (state.site && state.site.name) || 'your website'; }
  function siteUrl() { return state.site ? (state.site.url || state.site.address) : ''; }

  /* ------------------------------------------------------------------ */
  /* Starting up, signing in, signing out                                 */
  /* ------------------------------------------------------------------ */

  async function boot() {
    var url = new URL(window.location.href);
    var claim = url.searchParams.get('claim');
    try {
      var me = await api('/me' + (claim ? '?claim=' + enc(claim) : ''), { isMe: true });
      if (claim) {
        url.searchParams.delete('claim');
        window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
      }
      state.me = me;
      state.site = normalizeSite(me.site);
      showApp();
    } catch (err) {
      if (err.status === 401) showGate({ reason: claim ? 'bad-link' : 'signed-out', data: err.data, message: err.message });
      else showGate({ reason: 'unreachable', message: err.message });
    }
  }

  // context.reason: 'signed-out' | 'bad-link' | 'expired' | 'left' | 'unreachable'
  function showGate(context) {
    gateShown = true;
    stopTicker();
    var gate = $('gate');
    var data = context.data || {};
    var signInUrl = safeUrl(data.signInUrl);
    var card = h('div', { class: 'gate-card enter' }, h('p', { class: 'gate-eyebrow' }, 'Launchpad'));
    var title = h('h1', { class: 'gate-title', tabindex: '-1' });
    card.append(title);

    if (context.reason === 'unreachable') {
      title.textContent = 'We can’t reach your panel right now';
      card.append(
        h('p', { class: 'lede' }, context.message || 'Check your connection and try again.'),
        h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: function () { window.location.reload(); } }, 'Try again')
      );
    } else {
      if (context.reason === 'left') title.textContent = 'You’re signed out';
      else if (context.reason === 'expired') title.textContent = 'Sign in again to carry on';
      else if (context.reason === 'bad-link') title.textContent = 'That link didn’t let you in';
      else title.textContent = 'Sign in to see your website';

      if (context.reason === 'expired') {
        card.append(h('p', { class: 'lede' }, 'You were signed out for safety. Anything you were typing has been kept on this device.'));
      } else if (context.reason === 'bad-link') {
        card.append(h('div', { class: 'notice', 'data-kind': 'error' }, icon('alert'),
          h('div', { class: 'notice-body' }, context.message || 'The private link may have expired or already been used.')));
      } else if (context.reason !== 'left') {
        card.append(h('p', { class: 'lede' }, 'This is the private panel for the owner of this website: how many people visit, who got in touch, and the site itself.'));
      }

      if (signInUrl) {
        card.append(
          h('a', { class: 'btn btn-primary btn-block', href: signInUrl }, 'Sign in with Google'),
          h('p', { class: 'fine' }, 'Use the Google account you gave when your site was set up. You can also open the private link from your text message.')
        );
      } else {
        card.append(
          h('p', { class: 'lede' }, 'You get in with the private link we sent you by text message when your site was made.'),
          h('ol', { class: 'gate-steps' },
            h('li', null, h('span', null, 'Open your text messages on this phone.')),
            h('li', null, h('span', null, 'Find the message from Launchpad about your website.')),
            h('li', null, h('span', null, 'Tap the link in it. It opens this page and signs you in.'))
          ),
          h('p', { class: 'fine' }, 'Keep that message. The link is your key, so don’t forward it to anyone you wouldn’t hand your shop keys to.')
        );
      }
    }

    gate.replaceChildren(card);
    $('boot').hidden = true;
    $('app').hidden = true;
    gate.hidden = false;
    document.title = 'Sign in';
    if (context.reason === 'expired' || context.reason === 'left') focusEl(title);
  }

  var losingSession = false;
  async function sessionLost() {
    if (gateShown || losingSession) return;
    losingSession = true;
    try {
      // Ask again: a 401 from /me carries the sign-in link, other endpoints do not.
      await api('/me', { isMe: true });
    } catch (err) {
      if (err.status === 401) showGate({ reason: 'expired', data: err.data, message: err.message });
    } finally { losingSession = false; }
  }

  async function signOut(btn, line) {
    if (isOff(btn)) return;
    setBusy(btn, true, 'Signing out…');
    setLine(line, null, '');
    try {
      await api('/logout', { method: 'POST', isMe: true });
    } catch (err) {
      if (err.status !== 401) {
        setBusy(btn, false);
        setLine(line, 'error', 'Could not sign you out. ' + err.message);
        return;
      }
    }
    // Signing out on a shared phone should not leave half-written messages behind.
    state.drafts = {};
    try { window.sessionStorage.removeItem(DRAFT_KEY); } catch (e) { /* nothing stored */ }
    var data = null;
    try { await api('/me', { isMe: true }); } catch (err2) { data = err2.data; }
    showGate({ reason: 'left', data: data });
  }

  function showApp() {
    gateShown = false;
    $('boot').hidden = true;
    $('gate').hidden = true;
    $('app').hidden = false;

    $('brand-name').textContent = siteName();
    $('who').textContent = state.me.email ? 'Signed in as ' + str(state.me.email) : '';

    buildOverviewView();
    buildLeadsView();
    buildWebsiteView();
    buildAccountView();

    window.addEventListener('hashchange', function () { route(true); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(true); });
    window.addEventListener('focus', function () { tick(true); });
    window.addEventListener('online', function () { tick(true); });
    document.addEventListener('keydown', onKeydown);
    if (wide.addEventListener) wide.addEventListener('change', function () { route(false); });

    route(false);
    loadLeads();
    loadSite();
    loadStats();
    startTicker();
  }

  /* ------------------------------------------------------------------ */
  /* Background refresh                                                  */
  /* ------------------------------------------------------------------ */

  function startTicker() {
    stopTicker();
    ticker = window.setInterval(function () { tick(false); }, 5000);
  }
  function stopTicker() { if (ticker) { window.clearInterval(ticker); ticker = null; } }

  function siteIsBusy() { return !!state.site && (state.site.status === 'designing' || state.site.status === 'revising'); }

  function tick(woke) {
    if (gateShown || document.hidden || !state.me) return;
    var now = Date.now();
    refreshTimes();
    if (now - lastLeadsAt >= (woke ? 3000 : LEADS_EVERY - 500)) loadLeads();
    if (state.view === 'website') {
      var every = siteIsBusy() ? SITE_EVERY_BUSY : LEADS_EVERY;
      if (now - lastSiteAt >= (woke ? 3000 : every - 500)) loadSite();
    }
    if (state.view === 'overview') {
      // Gentle: the numbers move slowly, and the site's state only matters here as a headline.
      var statsEvery = state.statsStatus === 'unavailable' ? STATS_RECHECK : STATS_EVERY;
      if (!statsLoading && now - lastStatsAt >= (woke ? 15000 : statsEvery - 500)) loadStats();
      if (now - lastSiteAt >= (siteIsBusy() ? SITE_EVERY_BUSY : STATS_EVERY) - 500) loadSite();
    }
  }

  async function loadLeads() {
    if (leadsLoading || gateShown) return;
    leadsLoading = true;
    lastLeadsAt = Date.now();
    var startedAt = epoch;
    try {
      var data = await api('/leads');
      if (startedAt !== epoch) { lastLeadsAt = 0; return; }   // a write happened meanwhile; ask again on the next tick
      state.leads = arr(data.leads).map(normalizeLead).filter(function (l) { return l.id; });
      var c = data.counts;
      if (c && typeof c === 'object' && STATUS_ORDER.every(function (s) { return typeof c[s] === 'number'; })) {
        state.counts = { total: typeof c.total === 'number' ? c.total : state.leads.length, new: c.new, contacted: c.contacted, won: c.won, lost: c.lost };
      } else {
        recount();
      }
      state.leadsLoaded = true;
      state.leadsError = null;
    } catch (err) {
      if (err.status === 401) return;
      state.leadsError = err.message;
    } finally {
      leadsLoading = false;
      if (!gateShown) { renderLeads(); renderLeadPane(); renderAttention(); if (state.statsStatus === 'unavailable') renderStats(); }
    }
  }

  async function loadSite() {
    if (siteLoading || gateShown) return;
    siteLoading = true;
    lastSiteAt = Date.now();
    try {
      var wasBusy = siteIsBusy();
      var data = await api('/site');
      state.site = normalizeSite(data, state.site);
      state.siteLoaded = true;
      state.siteError = null;
      if (wasBusy && !siteIsBusy()) reloadPreview();
    } catch (err) {
      if (err.status === 401) return;
      state.siteError = err.message;
    } finally {
      siteLoading = false;
      if (!gateShown) { updateWebsite(); updateSiteBadge(); renderOverviewSite(); renderAttention(); renderStats(); }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Routing and focus                                                   */
  /* ------------------------------------------------------------------ */

  function parseHash() {
    var parts = window.location.hash.replace(/^#\/?/, '').split('/');
    var view = VIEW_TITLE[parts[0]] ? parts[0] : 'overview';
    var leadId = null;
    if (view === 'leads' && parts[1]) {
      try { leadId = decodeURIComponent(parts.slice(1).join('/')); } catch (e) { leadId = null; }
    }
    return { view: view, leadId: leadId };
  }

  function route(fromUser) {
    var next = parseHash();
    var prev = { view: state.view, leadId: state.leadId };
    var narrow = !wide.matches;

    if (narrow && prev.view === 'leads' && !prev.leadId && next.leadId) listScrollY = window.scrollY;

    state.view = next.view;
    state.leadId = next.leadId;

    Object.keys(VIEW_TITLE).forEach(function (v) { $('view-' + v).hidden = v !== state.view; });
    var links = document.querySelectorAll('.nav-link');
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute('data-view') === state.view) links[i].setAttribute('aria-current', 'page');
      else links[i].removeAttribute('aria-current');
    }

    if (state.view === 'overview') { renderOverview(); if (fromUser) tick(true); }
    if (state.view === 'leads') { renderLeads(); renderLeadPane(); }
    if (state.view === 'website') { updateWebsite(); if (fromUser) tick(true); }
    updateTitle();

    if (!fromUser) return;

    if (state.view === 'leads' && state.leadId && state.leadId !== prev.leadId) {
      if (narrow) window.scrollTo(0, 0); else ui.leadPane.scrollTop = 0;
      focusEl(ui.leadPane.querySelector('[data-focus]'), true);
    } else if (state.view === 'leads' && !state.leadId && prev.view === 'leads' && prev.leadId) {
      if (narrow) window.scrollTo(0, listScrollY);
      focusEl(rowLink(prev.leadId) || ui.leadsTitle, true);
    } else if (state.view !== prev.view) {
      if (narrow) window.scrollTo(0, 0);
      focusEl($(state.view + '-title'), true);
    }
  }

  function updateTitle() {
    var bits = [];
    var lead = state.view === 'leads' && state.leadId ? findLead(state.leadId) : null;
    if (lead) bits.push(leadName(lead));
    bits.push(VIEW_TITLE[state.view]);
    if (state.site && state.site.name) bits.push(state.site.name);
    document.title = bits.join(' · ');
  }

  function onKeydown(e) {
    if (e.key !== 'Escape' || e.defaultPrevented || gateShown) return;
    if (state.view !== 'leads' || !state.leadId) return;
    if (detail && detail.callState === 'confirm') { cancelCall(detail); return; }
    var t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
    window.location.hash = '#/leads';
  }

  /* ------------------------------------------------------------------ */
  /* Overview: how the site is doing and what is waiting for the owner   */
  /* ------------------------------------------------------------------ */

  var ov = null;
  var statsLoading = false;
  var statsSeq = 0;
  var lastStatsAt = 0;

  var TOTAL_KEYS = ['views', 'visitors', 'engaged', 'engagementRate', 'avgSeconds', 'contactClicks', 'assistantOpens', 'talks', 'talkSeconds', 'enquiries', 'conversionRate'];
  var CLICK_ICON = { call: 'phone', whatsapp: 'chat', email: 'mail', map: 'pin', other: 'tap' };
  var FEED_ICON = { view: 'eye', click: 'tap', talk: 'mic', enquiry: 'note' };
  var LANG_NAMES = { en: 'English', hi: 'Hindi', te: 'Telugu', ta: 'Tamil', kn: 'Kannada', ml: 'Malayalam', mr: 'Marathi', bn: 'Bengali', gu: 'Gujarati', pa: 'Punjabi', ur: 'Urdu', or: 'Odia', as: 'Assamese' };
  var NUMBERS = (function () { try { return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }); } catch (e) { return null; } })();

  function loadDays() {
    try {
      var n = Number(window.localStorage.getItem(DAYS_KEY));
      return PERIODS.indexOf(n) >= 0 ? n : 30;
    } catch (e) { return 30; }
  }

  function obj(v) { return v && typeof v === 'object' ? v : {}; }
  function num(v) { v = Number(v); return isFinite(v) && v > 0 ? v : 0; }
  function fmt(n) { n = Math.round(num(n)); return NUMBERS ? NUMBERS.format(n) : String(n); }
  function plural(n, one, many) { return fmt(n) + ' ' + (Math.round(num(n)) === 1 ? one : many); }
  function capFirst(text) { return text.charAt(0).toUpperCase() + text.slice(1); }

  // 130 -> "2 min 10 s"
  function duration(seconds) {
    var s = Math.round(num(seconds));
    if (s < 60) return s + ' s';
    var m = Math.floor(s / 60);
    var rest = s % 60;
    if (m < 60) return m + ' min' + (rest ? ' ' + rest + ' s' : '');
    var hrs = Math.floor(m / 60);
    return hrs + ' hr' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  }

  // A rate said the way a person would say it: 0.56 -> "56 of every 100 visitors".
  function perHundred(rate) {
    rate = num(rate);
    if (rate <= 0) return 'none of your visitors';
    if (rate < 0.0095) {
      // Too small to say out of a hundred: "about 1 of every 170 visitors".
      var every = 1 / rate;
      every = every >= 1000 ? Math.round(every / 100) * 100 : Math.round(every / 10) * 10;
      return 'about 1 of every ' + fmt(every) + ' visitors';
    }
    return Math.min(100, Math.round(rate * 100)) + ' of every 100 visitors';
  }

  function parseDay(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(value));
    return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  }

  // Days arrive as plain dates in the site's own timezone, so they are shown as written.
  function dayLabel(value, withWeekday) {
    var d = value && value.getTime ? value : parseDay(value);
    if (!d) return str(value);
    try {
      return d.toLocaleDateString('en-IN', withWeekday
        ? { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }
        : { day: 'numeric', month: 'short', timeZone: 'UTC' });
    } catch (e) { return str(value); }
  }

  function hourLabel(hour) {
    hour = ((hour % 24) + 24) % 24;
    return (hour % 12 === 0 ? 12 : hour % 12) + (hour < 12 ? ' am' : ' pm');
  }

  function langName(code) {
    var base = str(code).toLowerCase().split(/[-_]/)[0];
    if (LANG_NAMES[base]) return LANG_NAMES[base];
    try {
      var name = new Intl.DisplayNames(['en'], { type: 'language' }).of(base);
      if (name && name !== base) return name;
    } catch (e) { /* older browser, or not a language code */ }
    return str(code) || 'Another language';
  }

  function timezoneName(tz) {
    if (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') return 'India time';
    return tz ? tz.split('/').pop().replace(/_/g, ' ') + ' time' : '';
  }

  function normTotals(t) {
    t = obj(t);
    var out = {};
    TOTAL_KEYS.forEach(function (k) { out[k] = num(t[k]); });
    return out;
  }

  function normalizeStats(d, askedDays) {
    d = obj(d);
    var range = obj(d.range);
    var devices = obj(d.devices);
    var hours = [];
    for (var i = 0; i < 24; i++) hours.push(num(arr(d.hours)[i]));
    return {
      days: PERIODS.indexOf(Number(range.days)) >= 0 ? Number(range.days) : askedDays,
      from: str(range.from),
      to: str(range.to),
      timezone: str(range.timezone),
      totals: normTotals(d.totals),
      previous: normTotals(d.previous),
      daily: arr(d.daily).map(function (x) { x = obj(x); return { date: str(x.date), views: num(x.views), visitors: num(x.visitors), engaged: num(x.engaged), talks: num(x.talks), enquiries: num(x.enquiries) }; }),
      funnel: arr(d.funnel).map(function (x) { x = obj(x); return { key: str(x.key), label: str(x.label).trim(), count: num(x.count) }; }).filter(function (x) { return x.label; }),
      sections: arr(d.sections).map(function (x) { x = obj(x); return { label: str(x.label).trim(), count: num(x.views) }; }).filter(function (x) { return x.label; }),
      clicks: arr(d.clicks).map(function (x) { x = obj(x); return { kind: str(x.kind), label: str(x.label).trim() || 'A button', count: num(x.count) }; }),
      sources: arr(d.sources).map(function (x) { x = obj(x); return { label: str(x.source).trim() || 'Somewhere else', count: num(x.visitors) }; }),
      devices: { mobile: num(devices.mobile), desktop: num(devices.desktop), tablet: num(devices.tablet) },
      hours: hours,
      languages: arr(d.languages).map(function (x) { x = obj(x); return { lang: str(x.lang).trim(), count: num(x.talks) }; }),
      recent: arr(d.recent).slice(0, 20).map(function (x) { x = obj(x); return { at: Number(x.at) || 0, type: str(x.type), text: str(x.text).trim() }; }).filter(function (x) { return x.text; }),
      updatedAt: Number(d.updatedAt) || 0
    };
  }

  // Public or not. The server hands out a public address only once a site has been published;
  // a published site that has since been changed reports "ready" again, but visitors still reach it.
  function isLive() {
    var site = state.site;
    if (!site) return false;
    return state.siteLoaded ? !!site.url : site.status === 'published';
  }

  // Until the site's details have arrived, "ready" could mean either, so nothing is claimed yet.
  function siteSettled() {
    return state.siteLoaded || !!state.siteError || (!!state.site && state.site.status !== 'ready');
  }

  // manual: the owner pressed Refresh or changed the period (so say when it is done).
  async function loadStats(manual) {
    if (gateShown) return;
    var days = state.statsDays;
    var seq = ++statsSeq;                 // the newest request wins when the period changes mid-flight
    statsLoading = true;
    lastStatsAt = Date.now();
    paintStatsBar();
    try {
      var data = await api('/stats?days=' + days);
      if (seq !== statsSeq) return;
      state.stats = normalizeStats(data, days);
      state.statsStatus = 'ok';
      state.statsError = null;
      state.statsOkAt = Date.now();
      if (manual) announce('Numbers updated.');
    } catch (err) {
      if (seq !== statsSeq || err.status === 401) return;
      if (err.status === 404) {
        // An older server that does not count visits yet. Everything else carries on.
        state.stats = null;
        state.statsStatus = 'unavailable';
        state.statsError = null;
      } else {
        if (state.stats && state.stats.days !== days) state.stats = null;
        state.statsStatus = state.stats ? 'stale' : 'error';
        state.statsError = err.message;
      }
    } finally {
      if (seq === statsSeq) {
        statsLoading = false;
        if (!gateShown) { renderStats(); renderAttention(); }
      }
    }
  }

  function setPeriod(days) {
    if (PERIODS.indexOf(days) < 0 || days === state.statsDays) return;
    state.statsDays = days;
    try { window.localStorage.setItem(DAYS_KEY, String(days)); } catch (e) { /* private mode: this visit only */ }
    if (!state.stats && state.statsStatus !== 'unavailable') state.statsStatus = 'loading';
    loadStats(true);
  }

  async function refreshAll() {
    if (isOff(ov.refresh)) return;
    ov.refresh.setAttribute('aria-busy', 'true');
    ov.refresh.setAttribute('aria-disabled', 'true');
    loadLeads();
    loadSite();
    await loadStats(true);
    ov.refresh.removeAttribute('aria-busy');
    ov.refresh.removeAttribute('aria-disabled');
  }

  function buildOverviewView() {
    var view = $('view-overview');
    ov = { sig: {}, charts: [], open: {}, radios: {}, waitShown: false };

    ov.title = h('h1', { class: 'page-title', id: 'overview-title', tabindex: '-1' }, 'Overview');
    ov.stampSlot = h('span');
    ov.site = h('div', { class: 'ov-site' });
    ov.attention = h('section', { class: 'ov-attn', 'aria-labelledby': 'attn-title' });
    // The newest unanswered enquiries. It lives among the cards below, next to the numbers.
    ov.waitCard = h('section', { class: 'slip card card-wait', 'aria-labelledby': 'wait-title', 'data-card': 'wait' });

    // Period and refresh: one row, above everything they change.
    var radioName = nextId('period');
    ov.periods = h('div', { class: 'status-set seg', role: 'radiogroup', 'aria-label': 'Show numbers for the last' });
    PERIODS.forEach(function (n) {
      var input = h('input', { type: 'radio', name: radioName, value: n });
      input.checked = n === state.statsDays;
      input.addEventListener('change', function () { if (input.checked) setPeriod(n); });
      ov.radios[n] = input;
      ov.periods.append(h('label', { class: 'status-opt' }, input, h('span', { class: 'status-face' }, n + ' days')));
    });
    ov.refresh = h('button', { type: 'button', class: 'btn ov-refresh', 'aria-label': 'Refresh the numbers' }, icon('refresh'), h('span', { class: 'ov-refresh-label' }, 'Refresh'));
    ov.refresh.addEventListener('click', refreshAll);
    ov.updated = h('p', { class: 'fine ov-updated' });
    ov.statsTitle = h('h2', { class: 'section-title', id: 'stats-title', tabindex: '-1' }, 'How your site is doing');
    ov.alert = h('div', { hidden: true });
    ov.body = h('div', { class: 'ov-body' });

    view.replaceChildren(h('div', { class: 'overview' },
      h('div', { class: 'ov-head' }, h('div', { class: 'site-head' }, ov.title, ov.stampSlot), ov.site),
      ov.attention,
      h('section', { class: 'ov-stats', 'aria-labelledby': 'stats-title' },
        h('div', { class: 'ov-bar' }, ov.statsTitle, ov.updated),
        h('div', { class: 'ov-controls' }, ov.periods, ov.refresh),
        ov.alert, ov.body)));

    // Charts are drawn to the pixel width they are given, so redraw when that changes.
    if (typeof window.ResizeObserver === 'function') new window.ResizeObserver(function () { drawCharts(false); }).observe(ov.body);
    else window.addEventListener('resize', function () { drawCharts(false); });

    renderOverview();
  }

  function renderOverview() {
    renderOverviewSite();
    renderAttention();
    renderStats();
  }

  function shareButton(label, primary) {
    var href = safeUrl(siteUrl());
    if (!href || typeof navigator.share !== 'function') return null;
    return h('button', { type: 'button', class: 'btn' + (primary ? ' btn-primary' : ''), onclick: function () {
      navigator.share({ title: siteName(), url: href }).catch(function () { /* the owner closed the share sheet */ });
    } }, icon('share', 'icon-sm'), label);
  }

  function goLink(label, href, primary, onclick) {
    return h('a', { class: 'btn' + (primary ? ' btn-primary' : ''), href: href, onclick: onclick || null }, label, icon('go', 'icon-sm'));
  }

  /* The site itself: is it public, and where. */
  function renderOverviewSite() {
    if (!ov || !state.site) return;
    var site = state.site;
    var live = isLive();

    var settled = siteSettled();

    patch(ov, 'stamp', [site.status, live, settled], function () {
      var s = settled ? SITE_STATUS[site.status] : null;
      // A site that is public is live for visitors, whatever is being worked on behind it.
      if (live && site.status !== 'revising') s = SITE_STATUS.published;
      ov.stampSlot.replaceChildren(s ? stamp(s.tone, s.label, s.icon, true) : '');
    });

    patch(ov, 'site', [siteUrl(), site.status, live, settled], function () {
      var row = addressRow(siteUrl());
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', live ? 'Your site’s address' : 'The address your site will have');
      var share = live ? shareButton('Share') : null;
      if (share) row.append(share);
      ov.site.replaceChildren(row);
      if (!live && settled) {
        ov.site.append(h('p', { class: 'fine' }, site.status === 'designing'
          ? 'Your site is still being designed. This will be its address.'
          : 'Not public yet. This will be your address once you publish.'));
      }
    });
  }

  /* What is waiting for the owner: enquiries to answer, changes to publish. */
  function renderAttention() {
    if (!ov || !state.site) return;
    var site = state.site;
    var counts = state.counts;
    var newCount = counts ? counts.new : 0;
    var top = state.leads.filter(function (l) { return l.status === 'new'; }).slice(0, 3);
    var tip = attentionTip();
    var live = isLive();
    var settled = siteSettled();
    var onlyNew = function () { state.filter = 'new'; };

    patch(ov, 'attention', [site.status, needsPublish(site), live, settled, state.leadsLoaded, state.leadsLoaded ? '' : state.leadsError, newCount, counts ? counts.total : 0, tip], function () {
      var rows = [];

      if (!settled) {
        /* nothing to say about the site until its details arrive */
      } else if (site.status === 'failed') {
        rows.push(attnRow('alert', 'alarm', 'The last change to your site didn’t work', 'Describe the change again and the assistant will have another go.', goLink('Website', '#/website')));
      } else if (site.status === 'designing') {
        rows.push(attnRow('half', 'neutral', 'Your site is being designed', 'You can publish it as soon as it is ready. This page updates on its own.', null));
      } else if (needsPublish(site) && !live) {
        rows.push(attnRow('alert', 'contacted', 'Your site isn’t public yet', 'Customers can’t find you until you publish it.', goLink('Review', '#/website', true)));
      } else if (needsPublish(site)) {
        rows.push(attnRow('alert', 'contacted', 'Your changes aren’t public yet', 'Visitors still see the older version. Publish to show them the new one.', goLink('Review', '#/website')));
      }

      if (!state.leadsLoaded && state.leadsError) {
        rows.push(attnRow('alert', 'alarm', 'We couldn’t check your enquiries', state.leadsError,
          h('button', { type: 'button', class: 'btn', onclick: function () { state.leadsError = null; renderAttention(); loadLeads(); } }, 'Try again')));
      } else if (newCount > 0) {
        rows.push(attnRow('dot', 'new',
          newCount === 1 ? '1 enquiry waiting for a reply' : fmt(newCount) + ' enquiries waiting for a reply',
          'The sooner you answer, the more likely they become customers.',
          goLink(newCount === 1 ? 'Reply' : 'See all', '#/leads', true, onlyNew)));
      }

      if (tip === 'contact') {
        rows.push(attnRow('phone', 'neutral', 'Visitors aren’t tapping call or WhatsApp', 'Ask the assistant to make your phone number easier to spot.', goLink('Website', '#/website')));
      }

      var title = h('h2', { class: 'sr-only', id: 'attn-title' }, 'Waiting for you');
      if (rows.length) {
        var box = h('div', { class: 'slip attn' });
        rows.forEach(function (r) { box.append(r); });
        ov.attention.replaceChildren(title, box);
      } else if (!state.leadsLoaded) {
        ov.attention.replaceChildren(title, h('p', { class: 'ov-quiet', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Checking your enquiries…'));
      } else {
        ov.attention.replaceChildren(title, h('p', { class: 'ov-quiet' }, icon('check', 'icon-sm'),
          counts && counts.total > 0 ? 'Nothing is waiting for you. Every enquiry has been answered.' : 'Nothing is waiting for you. When someone gets in touch, it shows up here.'));
      }
    });

    // The people behind that count, a tap away from their conversation.
    patch(ov, 'wait', [newCount, top.map(function (l) { return [l.id, l.name, summaryLine(l), l.createdAt, l.source]; })], function () {
      var list = h('ul', { class: 'lead-list' });
      top.forEach(function (lead) {
        var src = SOURCE[lead.source] || { label: 'Got in touch', icon: 'note' };
        list.append(h('li', { class: 'lead-row', 'data-status': 'new' },
          h('a', { class: 'lead-link', href: '#/leads/' + enc(lead.id), 'data-key': 'wait-' + lead.id },
            h('span', { class: 'row-top' },
              h('span', { class: 'row-name' }, leadName(lead)),
              timeEl(lead.createdAt, 'row-time')),
            h('span', { class: 'row-summary' }, summaryLine(lead)),
            h('span', { class: 'row-source' }, icon(src.icon), src.label))));
      });
      ov.waitCard.replaceChildren(
        h('div', { class: 'card-head' },
          h('h3', { class: 'card-title', id: 'wait-title' }, 'Waiting for a reply'),
          h('a', { class: 'linkish', href: '#/leads', 'data-key': 'wait-all', onclick: onlyNew }, newCount > top.length ? 'See all ' + fmt(newCount) : 'Open enquiries')),
        list);
    });

    var shown = top.length > 0;
    if (shown !== ov.waitShown) {
      ov.waitShown = shown;
      ov.bodySig = null;      // the card joins or leaves the cards below
      renderStats();
    }
    refreshTimes();
  }

  function attnRow(iconName, tone, title, text, action) {
    return h('div', { class: 'attn-row', 'data-tone': tone },
      h('span', { class: 'attn-mark' }, icon(iconName)),
      h('div', { class: 'attn-text' }, h('p', { class: 'attn-title' }, title), text ? h('p', { class: 'fine' }, text) : null),
      action ? h('div', { class: 'attn-action' }, action) : null);
  }

  // One nudge at most, and only when the numbers plainly point at it.
  function attentionTip() {
    var s = state.stats;
    if (!s || state.statsStatus === 'unavailable' || !isLive()) return '';
    var reached = 0;
    s.funnel.forEach(function (f) { if (f.key === 'reached_out') reached = f.count; });
    if (s.totals.visitors >= 20 && s.totals.contactClicks === 0 && reached === 0 && s.totals.enquiries === 0) return 'contact';
    return '';
  }

  /* The numbers. */

  function paintStatsBar() {
    if (!ov) return;
    PERIODS.forEach(function (n) { ov.radios[n].checked = n === state.statsDays; });
    var unavailable = state.statsStatus === 'unavailable';
    ov.periods.hidden = unavailable;
    // While another period is on its way, the old one stays on screen, dimmed.
    var waiting = statsLoading && !!state.stats && state.stats.days !== state.statsDays;
    if (waiting) ov.body.setAttribute('aria-busy', 'true'); else ov.body.removeAttribute('aria-busy');
    patch(ov, 'updated', [state.statsOkAt, unavailable], function () {
      ov.updated.replaceChildren();
      if (state.statsOkAt && !unavailable) append(ov.updated, ['Updated ', timeEl(state.statsOkAt)]);
    });
  }

  function emptyPeriod(s) {
    var t = s.totals;
    return !(t.views || t.visitors || t.engaged || t.contactClicks || t.assistantOpens || t.talks || t.enquiries) && s.recent.length === 0;
  }

  function renderStats() {
    if (!ov) return;
    paintStatsBar();
    var st = state.statsStatus;
    var s = state.stats;

    patch(ov, 'alert', st === 'stale' ? state.statsError : '', function () {
      if (st !== 'stale') { ov.alert.hidden = true; ov.alert.replaceChildren(); return; }
      ov.alert.hidden = false;
      ov.alert.replaceChildren(h('div', { class: 'notice', 'data-kind': 'error', role: 'status' }, icon('alert'),
        h('div', { class: 'notice-body' }, h('strong', null, 'These numbers may be out of date.'),
          h('span', null, state.statsError + ' ', h('button', { type: 'button', class: 'linkish', onclick: function () { loadStats(true); } }, 'Try now')))));
    });

    var data = null;
    if (s) { data = {}; Object.keys(s).forEach(function (k) { if (k !== 'updatedAt') data[k] = s[k]; }); }
    var counts = state.counts;
    var sig = JSON.stringify([s ? 'data' : st, s ? '' : state.statsError, data, siteUrl(), isLive(), ov.waitShown, st === 'unavailable' && counts ? counts.total : 0]);
    if (sig === ov.bodySig) { refreshTimes(); drawCharts(false); return; }
    ov.bodySig = sig;

    var active = document.activeElement;
    var focusKey = active && ov.body.contains(active) ? active.getAttribute('data-key') : null;
    ov.charts = [];
    var nodes = buildStatsBody();
    ov.body.replaceChildren();
    append(ov.body, nodes);
    drawCharts(true);
    // Whatever had focus was rebuilt: put focus back on its replacement, or on the section's heading.
    if (focusKey) focusEl(ov.body.querySelector('[data-key="' + focusKey + '"]') || ov.statsTitle, true);
    refreshTimes();
  }

  function drawCharts(force) {
    if (!ov) return;
    ov.charts.forEach(function (c) { c.draw(force); });
  }

  function buildStatsBody() {
    var st = state.statsStatus;
    var s = state.stats;
    var wait = ov.waitShown ? ov.waitCard : null;

    if (st === 'unavailable') {
      var counts = state.counts;
      return [h('div', { class: 'notice', role: 'status' }, icon('alert'),
        h('div', { class: 'notice-body' },
          h('strong', null, 'Visitor numbers aren’t available yet'),
          h('span', null, 'Counting views, visitors and taps needs an update that hasn’t reached your site yet. The numbers will appear here on their own. Your enquiries and your website controls work as usual.'),
          counts && counts.total > 0 ? h('span', null, 'So far you have had ' + plural(counts.total, 'enquiry', 'enquiries') + '. ', h('a', { class: 'linkish', href: '#/leads', 'data-key': 'all-enquiries' }, 'See them')) : null)),
        wait];
    }

    if (!s) {
      if (st === 'error') {
        return [h('div', { class: 'notice', 'data-kind': 'error', role: 'alert' }, icon('alert'),
          h('div', { class: 'notice-body' }, h('strong', null, 'We couldn’t load your numbers.'), h('span', null, state.statsError || ''),
            h('div', null, h('button', { type: 'button', class: 'linkish', 'data-key': 'retry', onclick: function () { state.statsStatus = 'loading'; state.statsError = null; renderStats(); loadStats(true); } }, 'Try again')))),
          wait];
      }
      var ghosts = h('div', { class: 'slip tiles', role: 'status', 'aria-label': 'Loading your numbers' });
      for (var g = 0; g < 6; g++) ghosts.append(h('div', { class: 'ghost' }, h('i'), h('i'), h('i')));
      return [ghosts, wait];
    }

    if (emptyPeriod(s)) return [s.previous.visitors > 0 ? buildLede(s) : null, buildFirstVisitors(s), wait];

    var grid = h('div', { class: 'ov-grid', 'data-wait': wait ? 'true' : 'false' },
      buildTrendCard(s), wait, buildFunnelCard(s), buildClicksCard(s), buildSectionsCard(s),
      buildSourcesCard(s), buildDevicesCard(s), buildHoursCard(s), buildAssistantCard(s), buildFeedCard(s));
    return [buildLede(s), buildTiles(s), buildCompareNote(s), grid];
  }

  function periodWords(s) { return 'the last ' + s.days + ' days'; }
  function beforeWords(s) { return 'the ' + s.days + ' days before'; }

  // One sentence that answers "is my site working?".
  function buildLede(s) {
    var t = s.totals;
    var p = s.previous;
    var el = h('p', { class: 'ov-lede' });
    if (t.visitors === 0) {
      append(el, ['Nobody visited your site in ' + periodWords(s) + '.',
        p.visitors > 0 ? ' In ' + beforeWords(s) + ', ' + plural(p.visitors, 'person', 'people') + ' did.' : '']);
      return el;
    }
    append(el, ['In ' + periodWords(s) + ', ', h('strong', null, plural(t.visitors, 'person', 'people')), ' visited your site',
      t.enquiries > 0 ? [' and ', h('strong', null, fmt(t.enquiries)), ' left an enquiry.'] : '. Nobody has left an enquiry yet.']);
    if (p.visitors > 0) {
      var change = Math.round((t.visitors - p.visitors) / p.visitors * 100);
      el.append(change === 0 ? ' That is about the same number of visitors as ' + beforeWords(s) + '.'
        : ' That is ' + fmt(Math.abs(change)) + '% ' + (change > 0 ? 'more' : 'fewer') + ' visitors than ' + beforeWords(s) + '.');
    }
    return el;
  }

  function buildDelta(cur, prev, s) {
    var el = h('p', { class: 'tile-delta' });
    if (!prev && !cur) { el.setAttribute('data-dir', 'none'); append(el, ['–', h('span', { class: 'sr-only' }, ' nothing to compare')]); return el; }
    if (!prev) { el.setAttribute('data-dir', 'up'); append(el, [icon('up'), 'New', h('span', { class: 'sr-only' }, ': none in ' + beforeWords(s))]); return el; }
    var change = Math.round((cur - prev) / prev * 100);
    if (change === 0) { el.setAttribute('data-dir', 'same'); append(el, ['Same', h('span', { class: 'sr-only' }, ' as ' + beforeWords(s))]); return el; }
    el.setAttribute('data-dir', change > 0 ? 'up' : 'down');
    append(el, [icon(change > 0 ? 'up' : 'down'), fmt(Math.abs(change)) + '%',
      h('span', { class: 'sr-only' }, (change > 0 ? ' more' : ' less') + ' than ' + beforeWords(s))]);
    return el;
  }

  function buildTiles(s) {
    var t = s.totals;
    var p = s.previous;
    var tiles = [
      { label: 'Visitors', value: t.visitors, prev: p.visitors, note: 'Different people who came' },
      { label: 'Views', value: t.views, prev: p.views, note: 'Times your pages were opened' },
      { label: 'Stayed and read', value: t.engaged, prev: p.engaged, note: t.engaged ? capFirst(perHundred(t.engagementRate)) : 'People who scrolled or stayed a while' },
      { label: 'Tapped to contact', value: t.contactClicks, prev: p.contactClicks, note: 'Call, WhatsApp, email or map' },
      { label: 'Talked to the assistant', value: t.talks, prev: p.talks, note: t.talks ? duration(t.talkSeconds) + ' of talking' : 'Conversations on your site' },
      { label: 'Enquiries', value: t.enquiries, prev: p.enquiries, note: t.enquiries ? capFirst(perHundred(t.conversionRate)) : 'Nobody has left one yet', href: '#/leads', linkLabel: 'See enquiries' }
    ];
    var list = h('ul', { class: 'slip tiles', 'aria-label': 'Totals for ' + periodWords(s) });
    tiles.forEach(function (tile) {
      var inner = [
        h('p', { class: 'tile-label' }, tile.label),
        h('div', { class: 'tile-figure' }, h('p', { class: 'tile-num' }, fmt(tile.value)), buildDelta(tile.value, tile.prev, s)),
        h('p', { class: 'tile-note' }, tile.note)];
      list.append(h('li', { class: 'tile' + (tile.href ? ' tile-linked' : '') }, tile.href
        ? h('a', { class: 'tile-link', href: tile.href }, inner, h('span', { class: 'tile-go' }, tile.linkLabel, icon('go', 'icon-sm')))
        : inner));
    });
    return list;
  }

  function buildCompareNote(s) {
    var from = parseDay(s.from);
    var text = 'Arrows compare with ' + beforeWords(s);
    if (from) {
      var prevTo = new Date(from.getTime() - 86400000);
      var prevFrom = new Date(from.getTime() - s.days * 86400000);
      text += ' (' + dayLabel(prevFrom) + ' to ' + dayLabel(prevTo) + ')';
    }
    return h('p', { class: 'fine ov-compare' }, text + '.');
  }

  function card(key, title, kids, wide) {
    var id = nextId('card');
    var el = h('section', { class: 'slip slip-pad card' + (wide ? ' card-' + wide : ''), 'aria-labelledby': id, 'data-card': key },
      h('h3', { class: 'card-title', id: id }, title));
    append(el, kids);
    return el;
  }

  // Ranked rows: a name, a number, and a thin bar for a quick comparison.
  // opts: { unit: [one, many], share: true to add "46%", icons: { label: iconName }, keepOrder, base }
  function rankList(items, opts) {
    opts = opts || {};
    var rows = items.filter(function (x) { return x.count > 0 || opts.keepOrder; });
    if (!opts.keepOrder) rows = rows.slice().sort(function (a, b) { return b.count - a.count; });
    if (!opts.keepOrder && rows.length > 6) {
      var rest = rows.slice(5);
      rows = rows.slice(0, 5);
      rows.push({ label: 'Everything else', count: rest.reduce(function (n, x) { return n + x.count; }, 0) });
    }
    var total = rows.reduce(function (n, x) { return n + x.count; }, 0);
    var base = opts.base || Math.max.apply(null, rows.map(function (x) { return x.count; }).concat([1]));
    var list = h(opts.keepOrder ? 'ol' : 'ul', { class: 'rank' });
    rows.forEach(function (row) {
      var fill = h('i');
      fill.style.width = (row.count > 0 ? Math.max(1.5, Math.min(100, row.count / base * 100)) : 0) + '%';
      var value = [h('strong', { class: 'num' }, fmt(row.count))];
      if (opts.unit) value.push(h('span', { class: 'sr-only' }, ' ' + (Math.round(row.count) === 1 ? opts.unit[0] : opts.unit[1])));
      if (opts.share && total > 0) value.push(h('span', { class: 'rank-share num' }, Math.round(row.count / total * 100) + '%'));
      list.append(h('li', { class: 'rank-row' },
        h('span', { class: 'rank-label' }, row.icon ? icon(row.icon, 'icon-sm') : null, h('span', null, row.label)),
        h('span', { class: 'rank-val' }, value),
        h('span', { class: 'rank-bar', 'aria-hidden': 'true' }, fill),
        row.note ? h('span', { class: 'rank-note' }, row.note) : null));
    });
    return list;
  }

  function emptyLine(text) { return h('p', { class: 'fine card-empty' }, text); }

  function buildFunnelCard(s) {
    var steps = s.funnel;
    var first = steps.length ? steps[0].count : 0;
    if (!steps.length || first === 0) {
      return card('funnel', 'From visitor to enquiry', [emptyLine('Once people visit, this shows how many stay, how many reach out, and how many leave an enquiry.')]);
    }
    var rows = steps.map(function (step, i) {
      return { label: step.label, count: step.count, note: i === 0 ? null : capFirst(perHundred(step.count / first)) };
    });
    var kids = [h('p', { class: 'fine' }, 'How far people got, out of everyone who visited.'),
      rankList(rows, { keepOrder: true, base: first, unit: ['person', 'people'] })];
    if (s.totals.avgSeconds > 0) kids.push(h('p', { class: 'fine' }, 'A typical visit lasts about ' + duration(s.totals.avgSeconds) + '.'));
    return card('funnel', 'From visitor to enquiry', kids);
  }

  function buildClicksCard(s) {
    var rows = s.clicks.map(function (c) { return { label: c.label, count: c.count, icon: CLICK_ICON[c.kind] || 'tap' }; });
    var any = rows.some(function (r) { return r.count > 0; });
    return card('clicks', 'What people tapped', any
      ? [rankList(rows, { unit: ['tap', 'taps'] })]
      : [emptyLine('Nobody has tapped a button in this period. Calls, WhatsApp chats and directions show up here when they do.')]);
  }

  function buildSectionsCard(s) {
    var any = s.sections.some(function (r) { return r.count > 0; });
    return card('sections', 'Parts of your page people saw', any
      ? [h('p', { class: 'fine' }, 'Fewer people reach the parts lower down the page.'), rankList(s.sections, { keepOrder: true, unit: ['time', 'times'] })]
      : [emptyLine('This shows how far down your page people scroll, part by part.')]);
  }

  function buildSourcesCard(s) {
    var any = s.sources.some(function (r) { return r.count > 0; });
    var kids = any ? [rankList(s.sources, { share: true, unit: ['visitor', 'visitors'] })]
      : [emptyLine('This shows where your visitors found your link: WhatsApp, Google, Instagram and so on.')];
    if (any && s.sources.some(function (r) { return r.count > 0 && /^direct$/i.test(r.label); })) {
      kids.push(h('p', { class: 'fine' }, '“Direct” means they opened your link itself, for example from a message or a visiting card.'));
    }
    return card('sources', 'Where visitors came from', kids);
  }

  function buildDevicesCard(s) {
    var d = s.devices;
    var total = d.mobile + d.desktop + d.tablet;
    if (!total) return card('devices', 'Phone or computer', [emptyLine('This shows whether people open your site on a phone, a tablet or a computer.')]);
    var rows = [{ label: 'Phone', count: d.mobile, icon: 'smartphone' }, { label: 'Computer', count: d.desktop, icon: 'desktop' }, { label: 'Tablet', count: d.tablet, icon: 'tablet' }];
    var top = rows.slice().sort(function (a, b) { return b.count - a.count; })[0];
    return card('devices', 'Phone or computer', [
      h('p', { class: 'fine' }, 'Most of your visitors (' + Math.round(top.count / total * 100) + ' of every 100) use a ' + top.label.toLowerCase() + '.'),
      rankList(rows, { share: true, unit: ['visitor', 'visitors'] })]);
  }

  function buildAssistantCard(s) {
    var t = s.totals;
    if (!t.talks) {
      return card('assistant', 'Assistant conversations', [emptyLine(t.assistantOpens > 0
        ? 'People opened the assistant ' + plural(t.assistantOpens, 'time', 'times') + ' in this period, but nobody started talking.'
        : 'Nobody has talked to the assistant in this period. It sits in the corner of your site and answers questions for you, day and night.')]);
    }
    var facts = h('dl', { class: 'mini-facts' },
      h('div', null, h('dt', null, 'Conversations'), h('dd', null, fmt(t.talks))),
      h('div', null, h('dt', null, 'Time spent talking'), h('dd', null, duration(t.talkSeconds))),
      h('div', null, h('dt', null, 'A typical conversation'), h('dd', null, duration(t.talkSeconds / t.talks))));
    var kids = [facts];
    if (t.assistantOpens > 0) kids.push(h('p', { class: 'fine' }, 'The assistant was opened ' + plural(t.assistantOpens, 'time', 'times') + '.'));
    var langs = s.languages.filter(function (l) { return l.count > 0; }).map(function (l) { return { label: langName(l.lang), count: l.count }; });
    if (langs.length) kids.push(h('h4', { class: 'section-title' }, 'Languages spoken'), rankList(langs, { share: langs.length > 1, unit: ['conversation', 'conversations'] }));
    return card('assistant', 'Assistant conversations', kids);
  }

  function buildFeedCard(s) {
    if (!s.recent.length) return card('feed', 'Latest activity', [emptyLine('Visits, taps, conversations and enquiries appear here as they happen.')], 'feed');
    var PEEK = 6;
    var open = !!ov.open.feed;
    var list = h('ol', { class: 'feed' });
    (open ? s.recent : s.recent.slice(0, PEEK)).forEach(function (item) {
      list.append(h('li', { class: 'feed-row', 'data-type': item.type },
        h('span', { class: 'feed-mark' }, icon(FEED_ICON[item.type] || 'dot', 'icon-sm')),
        h('span', { class: 'feed-text' }, item.text),
        timeEl(item.at, 'feed-time')));
    });
    var kids = [list];
    if (s.recent.length > PEEK) {
      kids.push(h('button', { type: 'button', class: 'btn btn-block', 'aria-expanded': open ? 'true' : 'false', 'data-key': 'feed-toggle', onclick: function () {
        ov.open.feed = !open;
        ov.bodySig = null;
        renderStats();
      } }, open ? 'Show less' : 'Show all ' + s.recent.length));
    }
    return card('feed', 'Latest activity', kids, 'feed');
  }

  // No visits in this period: say what will show up here, and how to get the first visitors.
  function buildFirstVisitors(s) {
    var live = isLive();
    var slip = h('div', { class: 'slip blank-slip' },
      h('p', { class: 'blank-eyebrow' }, 'No visitors in ' + periodWords(s)),
      h('h3', { class: 'blank-title' }, live ? 'Share your address to bring people in' : 'Your numbers start once your site is public'),
      h('ul', { class: 'blank-lines' },
        h('li', null, icon('eye'), h('span', null, 'How many people open your site each day, and how many stay to read it.')),
        h('li', null, icon('tap'), h('span', null, 'Which buttons they tap: call, WhatsApp, directions.')),
        h('li', null, icon('mic'), h('span', null, 'Their conversations with your site’s assistant, and the enquiries they leave.'))));
    if (live) {
      slip.append(
        h('p', { class: 'fine' }, 'Send your address to your customers on WhatsApp, print it on your bills and visiting card, and add it to your Google and Instagram profiles.'),
        addressRow(siteUrl()));
      var share = shareButton('Share your site', true);
      if (share) { share.classList.add('btn-block'); slip.append(share); }
    } else {
      slip.append(
        h('p', { class: 'fine' }, 'Visitors can only find your site after you publish it.'),
        h('a', { class: 'btn btn-primary btn-block', href: '#/website', 'data-key': 'to-website' }, 'Review and publish', icon('go', 'icon-sm')));
    }
    if (s.days < 90) {
      slip.append(h('p', { class: 'fine' }, h('button', { type: 'button', class: 'linkish', 'data-key': 'longer', onclick: function () { setPeriod(90); } }, 'Look at the last 90 days instead')));
    }
    return slip;
  }

  /* Charts: drawn here as plain SVG, sized to the space they get. */

  var SVG_NS = 'http://www.w3.org/2000/svg';
  function sv(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { if (attrs[k] != null) el.setAttribute(k, String(attrs[k])); });
    for (var i = 2; i < arguments.length; i++) if (arguments[i] != null) el.append(arguments[i]);
    return el;
  }

  // A round number at or above v whose half is also round, for a three-line scale.
  function niceMax(v) {
    if (v <= 4) return 4;
    var p = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : n <= 6 ? 6 : n <= 8 ? 8 : 10) * p;
  }

  function r1(n) { return Math.round(n * 10) / 10; }

  // A chart you can run a finger, a mouse or the arrow keys along. The reading under it
  // is written out in words, so nothing is only there on hover.
  // cfg: { key, label, count, idle, tall, height(W), paint(svg, W, H) -> geom { nearest(px) }, mark(layer, i, geom), read(i) -> nodes }
  function scrubChart(cfg) {
    var plot = h('div', { class: 'chart-plot' });
    var readout = h('p', { class: 'chart-readout' + (cfg.tall ? ' chart-readout-tall' : ''), 'aria-live': 'polite' });
    var wrap = h('div', { class: 'chart', tabindex: '0', role: 'group', 'aria-label': cfg.label, 'data-key': cfg.key }, plot, readout);
    var sel = -1;
    var geom = null;
    var layer = null;
    var lastW = 0;

    function show(i) {
      sel = i;
      if (layer && geom) { layer.replaceChildren(); if (i >= 0) cfg.mark(layer, i, geom); }
      readout.replaceChildren();
      var parts = i >= 0 ? cfg.read(i).filter(Boolean) : [cfg.idle];
      parts.forEach(function (part, k) {
        // Spoken as "Mon 9 Nov, 15 views, 11 visitors"; the commas are not needed by eye.
        if (k) readout.append(h('i', { class: 'sr-only' }, ', '));
        append(readout, [part]);
      });
      readout.setAttribute('data-idle', i >= 0 ? 'false' : 'true');
    }

    function draw(force) {
      var W = Math.floor(plot.clientWidth);
      if (!W || (!force && W === lastW)) return;
      lastW = W;
      var H = cfg.height(W);
      var svg = sv('svg', { class: 'chart-svg', viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, 'aria-hidden': 'true', focusable: 'false' });
      geom = cfg.paint(svg, W, H);
      layer = sv('g');
      svg.append(layer);
      plot.replaceChildren(svg);
      show(sel);
    }

    function at(e) {
      if (!geom) return;
      show(geom.nearest(e.clientX - plot.getBoundingClientRect().left));
    }
    plot.addEventListener('pointerdown', at);
    plot.addEventListener('pointermove', function (e) { if (e.pointerType === 'mouse' || e.buttons) at(e); });
    plot.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse' && document.activeElement !== wrap) show(-1); });
    wrap.addEventListener('keydown', function (e) {
      var last = cfg.count - 1;
      var next = null;
      if (e.key === 'ArrowLeft') next = sel < 0 ? last : Math.max(0, sel - 1);
      else if (e.key === 'ArrowRight') next = sel < 0 ? 0 : Math.min(last, sel + 1);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = last;
      else if (e.key === 'Escape' && sel >= 0) next = -1;
      if (next === null || last < 0) return;
      e.preventDefault();
      show(next);
    });

    show(-1);
    return { el: wrap, draw: draw };
  }

  // The same numbers as rows, for anyone who would rather read than look.
  function dataTable(key, caption, heads, rows) {
    var table = h('table', { class: 'data-table' }, h('caption', { class: 'sr-only' }, caption),
      h('thead', null, h('tr', null, heads.map(function (x, i) { return h('th', { scope: 'col', class: i ? 'num' : null }, x); }))));
    var body = h('tbody');
    rows.forEach(function (cells) {
      body.append(h('tr', null, cells.map(function (c, i) { return i === 0 ? h('th', { scope: 'row' }, c) : h('td', { class: 'num' }, c); })));
    });
    table.append(body);
    var det = h('details', { class: 'chart-table' },
      h('summary', { 'data-key': key }, 'See these numbers as a table'),
      h('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': caption }, table));
    det.open = !!ov.open[key];
    det.addEventListener('toggle', function () { ov.open[key] = det.open; });
    return det;
  }

  function legendItem(kind, label) {
    return h('li', null, h('span', { class: 'key key-' + kind, 'aria-hidden': 'true' }), label);
  }

  function buildTrendCard(s) {
    var daily = s.daily;
    var n = daily.length;
    if (!n) return card('trend', 'Day by day', [emptyLine('Your daily views and visitors will be drawn here.')], 'wide');
    var top = niceMax(Math.max.apply(null, daily.map(function (d) { return Math.max(d.views, d.visitors); })));
    var enquiryDays = daily.filter(function (d) { return d.enquiries > 0; }).length;

    var chart = scrubChart({
      key: 'trend', count: n,
      label: 'Chart of views and visitors for each of ' + periodWords(s) + '. Use the left and right arrow keys to read one day at a time.',
      idle: 'Tap or move along the chart to read one day.', tall: true,
      height: function (W) { return W >= 560 ? 240 : 200; },
      paint: function (svg, W, H) {
        var padX = 10, padTop = 18, rug = 18, axis = 18;
        var base = H - axis - rug;
        var plotW = W - padX * 2;
        var plotH = base - padTop;
        var x = function (i) { return r1(padX + (n <= 1 ? plotW / 2 : i * plotW / (n - 1))); };
        var y = function (v) { return r1(base - (v / top) * plotH); };
        var rugY = base + rug / 2 + 1;

        [top, top / 2, 0].forEach(function (tick) {
          svg.append(sv('line', { class: tick ? 'chart-grid' : 'chart-base', x1: 0, x2: W, y1: Math.round(y(tick)) + 0.5, y2: Math.round(y(tick)) + 0.5 }));
          if (tick) svg.append(sv('text', { class: 'chart-tick', x: 0, y: Math.round(y(tick)) - 4 }, fmt(tick)));
        });

        var path = function (key) { return daily.map(function (d, i) { return (i ? 'L' : 'M') + x(i) + ' ' + y(d[key]); }).join(''); };
        if (n > 1) {
          svg.append(
            sv('path', { class: 'chart-area', d: path('visitors') + 'L' + x(n - 1) + ' ' + base + 'L' + x(0) + ' ' + base + 'Z' }),
            sv('path', { class: 'chart-line line-views', d: path('views') }),
            sv('path', { class: 'chart-line line-visitors', d: path('visitors') }));
        } else {
          svg.append(sv('circle', { class: 'chart-dot dot-views', cx: x(0), cy: y(daily[0].views), r: 4.5 }),
            sv('circle', { class: 'chart-dot dot-visitors', cx: x(0), cy: y(daily[0].visitors), r: 4.5 }));
        }

        daily.forEach(function (d, i) {
          if (d.enquiries > 0) svg.append(sv('circle', { class: 'chart-dot dot-enquiry', cx: x(i), cy: rugY, r: n > 45 ? 3.5 : 4.5 }));
        });

        var labels = n >= 3 && W >= 260 ? [0, Math.floor((n - 1) / 2), n - 1] : n >= 2 ? [0, n - 1] : [0];
        labels.forEach(function (i, k) {
          var edge = labels.length > 1 && (k === 0 || k === labels.length - 1);
          svg.append(sv('text', { class: 'chart-tick', y: H - 3,
            x: !edge ? x(i) : k === 0 ? 0 : W,
            'text-anchor': !edge ? 'middle' : k === 0 ? 'start' : 'end' }, dayLabel(daily[i].date)));
        });

        return { x: x, y: y, base: base, top: padTop, rugY: rugY,
          nearest: function (px) { return n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round((px - padX) / (plotW / (n - 1))))); } };
      },
      mark: function (layer, i, g) {
        var d = daily[i];
        layer.append(
          sv('line', { class: 'chart-cursor', x1: g.x(i), x2: g.x(i), y1: g.top - 6, y2: g.rugY + 8 }),
          sv('circle', { class: 'chart-dot dot-views', cx: g.x(i), cy: g.y(d.views), r: 4.5 }),
          sv('circle', { class: 'chart-dot dot-visitors', cx: g.x(i), cy: g.y(d.visitors), r: 4.5 }));
      },
      read: function (i) {
        var d = daily[i];
        return [h('strong', null, dayLabel(d.date, true)),
          h('span', null, h('span', { class: 'key key-views', 'aria-hidden': 'true' }), plural(d.views, 'view', 'views')),
          h('span', null, h('span', { class: 'key key-visitors', 'aria-hidden': 'true' }), plural(d.visitors, 'visitor', 'visitors')),
          d.enquiries > 0 ? h('span', null, h('span', { class: 'key key-enquiry', 'aria-hidden': 'true' }), plural(d.enquiries, 'enquiry', 'enquiries')) : null];
      }
    });
    ov.charts.push(chart);

    var best = daily.reduce(function (a, d) { return d.visitors > a.visitors ? d : a; }, daily[0]);
    var rows = daily.slice().reverse().map(function (d) { return [dayLabel(d.date, true), fmt(d.views), fmt(d.visitors), fmt(d.enquiries)]; });
    return card('trend', 'Day by day', [
      best.visitors > 0 ? h('p', { class: 'fine' }, 'Your busiest day was ' + dayLabel(best.date, true) + ', with ' + plural(best.visitors, 'visitor', 'visitors') + '.'
        + (enquiryDays ? ' Enquiries came in on ' + plural(enquiryDays, 'day', 'days') + '.' : '')) : null,
      h('ul', { class: 'chart-legend' }, legendItem('views', 'Views'), legendItem('visitors', 'Visitors'), legendItem('enquiry', 'A day with an enquiry')),
      chart.el,
      dataTable('trend-table', 'Views, visitors and enquiries for each day, newest first', ['Day', 'Views', 'Visitors', 'Enquiries'], rows)
    ], 'wide');
  }

  function buildHoursCard(s) {
    var hours = s.hours;
    var total = hours.reduce(function (a, b) { return a + b; }, 0);
    if (!total) return card('hours', 'Busiest time of day', [emptyLine('This shows what time of day people visit, so you know when to be near your phone.')]);
    var peak = 0;
    hours.forEach(function (v, i) { if (v > hours[peak]) peak = i; });
    // A second busy spell, if there is one well away from the first.
    var second = -1;
    hours.forEach(function (v, i) {
      var gap = Math.min(Math.abs(i - peak), 24 - Math.abs(i - peak));
      if (gap >= 4 && v >= hours[peak] * 0.7 && (second < 0 || v > hours[second])) second = i;
    });
    var top = niceMax(hours[peak]);
    var tz = timezoneName(s.timezone);

    var chart = scrubChart({
      key: 'hours', count: 24,
      label: 'Chart of visitors by hour of the day. Use the left and right arrow keys to read one hour at a time.',
      idle: 'Tap or move along the chart to read one hour.' + (tz ? ' Hours are in ' + tz + '.' : ''),
      height: function () { return 150; },
      paint: function (svg, W, H) {
        var padTop = 18, axis = 18;
        var base = H - axis;
        var band = W / 24;
        var bw = Math.max(3, Math.min(14, Math.floor(band) - 2));
        var bar = function (i, cls) {
          var v = hours[i];
          var bh = v > 0 ? Math.max(2, (v / top) * (base - padTop)) : 0;
          var x0 = r1(i * band + (band - bw) / 2);
          var rr = Math.min(4, bw / 2, bh);
          if (!bh) return sv('rect', { class: cls + ' bar-none', x: x0, y: base - 1, width: bw, height: 1 });
          return sv('path', { class: cls, d: 'M' + x0 + ' ' + base + 'V' + r1(base - bh + rr) + 'Q' + x0 + ' ' + r1(base - bh) + ' ' + r1(x0 + rr) + ' ' + r1(base - bh)
            + 'H' + r1(x0 + bw - rr) + 'Q' + r1(x0 + bw) + ' ' + r1(base - bh) + ' ' + r1(x0 + bw) + ' ' + r1(base - bh + rr) + 'V' + base + 'Z' });
        };
        var topY = Math.round(base - (base - padTop)) + 0.5;
        svg.append(sv('line', { class: 'chart-grid', x1: 0, x2: W, y1: topY, y2: topY }), sv('text', { class: 'chart-tick', x: 0, y: topY - 4 }, fmt(top)),
          sv('line', { class: 'chart-base', x1: 0, x2: W, y1: base + 0.5, y2: base + 0.5 }));
        for (var i = 0; i < 24; i++) if (hours[i] > 0) svg.append(bar(i, 'chart-bar'));
        [0, 6, 12, 18].forEach(function (i) {
          svg.append(sv('text', { class: 'chart-tick', y: H - 3, x: i === 0 ? 0 : r1(i * band + band / 2), 'text-anchor': i === 0 ? 'start' : 'middle' }, hourLabel(i)));
        });
        return { bar: bar, nearest: function (px) { return Math.max(0, Math.min(23, Math.floor(px / band))); } };
      },
      mark: function (layer, i, g) { layer.append(g.bar(i, 'chart-bar bar-on')); },
      read: function (i) { return [h('strong', null, hourLabel(i) + ' to ' + hourLabel(i + 1)), h('span', null, plural(hours[i], 'visitor', 'visitors'))]; }
    });
    ov.charts.push(chart);

    var rows = hours.map(function (v, i) { return [hourLabel(i) + ' to ' + hourLabel(i + 1), fmt(v)]; });
    return card('hours', 'Busiest time of day', [
      h('p', { class: 'fine' }, 'Most people visit around ', h('strong', null, hourLabel(peak)), second >= 0 ? [', and again around ', h('strong', null, hourLabel(second))] : null,
        '. A good time to be near your phone.'),
      chart.el,
      dataTable('hours-table', 'Visitors for each hour of the day', ['Hour', 'Visitors'], rows)
    ]);
  }

  /* ------------------------------------------------------------------ */
  /* Leads: the list                                                     */
  /* ------------------------------------------------------------------ */

  function buildLeadsView() {
    var view = $('view-leads');
    ui.leadsTitle = h('h1', { class: 'page-title', id: 'leads-title', tabindex: '-1' }, 'Enquiries');
    ui.leadsTotal = h('p', { class: 'fine num' });
    ui.leadsAlert = h('div', { hidden: true });
    ui.tally = h('div', { class: 'tally slip', role: 'group', 'aria-label': 'Filter enquiries by status' });
    ui.tallyCells = {};
    STATUS_ORDER.forEach(function (s) {
      var num = h('span', { class: 'tally-num' }, '–');
      var cell = h('button', { type: 'button', class: 'tally-cell', 'data-tone': s, 'aria-pressed': 'false' },
        num, h('span', { class: 'tally-label' }, icon(STATUS[s].icon), STATUS[s].label));
      cell.addEventListener('click', function () {
        state.filter = state.filter === s ? 'all' : s;
        renderLeads();
        var shown = filteredLeads().length;
        announce(state.filter === 'all' ? 'Showing all enquiries.' : 'Showing ' + shown + ' ' + STATUS[s].label.toLowerCase() + (shown === 1 ? ' enquiry.' : ' enquiries.'));
      });
      ui.tallyCells[s] = { cell: cell, num: num };
      ui.tally.append(cell);
    });
    ui.filterLine = h('div', { class: 'filter-line', hidden: true });
    ui.leadsBody = h('div');
    ui.leadsPane = h('div', { class: 'leads-pane' },
      h('div', { class: 'leads-head' }, ui.leadsTitle, ui.leadsTotal),
      ui.leadsAlert, ui.tally, ui.filterLine, ui.leadsBody);
    ui.leadPane = h('div', { class: 'lead-pane' });
    view.replaceChildren(ui.leadsPane, ui.leadPane);
  }

  function filteredLeads() {
    if (state.filter === 'all') return state.leads;
    return state.leads.filter(function (l) { return l.status === state.filter; });
  }

  function summaryLine(lead) {
    if (lead.summary) return lead.summary;
    if (lead.message) return lead.message;
    for (var i = 0; i < lead.transcript.length; i++) if (lead.transcript[i].role === 'visitor') return lead.transcript[i].text;
    return 'No details were left.';
  }

  function rowLink(id) {
    var links = ui.leadsBody.querySelectorAll('a[data-id]');
    for (var i = 0; i < links.length; i++) if (links[i].getAttribute('data-id') === id) return links[i];
    return null;
  }

  function showAllButton(label) {
    return h('button', { type: 'button', class: 'linkish', onclick: function () {
      state.filter = 'all';
      renderLeads();
      announce('Showing all enquiries.');
      focusEl(ui.leadsTitle, true);
    } }, label);
  }

  function renderLeads() {
    if (!ui.leadsBody) return;
    var counts = state.counts;

    STATUS_ORDER.forEach(function (s) {
      var c = ui.tallyCells[s];
      var n = counts ? counts[s] : null;
      c.num.textContent = n == null ? '–' : String(n);
      c.cell.setAttribute('data-nonzero', n ? 'true' : 'false');
      c.cell.setAttribute('aria-pressed', state.filter === s ? 'true' : 'false');
    });

    ui.leadsTotal.textContent = counts ? (counts.total === 1 ? '1 in total' : counts.total + ' in total') : '';

    var badge = $('nav-badge');
    if (counts && counts.new > 0) {
      badge.hidden = false;
      badge.replaceChildren(String(counts.new > 99 ? '99+' : counts.new), h('span', { class: 'sr-only' }, ' new'));
    } else { badge.hidden = true; }

    // A failed refresh keeps the old list on screen and says so, quietly.
    var alertSig = state.leadsError && state.leadsLoaded ? state.leadsError : '';
    if (ui.alertSig !== alertSig) {
      ui.alertSig = alertSig;
      if (alertSig) {
        ui.leadsAlert.hidden = false;
        ui.leadsAlert.replaceChildren(h('div', { class: 'notice', 'data-kind': 'error', role: 'status' }, icon('alert'),
          h('div', { class: 'notice-body' }, h('strong', null, 'This list may be out of date.'),
            h('span', null, alertSig + ' ', h('button', { type: 'button', class: 'linkish', onclick: function () { loadLeads(); } }, 'Try now')))));
      } else { ui.leadsAlert.hidden = true; ui.leadsAlert.replaceChildren(); }
    }

    var filterSig = state.filter + '|' + (counts ? counts.total : '');
    if (ui.filterSig !== filterSig) {
      ui.filterSig = filterSig;
      if (state.filter === 'all') { ui.filterLine.hidden = true; ui.filterLine.replaceChildren(); }
      else {
        ui.filterLine.hidden = false;
        ui.filterLine.replaceChildren(
          h('span', null, 'Showing ', h('strong', null, STATUS[state.filter].label.toLowerCase()), ' only'),
          showAllButton(counts ? 'Show all ' + counts.total : 'Show all'));
      }
    }

    var visible = filteredLeads();
    var sig = JSON.stringify([state.leadsLoaded, state.leadsLoaded ? '' : state.leadsError, state.filter, siteUrl(),
      visible.map(function (l) { return [l.id, l.name, l.source, l.status, l.createdAt, summaryLine(l)]; })]);
    if (sig !== ui.listSig) {
      ui.listSig = sig;
      var active = document.activeElement;
      var focusedId = active && ui.leadsBody.contains(active) ? active.getAttribute('data-id') : null;
      ui.leadsBody.replaceChildren(buildListBody(visible));
      if (focusedId) focusEl(rowLink(focusedId) || ui.leadsTitle, true);
    }

    var links = ui.leadsBody.querySelectorAll('a[data-id]');
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute('data-id') === state.leadId) links[i].setAttribute('aria-current', 'true');
      else links[i].removeAttribute('aria-current');
    }

    ui.leadsPane.parentNode.setAttribute('data-open', state.leadId ? 'true' : 'false');
    refreshTimes();
  }

  function buildListBody(visible) {
    if (!state.leadsLoaded) {
      if (state.leadsError) {
        return h('div', { class: 'notice', 'data-kind': 'error', role: 'alert' }, icon('alert'),
          h('div', { class: 'notice-body' }, h('strong', null, 'We couldn’t load your enquiries.'), h('span', null, state.leadsError),
            h('div', null, h('button', { type: 'button', class: 'linkish', onclick: function () { state.leadsError = null; renderLeads(); loadLeads(); } }, 'Try again'))));
      }
      var ghosts = h('div', { class: 'slip lead-list', role: 'status', 'aria-label': 'Loading your enquiries' });
      for (var g = 0; g < 4; g++) ghosts.append(h('div', { class: 'ghost' }, h('i'), h('i'), h('i')));
      return ghosts;
    }

    if (state.leads.length === 0) return buildTeachingSlip();

    if (visible.length === 0) {
      return h('div', { class: 'slip slip-pad stack-tight' },
        h('p', null, 'No enquiries are marked ' + STATUS[state.filter].label.toLowerCase() + ' right now.'),
        h('p', { class: 'fine' }, state.filter === 'new'
          ? 'You’re all caught up. New conversations appear here on their own.'
          : 'Open an enquiry and change its status to move it here.'),
        h('div', null, showAllButton('Show all enquiries')));
    }

    var list = h('ul', { class: 'slip lead-list', 'aria-label': state.filter === 'all' ? 'All enquiries, newest first' : STATUS[state.filter].label + ' enquiries, newest first' });
    visible.forEach(function (lead) {
      var src = SOURCE[lead.source] || { label: 'Got in touch', icon: 'note' };
      list.append(h('li', { class: 'lead-row', 'data-status': lead.status },
        h('a', { class: 'lead-link', href: '#/leads/' + enc(lead.id), 'data-id': lead.id },
          h('span', { class: 'row-top' },
            h('span', { class: 'row-name' }, leadName(lead)),
            timeEl(lead.createdAt, 'row-time')),
          h('span', { class: 'row-summary' }, summaryLine(lead)),
          h('span', { class: 'row-foot' },
            h('span', { class: 'row-source' }, icon(src.icon), src.label),
            statusStamp(lead.status)))));
    });
    return list;
  }

  // No leads yet: say what will show up here and give the owner the thing to share.
  function buildTeachingSlip() {
    var url = siteUrl();
    var slip = h('div', { class: 'slip blank-slip' },
      h('p', { class: 'blank-eyebrow' }, 'Nobody yet'),
      h('h2', { class: 'blank-title' }, 'This is where your customers’ messages land'),
      h('ul', { class: 'blank-lines' },
        h('li', null, icon('mic'), h('span', null, 'When a visitor talks to the assistant on your site, the conversation appears here with a short summary.')),
        h('li', null, icon('note'), h('span', null, 'When someone leaves a message, you get their name and how to reach them.')),
        h('li', null, icon('phone'), h('span', null, 'From each one you can call, text, or have the assistant call them back.'))),
      h('p', { class: 'fine' }, 'The more people see your site, the sooner this fills up. Share your address:'),
      addressRow(url));
    var href = safeUrl(url);
    if (href && typeof navigator.share === 'function') {
      slip.append(h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: function () {
        navigator.share({ title: siteName(), url: href }).catch(function () { /* the owner closed the share sheet */ });
      } }, icon('share'), 'Share your site'));
    }
    return slip;
  }

  /* ------------------------------------------------------------------ */
  /* Leads: one lead                                                     */
  /* ------------------------------------------------------------------ */

  function renderLeadPane() {
    if (!ui.leadPane) return;
    var id = state.leadId;

    if (!id) {
      if (ui.paneMode !== 'rest') {
        ui.paneMode = 'rest'; detail = null;
        ui.leadPane.replaceChildren(h('p', { class: 'lead-rest' }, 'Choose an enquiry to read the conversation and reply.'));
      }
      return;
    }

    var lead = findLead(id);
    if (!lead) {
      var mode = state.leadsLoaded ? 'missing:' + id : 'loading:' + id;
      if (ui.paneMode !== mode) {
        ui.paneMode = mode; detail = null;
        ui.leadPane.replaceChildren(backBar(), state.leadsLoaded
          ? h('div', { class: 'slip lead-missing' },
              h('h2', { class: 'blank-title', tabindex: '-1', 'data-focus': true }, 'This enquiry isn’t here any more'),
              h('p', { class: 'lede' }, 'It may have been removed, or the link is from another site.'),
              h('a', { class: 'btn', href: '#/leads' }, 'Back to all enquiries'))
          : h('div', { class: 'slip lead-list', role: 'status', 'aria-label': 'Loading this enquiry' }, h('div', { class: 'ghost' }, h('i'), h('i'), h('i'))));
      }
      return;
    }

    if (!detail || detail.id !== id) {
      ui.paneMode = 'lead:' + id;
      detail = buildDetail(lead);
      ui.leadPane.replaceChildren.apply(ui.leadPane, detail.nodes);
    }
    updateDetail(detail, lead);
    updateTitle();
  }

  function backBar() {
    return h('div', { class: 'back-bar' }, h('a', { class: 'btn btn-quiet', href: '#/leads' }, icon('back'), 'Enquiries'));
  }

  function patch(d, key, value, fn) {
    var sig = JSON.stringify(value);
    if (d.sig[key] === sig) return;
    d.sig[key] = sig;
    fn();
  }

  // A labelled textarea with a submit button and a feedback line.
  // submit(text) resolves to { text, action } on success and throws on failure.
  // The typed text is kept as a draft until the server has accepted it.
  function composer(cfg) {
    var id = nextId('field');
    var textarea = h('textarea', { class: 'textarea', id: id, rows: cfg.rows || 3, placeholder: cfg.placeholder || null,
      'aria-describedby': cfg.hint ? id + '-hint' : null, maxlength: cfg.maxlength || null, enterkeyhint: 'enter' });
    textarea.value = state.drafts[cfg.draftKey] || '';
    var button = h('button', { type: 'submit', class: 'btn ' + (cfg.primary ? 'btn-primary' : '') }, cfg.submitLabel);
    var line = statusLine();
    var busy = false;
    var form = h('form', { class: 'block', novalidate: true },
      h('div', { class: 'field' },
        h('label', { class: cfg.labelClass || 'field-label', for: id }, cfg.label),
        cfg.hint ? h('p', { class: 'field-hint', id: id + '-hint' }, cfg.hint) : null,
        textarea),
      cfg.extra || null,
      h('div', { class: 'form-row' }, button, line));

    textarea.addEventListener('input', function () {
      setDraft(cfg.draftKey, textarea.value);
      if (line.getAttribute('data-kind') === 'error' || line.getAttribute('data-kind') === 'ok') setLine(line, null, '');
    });
    textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : button.click(); }
    });

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (busy || isOff(button)) return;
      var text = textarea.value.trim();
      if (!text) {
        setLine(line, 'error', cfg.emptyMessage || 'Write something first.');
        focusEl(textarea);
        return;
      }
      busy = true;
      textarea.readOnly = true;
      setBusy(button, true, cfg.busyLabel);
      setLine(line, 'pending', cfg.pendingMessage || cfg.busyLabel);
      try {
        var done = await cfg.submit(text);
        textarea.value = '';
        setDraft(cfg.draftKey, '');
        setLine(line, 'ok', done.text, done.action);
      } catch (err) {
        setLine(line, 'error', (cfg.failPrefix ? cfg.failPrefix + ' ' : '') + err.message + ' Your words are still here.');
      } finally {
        busy = false;
        textarea.readOnly = false;
        setBusy(button, false);
      }
    });

    return { form: form, textarea: textarea, button: button, line: line };
  }

  function buildDetail(lead) {
    var d = { id: lead.id, sig: {}, expanded: false, callState: 'idle', statusBusy: false, statusWant: null, radios: {} };

    // Who, how and when
    d.name = h('h2', { class: 'lead-name', id: 'lead-title', tabindex: '-1', 'data-focus': true });
    d.stampSlot = h('span');
    d.meta = h('p', { class: 'lead-meta' });
    var head = h('header', { class: 'lead-head enter' }, h('div', { class: 'lead-head-top' }, d.name, d.stampSlot), d.meta);

    // The slip: what they wanted
    d.outText = h('p', { class: 'out-text' });
    var slip = h('section', { class: 'slip out-slip enter', 'aria-label': 'Summary' },
      h('p', { class: 'out-eyebrow' }, 'While you were out'), d.outText);

    // How to reach them
    d.reach = h('section', { class: 'reach', 'aria-label': 'Contact details' });

    // Status
    var statusTitleId = nextId('status');
    var radioName = nextId('lead-status');
    d.statusLine = statusLine();
    var set = h('div', { class: 'status-set', role: 'radiogroup', 'aria-labelledby': statusTitleId });
    STATUS_ORDER.forEach(function (s) {
      var input = h('input', { type: 'radio', name: radioName, value: s });
      input.addEventListener('change', function () { if (input.checked) setStatus(d, s); });
      d.radios[s] = input;
      set.append(h('label', { class: 'status-opt' }, input, h('span', { class: 'status-face' }, icon(STATUS[s].icon), STATUS[s].label)));
    });
    var status = h('section', { class: 'block' }, h('h3', { class: 'section-title', id: statusTitleId }, 'Where this stands'), set, d.statusLine);

    // Conversation and original message
    d.talkSection = h('section', { class: 'block', hidden: true });
    d.messageSection = h('section', { class: 'block', hidden: true });

    // Notes
    d.notesList = h('div', { class: 'slot' });
    var notes = composer({
      label: 'Add a note', draftKey: 'note:' + lead.id, placeholder: 'Only you can see notes. For example: wants delivery on Saturday.',
      submitLabel: 'Save note', busyLabel: 'Saving…', emptyMessage: 'Write your note first.', failPrefix: 'The note was not saved.',
      submit: async function (text) {
        var res = await mutate(function () { return api('/leads/' + enc(d.id), { method: 'PATCH', body: { note: text } }); });
        applyLead(res.lead, d.id, function (l) { l.notes.push({ at: Date.now(), text: text, by: '' }); });
        return { text: 'Note saved.' };
      }
    });
    var notesSection = h('section', { class: 'block' }, h('h3', { class: 'section-title' }, 'Your notes'), d.notesList, notes.form);

    // Send a text
    d.sentList = h('div', { class: 'slot' });
    d.textNoPhone = h('div', { class: 'notice' }, icon('alert'),
      h('div', { class: 'notice-body' }, h('strong', null, 'No phone number was left'), h('span', null, 'Without a number there is nobody to text.')));
    d.textComposer = composer({
      label: 'Your message', draftKey: 'text:' + lead.id, placeholder: 'Hi, thanks for getting in touch…', maxlength: 1000,
      submitLabel: 'Send text', busyLabel: 'Sending…', primary: true, emptyMessage: 'Write your message first.', failPrefix: 'The text was not sent.',
      submit: async function (text) {
        var res = await mutate(function () {
          return api('/leads/' + enc(d.id) + '/message', { method: 'POST', body: { text: text },
            fallbacks: { 400: 'This enquiry has no phone number to text.', 502: 'The phone network turned the message down.' } });
        });
        applyLead(res.lead, d.id, function (l) { l.messages.push({ at: Date.now(), text: text, status: 'sent', channel: 'sms' }); });
        var now = findLead(d.id);
        return { text: 'Text sent' + (now && now.phone ? ' to ' + now.phone : '') + '.', action: nudgeContacted(d) };
      }
    });
    d.textHint = h('p', { class: 'fine' });
    var textSection = h('section', { class: 'block' }, h('h3', { class: 'section-title' }, 'Send a text'),
      d.sentList, d.textNoPhone, d.textHint, d.textComposer.form);

    // Call back
    d.callIntro = h('p', { class: 'fine' });
    d.callBtn = h('button', { type: 'button', class: 'btn btn-block' }, icon('phone'), 'Have the assistant call them back');
    d.callBtn.addEventListener('click', function () { if (!isOff(d.callBtn)) { d.callState = 'confirm'; setLine(d.callLine, null, ''); renderCall(d); focusEl(d.confirmTitle); } });
    d.confirmTitle = h('p', { class: 'confirm-title', tabindex: '-1' });
    d.confirmYes = h('button', { type: 'button', class: 'btn btn-primary' }, 'Yes, call now');
    d.confirmYes.addEventListener('click', function () { placeCall(d); });
    d.confirmNo = h('button', { type: 'button', class: 'btn', onclick: function () { cancelCall(d); } }, 'Not now');
    d.confirm = h('div', { class: 'slip confirm', role: 'group', 'aria-label': 'Confirm the call', hidden: true },
      d.confirmTitle,
      h('p', { class: 'fine' }, 'This places a real phone call straight away. The assistant speaks for your business; you don’t need to be on the line.'),
      h('div', { class: 'confirm-actions' }, d.confirmNo, d.confirmYes));
    d.callLine = statusLine();
    d.callSection = h('section', { class: 'block' }, h('h3', { class: 'section-title' }, 'Call back'), d.callIntro, d.callBtn, d.confirm, d.callLine);

    d.nodes = [backBar(), head, slip, d.reach, status, d.talkSection, d.messageSection, notesSection, textSection, d.callSection];
    return d;
  }

  function nudgeContacted(d) {
    var lead = findLead(d.id);
    if (!lead || lead.status !== 'new') return null;
    return h('button', { type: 'button', class: 'linkish', onclick: function (e) {
      e.currentTarget.remove();
      d.radios.contacted.checked = true;
      setStatus(d, 'contacted');
    } }, 'Mark as contacted');
  }

  function updateDetail(d, lead) {
    var who = leadName(lead);
    var src = SOURCE[lead.source] || { label: 'Got in touch', icon: 'note' };
    var tel = telHref(lead.phone);

    patch(d, 'head', [lead.name, lead.source, lead.createdAt], function () {
      d.name.textContent = who;
      d.meta.replaceChildren(h('span', null, icon(src.icon), src.label), timeEl(lead.createdAt) || '',
        validTime(lead.createdAt) ? h('span', { class: 'num' }, fullTime(lead.createdAt)) : '');
    });

    patch(d, 'stamp', lead.status, function () { d.stampSlot.replaceChildren(statusStamp(lead.status, true)); });

    patch(d, 'summary', lead.summary, function () {
      d.outText.textContent = lead.summary || 'No summary was written for this one. The conversation and message below have the details.';
      d.outText.setAttribute('data-empty', lead.summary ? 'false' : 'true');
    });

    patch(d, 'reach', [lead.phone, lead.email, lead.name], function () {
      var wa = whatsappHref(lead.phone);
      var mail = mailHref(lead.email);
      var actions = h('div', { class: 'reach-actions' });
      if (tel) actions.append(h('a', { class: 'btn btn-primary', href: tel }, icon('phone'), 'Call', h('span', { class: 'sr-only' }, ' ' + who)));
      if (wa) actions.append(h('a', { class: 'btn', href: wa, target: '_blank', rel: 'noopener noreferrer' }, icon('chat'), 'WhatsApp', h('span', { class: 'sr-only' }, ' ' + who + ' (opens WhatsApp)')));
      if (mail) actions.append(h('a', { class: 'btn', href: mail }, icon('mail'), 'Email', h('span', { class: 'sr-only' }, ' ' + who)));
      var details = h('dl', { class: 'reach-details' });
      if (lead.phone) details.append(h('div', null, h('dt', null, 'Phone'), h('dd', null, lead.phone)));
      if (lead.email) details.append(h('div', null, h('dt', null, 'Email'), h('dd', null, lead.email)));
      d.reach.replaceChildren();
      if (actions.childNodes.length) d.reach.append(actions);
      if (details.childNodes.length) d.reach.append(details);
      if (!lead.phone && !lead.email) {
        d.reach.append(h('div', { class: 'notice' }, icon('alert'), h('div', { class: 'notice-body' },
          h('strong', null, 'They didn’t leave a way to reach them'),
          h('span', null, 'If they come back to your site, the assistant will ask again.'))));
      } else if (!lead.phone) {
        d.reach.append(h('p', { class: 'fine' }, 'No phone number was left, so calling and texting aren’t available for this enquiry.'));
      }

      // Texting and the call-back both need a number.
      d.textNoPhone.hidden = !!tel;
      d.textComposer.form.hidden = !tel;
      d.textHint.hidden = !tel;
      d.textHint.textContent = tel ? 'Goes to ' + lead.phone + ' as a text message from your business.' : '';
      d.confirmTitle.textContent = 'Call ' + who + ' on ' + lead.phone + ' now?';
      renderCall(d);
    });

    if (!d.statusBusy && d.radios[lead.status] && !d.radios[lead.status].checked) d.radios[lead.status].checked = true;

    patch(d, 'talk', [lead.transcript, d.expanded, lead.lang, lead.name], function () { renderTranscript(d, lead); });

    patch(d, 'message', [lead.message, lead.lang], function () {
      d.messageSection.hidden = !lead.message;
      d.messageSection.replaceChildren();
      if (lead.message) {
        d.messageSection.append(h('h3', { class: 'section-title' }, 'Their message'),
          h('blockquote', { class: 'slip quote', lang: lead.lang || null }, lead.message));
      }
    });

    patch(d, 'notes', lead.notes, function () {
      if (!lead.notes.length) { d.notesList.replaceChildren(); return; }
      var list = h('ul', { class: 'slip log' });
      lead.notes.forEach(function (n) {
        list.append(h('li', null, h('span', { class: 'log-text' }, n.text),
          h('span', { class: 'log-meta' }, timeEl(n.at), n.by ? h('span', null, 'by ' + n.by) : null)));
      });
      d.notesList.replaceChildren(list);
    });

    patch(d, 'sent', lead.messages, function () {
      if (!lead.messages.length) { d.sentList.replaceChildren(); return; }
      var list = h('ul', { class: 'slip log', 'aria-label': 'Texts you have sent' });
      lead.messages.forEach(function (m) {
        var failed = /fail|reject|undeliver|error/i.test(m.status);
        list.append(h('li', null, h('span', { class: 'log-text' }, m.text),
          h('span', { class: 'log-meta' }, h('span', null, 'You, by text'), timeEl(m.at),
            m.status ? h('span', { 'data-kind': failed ? 'error' : null }, failed ? 'Not delivered (' + m.status + ')' : m.status.charAt(0).toUpperCase() + m.status.slice(1)) : null)));
      });
      d.sentList.replaceChildren(list);
    });

    refreshTimes();
  }

  function renderTranscript(d, lead) {
    var turns = lead.transcript;
    d.talkSection.hidden = turns.length === 0;
    d.talkSection.replaceChildren();
    if (!turns.length) return;

    var clipped = !d.expanded && turns.length > TRANSCRIPT_PEEK + 2;
    var shown = clipped ? turns.slice(0, TRANSCRIPT_PEEK) : turns;
    var visitor = lead.name || (lead.source === 'call' ? 'Caller' : 'Visitor');
    var talk = h('ol', { class: 'talk', lang: lead.lang || null });
    var group = null;
    var groupRole = null;
    shown.forEach(function (t) {
      if (t.role !== groupRole) {
        groupRole = t.role;
        group = h('li', { class: 'talk-group', 'data-role': t.role },
          h('span', { class: 'talk-who', lang: 'en' }, t.role === 'assistant' ? 'Assistant' : visitor,
            validTime(t.at) ? h('span', { class: 'num' }, clockTime(t.at)) : null));
        talk.append(group);
      }
      group.append(h('p', { class: 'bubble' }, t.text));
    });

    var titleId = nextId('talk');
    var box = h('div', { class: 'slip' }, h('div', { class: 'talk-fade', 'data-clipped': clipped ? 'true' : 'false' }, talk));
    if (turns.length > TRANSCRIPT_PEEK + 2) {
      var toggle = h('button', { type: 'button', class: 'btn btn-block', 'aria-expanded': d.expanded ? 'true' : 'false' },
        d.expanded ? 'Show less' : 'Show all ' + turns.length + ' messages');
      toggle.addEventListener('click', function () {
        d.expanded = !d.expanded;
        var current = findLead(d.id);
        if (!current) return;
        patch(d, 'talk', [current.transcript, d.expanded, current.lang, current.name], function () { renderTranscript(d, current); });
        var again = d.talkSection.querySelector('button[aria-expanded]');
        focusEl(again, true);
        if (!d.expanded) d.talkSection.scrollIntoView({ block: 'nearest' });
      });
      box.append(h('div', { class: 'talk-more' }, toggle));
    }
    d.talkSection.setAttribute('aria-labelledby', titleId);
    d.talkSection.append(
      h('div', { class: 'block-head' },
        h('h3', { class: 'section-title', id: titleId }, lead.source === 'call' ? 'The phone call' : 'The conversation'),
        h('span', { class: 'fine num' }, turns.length + (turns.length === 1 ? ' message' : ' messages'))),
      box);
  }

  function applyLead(serverLead, id, fallback) {
    var next = serverLead && typeof serverLead === 'object' ? normalizeLead(serverLead) : null;
    var index = -1;
    for (var i = 0; i < state.leads.length; i++) if (state.leads[i].id === id) index = i;
    if (next && next.id) {
      if (index >= 0) state.leads[index] = next; else state.leads.unshift(next);
    } else if (index >= 0 && fallback) {
      fallback(state.leads[index]);
      lastLeadsAt = 0;   // the server did not echo the lead back: fetch the truth soon
    }
    recount();
    renderLeads();
    renderLeadPane();
    renderAttention();
  }

  async function setStatus(d, status) {
    d.statusWant = status;
    if (d.statusBusy) return;
    d.statusBusy = true;
    while (d.statusWant) {
      var want = d.statusWant;
      d.statusWant = null;
      var lead = findLead(d.id);
      if (!lead || lead.status === want) continue;
      setLine(d.statusLine, 'pending', 'Saving…');
      try {
        var res = await mutate(function () { return api('/leads/' + enc(d.id), { method: 'PATCH', body: { status: want } }); });
        applyLead(res.lead, d.id, function (l) { l.status = want; });
        if (!d.statusWant) setLine(d.statusLine, 'ok', 'Marked as ' + STATUS[want].label.toLowerCase() + '.');
      } catch (err) {
        d.statusWant = null;
        var current = findLead(d.id);
        if (current && d.radios[current.status]) d.radios[current.status].checked = true;
        setLine(d.statusLine, 'error', 'The status was not changed. ' + err.message);
      }
    }
    d.statusBusy = false;
  }

  function renderCall(d) {
    var lead = findLead(d.id);
    var hasPhone = !!(lead && telHref(lead.phone));
    if (!hasPhone) {
      d.callIntro.textContent = 'The assistant can phone someone back for you, but this person left no number.';
      d.callBtn.setAttribute('aria-disabled', 'true');
      d.callBtn.hidden = false;
      d.confirm.hidden = true;
      return;
    }
    d.callIntro.textContent = 'Busy at the counter? The assistant can phone ' + (lead.name || 'them') + ' for you, answer their questions and take down what they need.';
    d.confirm.hidden = d.callState !== 'confirm' && d.callState !== 'pending';
    d.callBtn.hidden = !d.confirm.hidden;
    if (d.callState !== 'pending') d.callBtn.removeAttribute('aria-disabled');
  }

  function cancelCall(d) {
    if (d.callState !== 'confirm') return;
    d.callState = 'idle';
    renderCall(d);
    focusEl(d.callBtn, true);
  }

  async function placeCall(d) {
    if (d.callState !== 'confirm') return;
    d.callState = 'pending';
    setBusy(d.confirmYes, true, 'Calling…');
    d.confirmNo.setAttribute('aria-disabled', 'true');
    d.confirmNo.disabled = true;
    setLine(d.callLine, 'pending', 'Starting the call…');
    var ok = false;
    try {
      await mutate(function () {
        return api('/leads/' + enc(d.id) + '/call', { method: 'POST',
          fallbacks: { 403: 'Calling this number is not allowed.', 429: 'A call is already in progress. Try again when it has finished.' } });
      });
      ok = true;
    } catch (err) {
      setLine(d.callLine, 'error', 'The call was not placed. ' + err.message);
    }
    setBusy(d.confirmYes, false);
    d.confirmNo.removeAttribute('aria-disabled');
    d.confirmNo.disabled = false;
    d.callState = 'idle';
    renderCall(d);
    if (ok) {
      var lead = findLead(d.id);
      setLine(d.callLine, 'ok', 'The assistant is calling ' + (lead ? leadName(lead) : 'them') + ' now.', nudgeContacted(d));
      lastLeadsAt = 0;
    }
    focusEl(d.callBtn, true);
  }

  /* ------------------------------------------------------------------ */
  /* Website                                                             */
  /* ------------------------------------------------------------------ */

  var web = null;

  function buildWebsiteView() {
    var view = $('view-website');
    web = { sig: {}, changePending: false, changeTimer: null, changeStartedAt: 0, publishing: false };

    web.title = h('h1', { class: 'page-title', id: 'website-title', tabindex: '-1' }, 'Website');
    web.stampSlot = h('span');
    web.alert = h('div', { hidden: true });
    web.card = h('section', { class: 'slip slip-pad stack', 'aria-label': 'Your site' });

    // Publish
    web.publishTitle = h('p', { class: 'publish-title' });
    web.publishHint = h('p', { class: 'fine' });
    web.publishBtn = h('button', { type: 'button', class: 'btn' }, 'Publish');
    web.publishBtn.addEventListener('click', publishSite);
    web.publishLine = statusLine();
    web.publishLine.classList.add('publish-status');
    web.publish = h('section', { class: 'slip publish', 'aria-label': 'Publishing' },
      h('div', { class: 'stack-tight' }, web.publishTitle, web.publishHint), web.publishBtn, web.publishLine);

    // Describe a change
    web.progressText = h('span');
    web.progressClock = h('span', { class: 'num' });
    web.progress = h('div', { class: 'progress', hidden: true },
      h('div', { class: 'progress-bar', role: 'progressbar', 'aria-label': 'Redesigning your page' }),
      h('div', { class: 'progress-line' }, web.progressText, web.progressClock));
    web.result = h('div', { hidden: true });
    web.suggestions = h('div', { class: 'chips', role: 'group', 'aria-label': 'Examples you can start from' });
    ['Change the opening hours to…', 'Add a line about home delivery', 'Make the phone number easier to spot'].forEach(function (example) {
      web.suggestions.append(h('button', { type: 'button', class: 'chip chip-btn', onclick: function () {
        var ta = web.change.textarea;
        if (ta.readOnly) return;
        ta.value = example.replace(/…$/, ' ');
        setDraft('change', ta.value);
        focusEl(ta);
        try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) { /* not every browser allows it */ }
      } }, example));
    });
    web.change = composer({
      label: 'Describe a change', labelClass: 'publish-title', draftKey: 'change', rows: 4, maxlength: 2000,
      hint: 'Say it the way you would tell a person. The assistant redesigns the page for you.',
      placeholder: 'For example: we now close at 9 pm on Sundays, and add our new mango lassi to the menu.',
      extra: [web.suggestions, web.progress],
      submitLabel: 'Make this change', busyLabel: 'Working on it…', pendingMessage: 'Keep this page open.',
      emptyMessage: 'Describe what you would like changed first.', failPrefix: 'Nothing was changed.',
      submit: submitChange
    });
    web.changeBusyNote = h('p', { class: 'fine', hidden: true });
    web.changeSection = h('section', { class: 'slip slip-pad stack', 'aria-label': 'Change your site' }, web.change.form, web.changeBusyNote, web.result);

    web.madeBy = h('p', { class: 'fine', hidden: true });
    web.controls = h('div', { class: 'web-controls' },
      h('div', { class: 'site-head' }, web.title, web.stampSlot),
      web.alert, web.card, web.publish, web.changeSection, web.madeBy);

    // Preview
    web.openPreview = h('span');
    web.frame = h('div', { class: 'slip preview-frame' });
    web.preview = h('section', { class: 'web-preview', 'aria-labelledby': 'preview-title' },
      h('div', { class: 'block-head' }, h('h2', { class: 'section-title', id: 'preview-title' }, 'Preview'), web.openPreview),
      web.frame);

    view.replaceChildren(web.controls, web.preview);
    updateWebsite();
  }

  function needsPublish(site) {
    return !!site && (site.unpublishedChanges === true || site.status === 'ready');
  }

  function updateSiteBadge() {
    var badge = $('nav-site-badge');
    if (needsPublish(state.site)) {
      badge.hidden = false;
      badge.replaceChildren(h('span', { class: 'sr-only' }, ' has unpublished changes'));
    } else { badge.hidden = true; }
  }

  function updateWebsite() {
    if (!web || !state.site) return;
    var site = state.site;
    var busy = siteIsBusy();

    var live = isLive();

    patch(web, 'stamp', [site.status, live], function () {
      var s = SITE_STATUS[site.status];
      // A published site with changes waiting is still live for visitors.
      if (live && site.status === 'ready') s = SITE_STATUS.published;
      web.stampSlot.replaceChildren(s ? stamp(s.tone, s.label, s.icon, true) : '');
    });

    patch(web, 'alert', state.siteError, function () {
      if (!state.siteError) { web.alert.hidden = true; web.alert.replaceChildren(); return; }
      web.alert.hidden = false;
      web.alert.replaceChildren(h('div', { class: 'notice', 'data-kind': 'error', role: 'status' }, icon('alert'),
        h('div', { class: 'notice-body' }, h('strong', null, 'We couldn’t check your site just now.'),
          h('span', null, state.siteError + ' ', h('button', { type: 'button', class: 'linkish', onclick: function () { loadSite(); } }, 'Try now')))));
    });

    patch(web, 'card', [site.name, site.url, site.address, live, site.sections], function () {
      web.card.replaceChildren(
        h('div', { class: 'stack-tight' },
          h('h2', { class: 'blank-title' }, site.name || 'Your website'),
          h('p', { class: 'fine' }, live ? 'Anyone with this address can visit your site.' : 'This will be your address once the site is published.')),
        addressRow(site.url || site.address));
      if (site.sections.length) {
        var chips = h('ul', { class: 'chips', 'aria-label': 'Sections on your page' });
        site.sections.forEach(function (s) { chips.append(h('li', { class: 'chip' }, s)); });
        web.card.append(h('div', { class: 'stack-tight' }, h('p', { class: 'fine' }, 'On your page now'), chips));
      }
    });

    // Publish is loud only when there is something visitors cannot see yet.
    var prominent = needsPublish(site);
    patch(web, 'publish', [prominent, site.status, live, site.address, busy, web.changePending, web.publishing], function () {
      web.publish.setAttribute('data-prominent', prominent ? 'true' : 'false');
      var blocked = busy || web.changePending;
      if (site.status === 'designing') {
        web.publishTitle.textContent = 'Your site is still being designed';
        web.publishHint.textContent = 'You can publish as soon as it is ready. This page updates on its own.';
      } else if (site.status === 'failed' && !prominent) {
        web.publishTitle.textContent = 'The last design attempt didn’t work';
        web.publishHint.textContent = 'Describe the change again below and the assistant will have another go.';
      } else if (prominent && !live) {
        web.publishTitle.textContent = 'Your site isn’t public yet';
        web.publishHint.textContent = 'Have a look at the preview. When you’re happy, publish it so customers can find you' + (site.address ? ' at ' + prettyUrl(site.address) + '.' : '.');
      } else if (prominent) {
        web.publishTitle.textContent = 'You have changes visitors can’t see yet';
        web.publishHint.textContent = 'The preview shows the new version. Publish to put it in front of customers.';
      } else {
        web.publishTitle.textContent = site.status === 'revising' ? 'Your site is being updated' : 'Your site is live and up to date';
        web.publishHint.textContent = '';
      }
      web.publishHint.hidden = !web.publishHint.textContent;
      if (!web.publishing) {
        web.publishBtn.className = 'btn' + (prominent ? ' btn-primary btn-block' : '');
        web.publishBtn.textContent = prominent ? (live ? 'Publish changes' : 'Publish my site') : 'Publish again';
        if (blocked) web.publishBtn.setAttribute('aria-disabled', 'true'); else web.publishBtn.removeAttribute('aria-disabled');
      }
    });

    // While someone else (the phone agent, another tab) is redesigning, hold new changes back.
    var held = busy && !web.changePending;
    web.changeBusyNote.hidden = !held;
    web.changeBusyNote.textContent = held
      ? (site.status === 'designing' ? 'Your site is being designed right now.' : 'Your site is being updated right now.') + ' You can send a new change in a moment; anything you type is kept.'
      : '';
    if (!web.changePending) {
      if (held) web.change.button.setAttribute('aria-disabled', 'true'); else web.change.button.removeAttribute('aria-disabled');
    }

    patch(web, 'madeBy', site.madeBy, function () {
      web.madeBy.hidden = !site.madeBy;
      web.madeBy.textContent = site.madeBy ? 'Made by ' + site.madeBy : '';
    });

    var previewHref = safeUrl(site.previewUrl);
    patch(web, 'preview', previewHref, function () {
      if (!previewHref) {
        web.iframe = null;
        web.openPreview.replaceChildren();
        web.frame.replaceChildren(h('p', { class: 'preview-empty' }, 'The preview appears here once your site has been designed.'));
        return;
      }
      web.iframe = h('iframe', { src: previewHref, title: 'Preview of your website', loading: 'lazy', referrerpolicy: 'same-origin' });
      web.frame.replaceChildren(web.iframe);
      web.openPreview.replaceChildren(h('a', { class: 'linkish', href: previewHref, target: '_blank', rel: 'noopener' },
        'Open full size', h('span', { class: 'sr-only' }, ' (opens in a new tab)')));
    });
  }

  function reloadPreview() {
    if (!web || !web.iframe) return;
    try { web.iframe.contentWindow.location.reload(); }
    catch (e) { var src = web.iframe.getAttribute('src'); web.iframe.setAttribute('src', src); }
  }

  function warnBeforeLeaving(e) { e.preventDefault(); e.returnValue = ''; }

  function progressMessage(seconds) {
    if (seconds < 8) return 'Reading what you asked for…';
    if (seconds < 30) return 'Redesigning your page…';
    if (seconds < 60) return 'Still working. Bigger changes take about a minute.';
    if (seconds < 100) return 'Nearly there. This can take up to a minute and a half.';
    return 'This is taking longer than usual. It is still running, so keep this page open.';
  }

  function paintProgress() {
    var seconds = Math.floor((Date.now() - web.changeStartedAt) / 1000);
    var text = progressMessage(seconds);
    if (web.progressText.textContent !== text) web.progressText.textContent = text;
    web.progressClock.textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }

  // Can take a minute and a half. No timeout on our side: we wait for the server's answer.
  async function submitChange(text) {
    web.changePending = true;
    web.changeStartedAt = Date.now();
    web.result.hidden = true;
    web.result.replaceChildren();
    web.progress.hidden = false;
    paintProgress();
    web.changeTimer = window.setInterval(paintProgress, 1000);
    window.addEventListener('beforeunload', warnBeforeLeaving);
    announce('Working on your change. This can take up to a minute and a half.');
    updateWebsite();
    try {
      var res = await api('/site/change', { method: 'POST', body: { change: text } });
      var summary = str(res.summary).trim();
      if (res.ok === false) throw new Error(summary || 'The assistant could not make that change. Try describing it another way.');
      reloadPreview();
      web.result.hidden = false;
      web.result.replaceChildren(h('div', { class: 'notice', 'data-kind': 'ok' }, icon('check'),
        h('div', { class: 'notice-body' },
          h('strong', null, 'Done. Here is what changed'),
          h('span', null, summary || 'Your page has been updated.'),
          h('div', null, h('button', { type: 'button', class: 'linkish', onclick: function () {
            web.preview.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
          } }, 'See it in the preview')))));
      if (state.site) state.site.unpublishedChanges = true;
      return { text: 'Change made. Publish when you are happy with it.' };
    } finally {
      window.clearInterval(web.changeTimer);
      window.removeEventListener('beforeunload', warnBeforeLeaving);
      web.changePending = false;
      web.progress.hidden = true;
      updateWebsite();
      updateSiteBadge();
      loadSite();
    }
  }

  async function publishSite() {
    if (web.publishing || isOff(web.publishBtn)) return;
    web.publishing = true;
    setBusy(web.publishBtn, true, 'Publishing…');
    setLine(web.publishLine, 'pending', 'Putting your site online…');
    try {
      var res = await api('/site/publish', { method: 'POST' });
      if (state.site) {
        state.site.status = 'published';
        state.site.unpublishedChanges = false;
        if (safeUrl(res.url)) state.site.url = str(res.url);
      }
      setBusy(web.publishBtn, false);
      web.publishing = false;
      updateWebsite();
      updateSiteBadge();
      setLine(web.publishLine, 'ok', 'Published. Your site is live' + (siteUrl() ? ' at ' + prettyUrl(siteUrl()) + '.' : '.'));
      loadSite();
    } catch (err) {
      setBusy(web.publishBtn, false);
      web.publishing = false;
      web.sig.publish = null;
      updateWebsite();
      setLine(web.publishLine, 'error', 'Your site was not published. ' + err.message);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Account                                                             */
  /* ------------------------------------------------------------------ */

  function buildAccountView() {
    var me = state.me;
    var view = $('view-account');
    var how = me.auth === 'google' ? 'Your Google account' : me.auth === 'link' ? 'The private link from your text message' : 'Signed in';
    var facts = h('dl', { class: 'slip facts' });
    if (str(me.name).trim()) facts.append(h('div', null, h('dt', null, 'Name'), h('dd', null, str(me.name))));
    if (str(me.email).trim()) facts.append(h('div', null, h('dt', null, 'Email'), h('dd', null, str(me.email))));
    facts.append(h('div', null, h('dt', null, 'Signed in with'), h('dd', null, how)));
    facts.append(h('div', null, h('dt', null, 'Website'), h('dd', null, siteName())));

    var line = statusLine();
    var out = h('button', { type: 'button', class: 'btn' }, 'Sign out');
    out.addEventListener('click', function () { signOut(out, line); });

    view.replaceChildren(h('div', { class: 'account' },
      h('h1', { class: 'page-title', id: 'account-title', tabindex: '-1' }, 'Account'),
      facts,
      h('section', { class: 'block', 'aria-label': 'Your site’s address' },
        h('h2', { class: 'section-title' }, 'Your site’s address'), addressRow(siteUrl())),
      h('section', { class: 'block' },
        h('h2', { class: 'section-title' }, 'On a shared phone?'),
        h('p', { class: 'fine' }, me.auth === 'link'
          ? 'Signing out removes access on this device. To get back in, open the private link from your text message again.'
          : 'Signing out removes access on this device. Sign in again with Google whenever you like.'),
        h('div', { class: 'form-row' }, out, line))));
  }

  /* ------------------------------------------------------------------ */

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
