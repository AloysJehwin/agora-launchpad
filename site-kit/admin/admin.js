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
  var LEADS_EVERY = 15000;
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
  var VIEW_TITLE = { leads: 'Leads', website: 'Website', account: 'Account' };

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
    half: ['M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'F:M12 5a7 7 0 0 1 0 14z']
  };

  var state = {
    me: null,
    view: 'leads',
    leadId: null,
    leads: [],
    counts: null,
    leadsLoaded: false,
    leadsError: null,
    filter: 'all',
    site: null,
    siteLoaded: false,
    siteError: null,
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
  function siteUrl() { return state.site ? state.site.url : ''; }

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
      else title.textContent = 'Sign in to see your leads';

      if (context.reason === 'expired') {
        card.append(h('p', { class: 'lede' }, 'You were signed out for safety. Anything you were typing has been kept on this device.'));
      } else if (context.reason === 'bad-link') {
        card.append(h('div', { class: 'notice', 'data-kind': 'error' }, icon('alert'),
          h('div', { class: 'notice-body' }, context.message || 'The private link may have expired or already been used.')));
      } else if (context.reason !== 'left') {
        card.append(h('p', { class: 'lede' }, 'This is the private panel for the owner of this website: the people who got in touch, and the site itself.'));
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
      if (!gateShown) { renderLeads(); renderLeadPane(); }
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
      if (!gateShown) { updateWebsite(); updateSiteBadge(); }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Routing and focus                                                   */
  /* ------------------------------------------------------------------ */

  function parseHash() {
    var parts = window.location.hash.replace(/^#\/?/, '').split('/');
    var view = VIEW_TITLE[parts[0]] ? parts[0] : 'leads';
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
  /* Leads: the list                                                     */
  /* ------------------------------------------------------------------ */

  function buildLeadsView() {
    var view = $('view-leads');
    ui.leadsTitle = h('h1', { class: 'page-title', id: 'leads-title', tabindex: '-1' }, 'Leads');
    ui.leadsTotal = h('p', { class: 'fine num' });
    ui.leadsAlert = h('div', { hidden: true });
    ui.tally = h('div', { class: 'tally slip', role: 'group', 'aria-label': 'Filter leads by status' });
    ui.tallyCells = {};
    STATUS_ORDER.forEach(function (s) {
      var num = h('span', { class: 'tally-num' }, '–');
      var cell = h('button', { type: 'button', class: 'tally-cell', 'data-tone': s, 'aria-pressed': 'false' },
        num, h('span', { class: 'tally-label' }, icon(STATUS[s].icon), STATUS[s].label));
      cell.addEventListener('click', function () {
        state.filter = state.filter === s ? 'all' : s;
        renderLeads();
        var shown = filteredLeads().length;
        announce(state.filter === 'all' ? 'Showing all leads.' : 'Showing ' + shown + ' ' + STATUS[s].label.toLowerCase() + (shown === 1 ? ' lead.' : ' leads.'));
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
      announce('Showing all leads.');
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
          h('div', { class: 'notice-body' }, h('strong', null, 'We couldn’t load your leads.'), h('span', null, state.leadsError),
            h('div', null, h('button', { type: 'button', class: 'linkish', onclick: function () { state.leadsError = null; renderLeads(); loadLeads(); } }, 'Try again'))));
      }
      var ghosts = h('div', { class: 'slip lead-list', role: 'status', 'aria-label': 'Loading your leads' });
      for (var g = 0; g < 4; g++) ghosts.append(h('div', { class: 'ghost' }, h('i'), h('i'), h('i')));
      return ghosts;
    }

    if (state.leads.length === 0) return buildTeachingSlip();

    if (visible.length === 0) {
      return h('div', { class: 'slip slip-pad stack-tight' },
        h('p', null, 'No leads are marked ' + STATUS[state.filter].label.toLowerCase() + ' right now.'),
        h('p', { class: 'fine' }, state.filter === 'new'
          ? 'You’re all caught up. New conversations appear here on their own.'
          : 'Open a lead and change its status to move it here.'),
        h('div', null, showAllButton('Show all leads')));
    }

    var list = h('ul', { class: 'slip lead-list', 'aria-label': state.filter === 'all' ? 'All leads, newest first' : STATUS[state.filter].label + ' leads, newest first' });
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
        ui.leadPane.replaceChildren(h('p', { class: 'lead-rest' }, 'Choose a lead to read the conversation and reply.'));
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
              h('h2', { class: 'blank-title', tabindex: '-1', 'data-focus': true }, 'This lead isn’t here any more'),
              h('p', { class: 'lede' }, 'It may have been removed, or the link is from another site.'),
              h('a', { class: 'btn', href: '#/leads' }, 'Back to all leads'))
          : h('div', { class: 'slip lead-list', role: 'status', 'aria-label': 'Loading this lead' }, h('div', { class: 'ghost' }, h('i'), h('i'), h('i'))));
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
    return h('div', { class: 'back-bar' }, h('a', { class: 'btn btn-quiet', href: '#/leads' }, icon('back'), 'Leads'));
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
            fallbacks: { 400: 'This lead has no phone number to text.', 502: 'The phone network turned the message down.' } });
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
        d.reach.append(h('p', { class: 'fine' }, 'No phone number was left, so calling and texting aren’t available for this lead.'));
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
      d.callIntro.textContent = 'The assistant can phone a lead for you, but this one left no number.';
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

    patch(web, 'stamp', site.status, function () {
      var s = SITE_STATUS[site.status];
      web.stampSlot.replaceChildren(s ? stamp(s.tone, s.label, s.icon, true) : '');
    });

    patch(web, 'alert', state.siteError, function () {
      if (!state.siteError) { web.alert.hidden = true; web.alert.replaceChildren(); return; }
      web.alert.hidden = false;
      web.alert.replaceChildren(h('div', { class: 'notice', 'data-kind': 'error', role: 'status' }, icon('alert'),
        h('div', { class: 'notice-body' }, h('strong', null, 'We couldn’t check your site just now.'),
          h('span', null, state.siteError + ' ', h('button', { type: 'button', class: 'linkish', onclick: function () { loadSite(); } }, 'Try now')))));
    });

    patch(web, 'card', [site.name, site.url, site.status, site.sections], function () {
      var live = site.status === 'published';
      web.card.replaceChildren(
        h('div', { class: 'stack-tight' },
          h('h2', { class: 'blank-title' }, site.name || 'Your website'),
          h('p', { class: 'fine' }, live ? 'Anyone with this address can visit your site.' : 'This will be your address once the site is published.')),
        addressRow(site.url));
      if (site.sections.length) {
        var chips = h('ul', { class: 'chips', 'aria-label': 'Sections on your page' });
        site.sections.forEach(function (s) { chips.append(h('li', { class: 'chip' }, s)); });
        web.card.append(h('div', { class: 'stack-tight' }, h('p', { class: 'fine' }, 'On your page now'), chips));
      }
    });

    // Publish is loud only when there is something visitors cannot see yet.
    var prominent = needsPublish(site);
    patch(web, 'publish', [prominent, site.status, site.url, busy, web.changePending, web.publishing], function () {
      web.publish.setAttribute('data-prominent', prominent ? 'true' : 'false');
      var blocked = busy || web.changePending;
      if (site.status === 'designing') {
        web.publishTitle.textContent = 'Your site is still being designed';
        web.publishHint.textContent = 'You can publish as soon as it is ready. This page updates on its own.';
      } else if (site.status === 'failed' && !prominent) {
        web.publishTitle.textContent = 'The last design attempt didn’t work';
        web.publishHint.textContent = 'Describe the change again below and the assistant will have another go.';
      } else if (prominent && site.status === 'ready') {
        web.publishTitle.textContent = 'Your site isn’t public yet';
        web.publishHint.textContent = 'Have a look at the preview. When you’re happy, publish it so customers can find you' + (site.url ? ' at ' + prettyUrl(site.url) + '.' : '.');
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
        web.publishBtn.textContent = prominent ? (site.status === 'ready' ? 'Publish my site' : 'Publish changes') : 'Publish again';
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
