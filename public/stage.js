// The live call stage: the big board that follows one call from the dial to the published site,
// and the phone-shaped frame beside it that shows the site's live preview.
//
// It only draws. call.js owns the call (placing, polling, ending) and hands every change to
// LaunchpadStage.call(); sites.js hands over the sites list so the board can keep following the
// site after the phone call has ended. Nothing here is on a timer or guessed: every stage shown
// comes from the status fields of the API (see derive() below).
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    stage: $('stage'), live: $('stage-live'), tag: $('stage-tag'), who: $('stage-who'), clock: $('stage-clock'),
    timer: $('call-timer'), outcome: $('stage-outcome'), headline: $('stage-headline'), kicker: $('stage-kicker'), detail: $('stage-detail'),
    detailLine: $('stage-detail-line'), address: $('stage-address'), facts: $('stage-facts'),
    name: $('fact-name'), version: $('fact-version'), by: $('fact-by'), byRow: $('fact-by-row'),
    sections: $('fact-sections'), sectionsRow: $('fact-sections-row'), sequence: $('sequence'),
    phone: $('phone'), screen: $('phone-screen'), frame: $('phone-frame'), idle: $('phone-idle'),
    idleText: $('phone-idle-text'), cap: $('phone-cap'), open: $('phone-open'),
  };
  if (!el.stage || !el.sequence) return;

  const STEPS = ['call', 'link', 'collecting', 'designing', 'ready', 'revising', 'published'];
  const REVISING = STEPS.indexOf('revising');
  const SITE_STEP = { collecting: 2, designing: 3, ready: 4, revising: 5, published: 6 };
  const rows = STEPS.map((step) => {
    const li = el.sequence.querySelector(`[data-step="${step}"]`);
    return { li, note: li.querySelector('.seq-note'), at: li.querySelector('.seq-at') };
  });
  const IDLE = {
    headline: el.headline.textContent,
    detail: el.detail.textContent,
    tag: el.tag.textContent,
    phone: el.idleText.textContent,
    cap: el.cap.textContent,
  };

  // What this console has watched happen on the current call. Reset when the call changes.
  const seen = { callId: null, index: -1, at: {}, revisions: 0, revisionKey: '' };
  let snap = null;      // the last snapshot from call.js, or null when there is no call
  let site = null;      // the site of that call, kept fresh from the sites list once the call is over
  let framed = '';      // the preview address in the phone frame
  let lastVersion = null;

  // ------------------------------------------------------------ helpers ----

  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const clock = (ms) => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  // Addresses from the API go into href and src, so only plain web addresses are let through.
  const webUrl = (value) => {
    if (typeof value !== 'string' || !value) return null;
    try {
      const url = new URL(value, window.location.href);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch { return null; }
  };
  const bare = (url) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const str = (value) => (typeof value === 'string' ? value.trim() : '');
  const reason = (value) => str(value).toLowerCase().replace(/[_-]/g, ' ') || 'unknown';

  // What the API says about the phone line itself. "Answered" and "Ringing" appear only when
  // phone.state says so; a bare RUNNING cannot tell the two apart, and the copy says exactly that.
  const line = (s) => {
    const state = s.phone && typeof s.phone === 'object' ? s.phone.state : null;
    if (state === 'ended') {
      const secs = Number.isFinite(Number(s.phone.seconds)) && s.phone.seconds != null ? `, ${Math.round(Number(s.phone.seconds))} s connected` : '';
      return { key: 'ended', label: `Ended: ${reason(s.phone.hangupReason)}${secs}` };
    }
    if (s.phase === 'failed') return { key: 'failed', label: 'Failed' };
    if (s.phase === 'ended') return { key: 'ended', label: 'Ended' };
    if (s.lost) return { key: 'lost', label: 'Contact lost' };
    if (s.ending || s.status === 'STOPPING') return { key: 'ending', label: 'Ending the call' };
    if (state === 'answered') return { key: 'answered', label: 'Answered' };
    if (state === 'ringing') return { key: 'ringing', label: 'Ringing' };
    if (s.status === 'RUNNING') return { key: 'running', label: 'Ringing or in conversation' };
    if (s.status === 'STARTING') return { key: 'dialing', label: 'Dialing' };
    return { key: 'waiting', label: 'Checking the call' };
  };

  // ------------------------------------------------------------- derive ----

  // Turns the snapshot and the site into everything the board shows. Pure: same input, same board.
  const derive = () => {
    if (!snap) {
      return { phase: 'idle', index: -1, tag: IDLE.tag, who: '', outcome: '', headline: IDLE.headline, kicker: '', detail: IDLE.detail, strong: false, tone: '', failedStep: -1 };
    }
    const on = line(snap);
    const live = snap.phase === 'live';
    const out = {
      phase: snap.phase, index: 0, who: snap.to ? ` · ${snap.to}` : '', kicker: '', strong: false, tone: '', failedStep: -1,
      tag: live ? (on.key === 'ending' ? 'Ending the call' : on.key === 'lost' ? 'Contact lost' : 'Live call') : (snap.phase === 'failed' ? 'Call failed' : 'Call ended'),
      // How the call ended, in the server's own words ("Nobody answered.", "The call ended after 5 min 46 s.").
      outcome: live ? '' : str(snap.text),
      line: on,
    };

    const status = site ? str(site.status) : '';
    if (site && SITE_STEP[status] !== undefined) out.index = SITE_STEP[status];
    else if (site) { out.index = Math.max(2, seen.index); out.failedStep = out.index; }

    if (live && snap.lost) {
      Object.assign(out, { headline: 'Lost contact with the server', detail: snap.text || '', tone: 'error' });
    } else if (snap.phase === 'failed' && !site) {
      Object.assign(out, { headline: 'Call failed', detail: out.outcome ? '' : 'The server gave no reason.', tone: 'error', failedStep: 0 });
    } else if (!site) {
      if (snap.phase === 'ended') Object.assign(out, { headline: 'Call ended', detail: 'No website was started on this call.' });
      else if (on.key === 'ending') Object.assign(out, { headline: 'Ending the call', detail: '' });
      else if (on.key === 'answered') Object.assign(out, { headline: 'Answered', detail: 'In conversation. The preview link goes out as soon as the caller says the business name.' });
      else if (on.key === 'ringing') Object.assign(out, { headline: 'Ringing', detail: snap.to ? `Waiting for ${snap.to} to pick up.` : '' });
      else if (on.key === 'running') Object.assign(out, { headline: 'Ringing or in conversation', detail: 'The line is open. The phone network has not reported whether the call was answered.' });
      else if (on.key === 'dialing') Object.assign(out, { headline: 'Dialing', detail: `${snap.to ?? 'The number'}${snap.from ? ` from ${snap.from}` : ''}` });
      else Object.assign(out, { headline: 'Checking the call', detail: 'Waiting for the server to report the call status.' });
    } else if (out.failedStep !== -1) {
      Object.assign(out, { headline: 'The page build failed', detail: str(site.error) || 'The server gave no reason.', tone: 'error' });
    } else if (status === 'collecting') {
      Object.assign(out, { headline: 'Getting to know the business', detail: 'The preview link has gone out. The page fills in as the caller answers.' });
    } else if (status === 'designing') {
      const step = str(site.step);
      Object.assign(out, { headline: 'Designing', kicker: step ? 'Now writing' : '', detail: step || 'Writing the full page.', strong: Boolean(step) });
    } else if (status === 'ready') {
      Object.assign(out, {
        headline: 'Ready for changes',
        detail: site.unpublishedChanges && site.url
          ? 'The site is live. The latest changes are not published yet.'
          : 'The caller can ask for a change by voice, or say “publish”.',
      });
    } else if (status === 'revising') {
      const step = str(site.step);
      Object.assign(out, { headline: 'Applying a change', kicker: step ? 'The caller asked' : '', detail: step ? `“${step}”` : 'A spoken change is being applied.', strong: Boolean(step) });
    } else {
      Object.assign(out, { headline: 'Published', detail: site.unpublishedChanges ? 'Live at this address. Newer changes are not published yet.' : 'The site is live at this address.' });
    }
    return out;
  };

  // --------------------------------------------------------------- draw ----

  const elapsedNow = () => (snap && Number.isFinite(snap.t0) ? Date.now() - snap.t0 : 0);

  // Remember when this console first saw each stage, as time since dialing. Only while the call
  // is live, and only for a call this page placed and has watched from the start: after a reload,
  // or for a call picked up from elsewhere, the earlier stages were not seen, so no times are shown.
  const remember = (d) => {
    if (d.index === seen.index) return;
    const first = seen.index === -1;
    if (d.phase === 'live' && snap.fresh) {
      const now = elapsedNow();
      if (first) {
        if (d.index === 0) seen.at[0] = now;
      } else {
        for (let i = seen.index + 1; i <= d.index; i += 1) {
          if (i !== REVISING || d.index === REVISING) seen.at[i] ??= now;
        }
      }
    }
    seen.index = d.index;
  };

  const countRevisions = (d) => {
    if (!site || d.index !== REVISING || d.failedStep !== -1) return;
    const key = `${site.version}:${str(site.step)}`;
    if (key === seen.revisionKey) return;
    seen.revisionKey = key;
    seen.revisions += 1;
  };

  const rowState = (i, d) => {
    if (d.phase === 'idle') return 'pending';
    if (i === d.failedStep) return 'failed';
    if (!site && d.phase === 'ended') return i === 0 ? 'done' : 'pending';
    // A change is only ticked if this console saw one being applied; a site can be published without any.
    if (i < d.index) return i === REVISING && seen.revisions === 0 ? 'skipped' : 'done';
    if (i === d.index) return 'now';
    return 'pending';
  };

  const rowNote = (i, state, d) => {
    if (d.phase === 'idle') return '';
    if (i === 0) return d.line.label;
    if (!site) return '';
    if (i === 1) return state === 'pending' ? '' : 'By WhatsApp or text message';
    if (i === 2 && state === 'now') {
      const n = Array.isArray(site.sections) ? site.sections.length : 0;
      return n ? `${n} section${n === 1 ? '' : 's'} so far` : '';
    }
    if (i === 3) {
      if (state === 'now') return str(site.step);
      return state === 'done' && str(site.madeBy) ? `By ${str(site.madeBy)}` : '';
    }
    if (i === 4 && state === 'now') return site.unpublishedChanges ? 'Changes not yet published' : '';
    if (i === REVISING) {
      if (state === 'now') return str(site.step) ? `“${str(site.step)}”` : '';
      return seen.revisions ? `${seen.revisions} seen on this call` : '';
    }
    if (i === 6 && state === 'now') return webUrl(site.url) ? bare(webUrl(site.url)) : '';
    return '';
  };

  const STATE_WORD = { done: 'done', now: 'now', failed: 'failed', skipped: '', pending: '' };

  const drawSequence = (d) => {
    rows.forEach((row, i) => {
      const state = rowState(i, d);
      if (row.li.dataset.state !== state) row.li.dataset.state = state;
      if (state === 'now') row.li.setAttribute('aria-current', 'step');
      else row.li.removeAttribute('aria-current');
      // Screen readers get the state as a word; the visual state is colour plus the marker shape.
      const word = STATE_WORD[state];
      if (row.li.dataset.word !== word) {
        row.li.dataset.word = word;
        let sr = row.li.querySelector('.seq-sr');
        if (!sr) { sr = document.createElement('span'); sr.className = 'visually-hidden seq-sr'; row.li.append(sr); }
        sr.textContent = word ? ` (${word})` : '';
      }
      text(row.note, rowNote(i, state, d));
      text(row.at, seen.at[i] !== undefined && state !== 'pending' ? `T+${clock(seen.at[i])}` : '');
    });
  };

  const drawFacts = () => {
    el.facts.hidden = !site;
    if (!site) { lastVersion = null; return; }
    text(el.name, str(site.name) || 'Not known yet');
    const version = Number.isFinite(Number(site.version)) ? String(site.version) : '';
    text(el.version, version);
    if (lastVersion !== null && version !== lastVersion) {
      // A real change landed: let the number show it.
      el.version.classList.remove('bump');
      void el.version.offsetWidth;
      el.version.classList.add('bump');
    }
    lastVersion = version;
    text(el.by, str(site.madeBy));
    el.byRow.hidden = !str(site.madeBy);
    const sections = Array.isArray(site.sections) ? site.sections.filter((s) => typeof s === 'string' && s) : [];
    el.sectionsRow.hidden = sections.length === 0;
    const have = [...el.sections.children].map((li) => li.textContent);
    if (have.length !== sections.length || have.some((s, i) => s !== sections[i])) {
      el.sections.replaceChildren(...sections.map((name) => {
        const li = document.createElement('li');
        li.textContent = name;
        if (!have.includes(name) && have.length) li.className = 'fresh';
        return li;
      }));
    }
  };

  const drawAddress = () => {
    const url = site ? webUrl(site.url) : null;
    el.address.hidden = !url;
    if (!url) { el.address.removeAttribute('href'); return; }
    if (el.address.getAttribute('href') === url) return;
    el.address.href = url;
    // Let a long address break after a dot or a slash rather than in the middle of a word.
    el.address.replaceChildren(...bare(url).split(/(?<=[./])/).flatMap((part, i) => (i ? [document.createElement('wbr'), part] : [part])));
  };

  const draw = () => {
    const d = derive();
    if (d.phase !== 'idle') { countRevisions(d); remember(d); }

    el.stage.dataset.phase = d.phase;
    el.stage.dataset.tone = d.tone;
    el.stage.dataset.site = site ? str(site.status) : '';
    el.stage.dataset.line = d.line ? d.line.key : '';
    text(el.tag, d.tag);
    text(el.who, d.who);
    el.clock.hidden = d.phase === 'idle';
    text(el.outcome, d.outcome);
    el.outcome.hidden = !d.outcome;

    if (el.headline.textContent !== d.headline) {
      el.headline.textContent = d.headline;
      // The headline changes only when the real stage changes, so this is the one moment that moves.
      el.headline.classList.remove('swap');
      void el.headline.offsetWidth;
      el.headline.classList.add('swap');
    }
    text(el.kicker, d.kicker);
    el.kicker.hidden = !d.kicker;
    text(el.detail, d.detail);
    el.detailLine.dataset.strong = String(d.strong);
    el.detailLine.hidden = !d.detail && !d.kicker;

    drawAddress();
    drawFacts();
    drawSequence(d);

    // One short sentence for screen readers, rewritten only when it changes.
    const spoken = d.phase === 'idle' ? '' : [d.tag, d.outcome, d.headline, d.strong ? d.detail : '', el.address.hidden ? '' : el.address.textContent].filter(Boolean).map((part) => (/[.!?”]$/.test(part) ? part : `${part}.`)).join(' ');
    text(el.live, spoken);
  };

  // -------------------------------------------------------- phone frame ----

  const LOGICAL_WIDTH = 390; // the preview is laid out as a phone this wide, then scaled to the frame
  const fit = () => {
    const w = el.screen.clientWidth;
    const h = el.screen.clientHeight;
    if (!w || !h) return;
    const scale = w / LOGICAL_WIDTH;
    el.frame.style.width = `${LOGICAL_WIDTH}px`;
    el.frame.style.height = `${Math.ceil(h / scale)}px`;
    el.frame.style.transform = `scale(${scale})`;
  };
  if ('ResizeObserver' in window) new ResizeObserver(fit).observe(el.screen);
  else window.addEventListener('resize', fit);

  // The preview page streams and refreshes itself, so the address is set once and then left alone.
  const frame = (target) => {
    const url = target ? webUrl(target.previewUrl) : null;
    if (!url) return false;
    const name = str(target.name) || 'the site';
    text(el.cap, `Live preview: ${name}`);
    el.frame.title = `Live preview of ${name}`;
    if (el.open.getAttribute('href') !== url) el.open.href = url;
    el.open.hidden = false;
    if (url !== framed) {
      framed = url;
      el.frame.src = url;
      el.frame.hidden = false;
      el.phone.dataset.on = 'true';
      text(el.idleText, 'Loading the preview…');
      fit();
    }
    return true;
  };

  const unframe = () => {
    framed = '';
    el.frame.hidden = true;
    el.frame.removeAttribute('src');
    el.phone.dataset.on = 'false';
    el.open.hidden = true;
    el.open.removeAttribute('href');
    text(el.cap, IDLE.cap);
    text(el.idleText, IDLE.phone);
  };

  // ---------------------------------------------------------------- api ----

  const api = {
    /** Every change of the call, from call.js. `null` clears the board. */
    call(next) {
      if (!next) {
        snap = null;
        site = null;
        Object.assign(seen, { callId: null, index: -1, at: {}, revisions: 0, revisionKey: '' });
        draw();
        return;
      }
      if (next.id !== seen.callId) {
        Object.assign(seen, { callId: next.id, index: -1, at: {}, revisions: 0, revisionKey: '' });
        site = null;
        lastVersion = null;
        // A new call starts with an empty frame; the last call's site stays in the list below.
        unframe();
      }
      snap = next;
      if (next.site && typeof next.site === 'object') {
        const fresh = !site || site.slug !== next.site.slug;
        site = next.site;
        if (fresh) frame(site);
      }
      if (!framed) text(el.idleText, next.phase === 'live' ? 'The website appears here as soon as the caller says the business name.' : IDLE.phone);
      draw();
    },

    /** The sites list, from sites.js: keeps the board's site current after the call is over. */
    sites(list) {
      if (!snap || snap.phase === 'live' || !site || !Array.isArray(list)) return;
      const fresh = list.find((s) => s && s.slug === site.slug);
      if (!fresh) return;
      site = fresh;
      draw();
    },

    /** Put any site's live preview in the phone frame (the "Show in frame" buttons). */
    frame(target) { return frame(target); },

    /** The preview address in the frame, so the list can mark which site is on show. */
    framed: () => framed,
  };

  window.LaunchpadStage = api;
  draw();
})();
