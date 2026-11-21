// Call launcher: asks the server to dial a number, then follows the call by polling and hands
// every change to the live stage (stage.js) to draw.
// Self-contained on purpose. app.js is also a classic script, so everything here stays inside
// one function scope to keep its top-level names (`$`, `el`, `post`, ...) from colliding.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    form: $('call-form'), to: $('call-to'), name: $('call-name'), toError: $('call-to-error'), toHelp: $('call-to-help'),
    toggle: $('call-toggle'), statusLine: $('call-status-line'), status: $('call-status'),
    timer: $('call-timer'), notice: $('call-notice'), meta: $('call-meta'),
  };
  if (!el.form) return;

  const E164 = /^\+[1-9][0-9]{6,14}$/;
  const POLL_MS = 2000;
  const POLL_TIMEOUT_MS = 8000;
  const MAX_POLL_FAILURES = 3;
  const HOLD_MS = 1500; // after the button changes meaning, clicks are ignored this long
  const ENDED = new Set(['STOPPED', 'IDLE']);
  const ACTIVE = new Set(['STARTING', 'RUNNING']);
  const LAST_KEY = 'voice.call.last'; // localStorage: the last number and name typed
  const LIVE_KEY = 'voice.call.live'; // sessionStorage: the live call, so a reload keeps the End call button
  const LOST = `Lost contact with the server after ${MAX_POLL_FAILURES} tries, so this page stopped checking. `
    + 'The call may still be going. Try End call, or it ends on its own at the server\'s time limit.';
  const HELP = el.toHelp ? el.toHelp.textContent : '';

  const call = {
    ready: false,   // phone.ready from /api/health
    from: null,     // masked caller ID from /api/health
    busy: false,    // a start or stop request is in flight (also the double-submit guard)
    id: null,       // callId while a call is live
    to: null,       // masked destination
    t0: 0,          // this browser's clock when the call was placed
    status: '',     // last status the server reported; empty until the first report
    phone: null,    // what the phone network reported, when the server has it
    site: null,     // the website this call is building, once there is one
    adopted: false, // the call was placed elsewhere and picked up from the recent calls list
    fresh: false,   // this page placed the call and has watched it from the first second
    ending: false,  // the user asked to hang up and the server accepted
    stopError: '',  // why the last hang-up attempt did not work
    lost: false,    // polling gave up after repeated failures
    failures: 0,    // consecutive failed polls
    run: 0,         // bumped to retire an older polling chain
    holdUntil: 0,   // the button just changed between Call and End call: ignore clicks until then
    pollTimer: 0,
    tick: 0,
  };
  const dismissed = new Set(); // calls that are over as far as this page is concerned: never pick them up again

  // ------------------------------------------------------------ helpers ----

  // Storage is a convenience. Private windows and blocked site data can make even the accessor throw.
  const remember = (area, key, value) => {
    try {
      if (value === null) window[area].removeItem(key);
      else window[area].setItem(key, JSON.stringify(value));
    } catch { /* carry on without it */ }
  };
  const recall = (area, key) => {
    try { return JSON.parse(window[area].getItem(key)); } catch { return null; }
  };

  // GET when body is undefined, JSON POST otherwise. Rejects with `.status` set when the server answered with an error.
  const request = async (path, body, timeoutMs) => {
    const options = body === undefined
      ? {}
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    let timer = 0;
    if (timeoutMs) {
      const abort = new AbortController();
      options.signal = abort.signal;
      timer = setTimeout(() => abort.abort(), timeoutMs);
    }
    try {
      const res = await fetch(path, options);
      const data = (await res.json().catch(() => null)) ?? {};
      if (!res.ok) {
        const message = typeof data.error === 'string' && data.error ? data.error : `The server answered with status ${res.status}.`;
        throw Object.assign(new Error(message), { status: res.status });
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  };
  const explain = (err) => (typeof err.status === 'number' ? err.message : 'Cannot reach the server. Is it running?');
  const sentence = (text) => (/[.!?…]$/.test(text) ? text : `${text}.`);

  // Spaces, dashes, dots and brackets are fine. A bare ten-digit number is Indian, so it gets +91.
  const normalise = (value) => {
    const to = value.replace(/[\s\-().]/g, '');
    return /^[0-9]{10}$/.test(to) ? `+91${to}` : to;
  };
  const check = (to) => {
    if (!to) return 'Enter the phone number to call.';
    if (!to.startsWith('+')) return 'Enter ten digits for an Indian number, or start with + and the country code, for example +14155550123.';
    if (!E164.test(to)) return 'That is not a full international number. After the +, use 7 to 15 digits with no leading zero.';
    return null;
  };
  // Same shape the server uses: country prefix and last two digits stay readable.
  const mask = (to) => `${to.slice(0, 3)}${'•'.repeat(Math.max(0, to.length - 5))}${to.slice(-2)}`;
  const clock = (ms) => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };

  // ------------------------------------------------------------- render ----

  const say = (text, tone) => {
    // Rewriting identical text would make screen readers announce it again on every poll.
    if (el.status.textContent !== text) el.status.textContent = text;
    el.statusLine.dataset.tone = tone ?? '';
  };

  const fieldError = (message) => {
    el.toError.textContent = message ?? '';
    el.toError.hidden = !message;
    if (message) {
      el.to.setAttribute('aria-invalid', 'true');
      el.to.setAttribute('aria-describedby', 'call-to-error call-to-help');
    } else {
      el.to.removeAttribute('aria-invalid');
      el.to.setAttribute('aria-describedby', 'call-to-help');
    }
  };

  // Ten digits are rewritten before dialing, so say what will actually be dialed.
  const paintHelp = () => {
    if (!el.toHelp) return;
    const raw = el.to.value.replace(/[\s\-().]/g, '');
    const text = /^[0-9]{10}$/.test(raw) ? `Ten digits, so this dials India: +91 ${raw.slice(0, 5)} ${raw.slice(5)}.` : HELP;
    if (el.toHelp.textContent !== text) el.toHelp.textContent = text;
  };

  const paintControls = () => {
    const live = call.id !== null;
    el.form.dataset.ready = String(call.ready);
    el.form.dataset.live = String(live);
    el.toggle.textContent = live ? 'End call' : 'Call';
    el.toggle.dataset.active = String(live);
    el.toggle.disabled = !call.ready || call.busy;
    // Locked during a call: the number cannot change, and Enter in a field must not hang up.
    el.to.disabled = !call.ready || call.busy || live;
    el.name.disabled = el.to.disabled;
  };

  // The timer sits outside the live region, so it can tick every second without being read out.
  const startTimer = () => {
    if (call.tick) return;
    const paint = () => { el.timer.textContent = clock(Date.now() - call.t0); };
    paint();
    call.tick = setInterval(paint, 1000);
  };
  // Stopping leaves the last reading on the stage: it is how long the call had been going.
  const stopTimer = () => {
    clearInterval(call.tick);
    call.tick = 0;
  };

  // Hands the stage everything the API has said about this call. The stage only draws it.
  const show = (extra) => {
    window.LaunchpadStage?.call({
      id: call.id, phase: 'live', status: call.status, ending: call.ending, lost: call.lost,
      to: call.to, from: call.from, t0: call.t0, phone: call.phone, site: call.site, fresh: call.fresh,
      text: call.lost ? LOST : '', ...extra,
    });
  };

  const dialing = () => `Dialing ${call.to ?? 'the number'}${call.from ? ` from ${call.from}` : ''}…`;

  // RUNNING only means the session is live. The API cannot say whether anyone picked up, so the copy does not either.
  const paintLive = () => {
    if (!call.ending && !call.lost) startTimer();
    else stopTimer();
    show();
    if (call.lost) return say(LOST, 'error');
    if (call.ending || call.status === 'STOPPING') return say('Ending the call…');
    let text = 'Waiting for the call status…';
    if (call.status === 'RUNNING') {
      text = call.adopted
        ? 'Following a call placed from the public page or another window. Press End call to hang it up.'
        : 'Call in progress. Press End call to hang up.';
    } else if (call.status === 'STARTING') text = dialing();
    return say(call.stopError ? `${call.stopError} ${text}` : text, call.stopError ? 'error' : '');
  };

  // ------------------------------------------------------- call lifecycle ----

  // `outcome` is what the stage keeps showing: { phase: 'ended' | 'failed', text, ms }, or null to clear it.
  const finish = (text, tone, outcome) => {
    call.run += 1;
    clearTimeout(call.pollTimer);
    stopTimer();
    if (call.id !== null) dismissed.add(call.id);
    if (outcome) {
      if (Number.isFinite(outcome.ms) && outcome.ms > 0) el.timer.textContent = clock(outcome.ms);
      show({ phase: outcome.phase, text: outcome.text, ending: false, lost: false });
    } else {
      window.LaunchpadStage?.call(null);
    }
    Object.assign(call, {
      id: null, to: null, status: '', phone: null, site: null, adopted: false, fresh: false,
      ending: false, stopError: '', lost: false, failures: 0, holdUntil: Date.now() + HOLD_MS,
    });
    remember('sessionStorage', LIVE_KEY, null);
    say(text, tone);
    paintControls();
  };

  const apply = (data) => {
    const status = typeof data.status === 'string' ? data.status.toUpperCase() : '';
    if (typeof data.to === 'string' && data.to) call.to = data.to;
    call.phone = data.phone && typeof data.phone === 'object' ? data.phone : null;
    if (data.site && typeof data.site === 'object') call.site = data.site;
    const message = typeof data.message === 'string' ? data.message.trim() : '';
    const span = Number(data.endedAt) - Number(data.startedAt); // both from the server's clock
    if (status === 'FAILED') {
      return finish(message ? `Call failed: ${message}` : 'Call failed.', 'error', { phase: 'failed', text: message, ms: span });
    }
    if (ENDED.has(status)) {
      // The server says how it ended ("Nobody answered.", "The call ended after 5 min 46 s."); fall back to the clock.
      const text = message || (span > 0 ? `Call ended after ${clock(span)}` : 'Call ended');
      return finish(text, '', { phase: 'ended', text, ms: span });
    }
    call.status = status;
    return paintLive();
  };

  const poll = async (run) => {
    let data = null;
    let failure = null;
    try {
      data = await request(`/api/call?id=${encodeURIComponent(call.id)}`, undefined, POLL_TIMEOUT_MS);
    } catch (err) {
      failure = err;
    }
    if (run !== call.run) return; // the call ended or a newer chain took over while this was in flight
    if (failure) {
      if (failure.status === 404) {
        // No status yet means this id came from a reload and the server has since forgotten it: drop it quietly.
        if (call.status) {
          const text = 'The server no longer has a record of this call.';
          finish(text, 'error', { phase: 'ended', text });
        } else finish('');
        return;
      }
      call.failures += 1;
      if (call.failures >= MAX_POLL_FAILURES) {
        call.lost = true;
        paintLive();
        return;
      }
    } else {
      call.failures = 0;
      apply(data);
      if (run !== call.run) return;
    }
    call.pollTimer = setTimeout(() => poll(run), POLL_MS);
  };

  const startPolling = (delay) => {
    call.run += 1;
    const run = call.run;
    clearTimeout(call.pollTimer);
    call.pollTimer = setTimeout(() => poll(run), delay);
  };

  // Both return the element that should take focus afterwards, or null.
  const dial = async (to) => {
    const name = el.name.value.trim();
    remember('localStorage', LAST_KEY, { to: el.to.value.trim(), name });
    call.to = mask(to);
    say(dialing());
    try {
      const lang = document.getElementById('call-lang')?.value || 'en';
      const data = await request('/api/call', name ? { to, name, lang } : { to, lang });
      // status 0 marks this as the server's answer rather than a network failure, so explain() keeps the message.
      if (!data.callId) throw Object.assign(new Error('The server did not return a call id.'), { status: 0 });
      const status = typeof data.status === 'string' ? data.status.toUpperCase() : '';
      Object.assign(call, {
        id: String(data.callId), t0: Date.now(), status: status === 'RUNNING' ? 'RUNNING' : 'STARTING',
        phone: null, site: null, adopted: false, fresh: true,
        ending: false, stopError: '', lost: false, failures: 0, holdUntil: Date.now() + HOLD_MS,
      });
      remember('sessionStorage', LIVE_KEY, { id: call.id, t0: call.t0, to: call.to });
      paintLive();
      startPolling(POLL_MS);
    } catch (err) {
      call.to = null;
      if (err.status === 400) {
        say('');
        fieldError(err.message);
        return el.to;
      }
      say(`Could not place the call: ${sentence(explain(err))}`, 'error');
    }
    return null;
  };

  const hangUp = async () => {
    const id = call.id;
    call.stopError = '';
    call.ending = true;
    paintLive();
    try {
      const data = await request('/api/call/stop', { callId: id });
      if (call.id !== id) return null; // a poll saw the call end while this was in flight
      if (data.stopped === false) {
        // Either it had already ended (the next poll will say so) or the server could not stop it.
        call.ending = false;
        call.stopError = 'The server did not end the call.';
      }
      call.lost = false;
      call.failures = 0;
      paintLive();
      startPolling(0);
    } catch (err) {
      if (call.id !== id) return null;
      call.ending = false;
      if (call.lost) {
        const text = 'Could not reach the server to end the call. It ends on its own at the server\'s time limit.';
        finish(text, 'error', { phase: 'ended', text });
      } else {
        call.stopError = `Could not end the call: ${sentence(explain(err))}`;
        paintLive();
      }
    }
    return null;
  };

  // --------------------------------------------------------------- events ----

  // Returns the number to dial, or null after showing why it cannot be dialed.
  const validated = () => {
    const to = normalise(el.to.value);
    const problem = check(to);
    if (problem) {
      fieldError(problem);
      el.to.focus();
      return null;
    }
    fieldError(null);
    return to;
  };

  // A call costs money and rings a real person, so only a deliberate press of the button places one:
  // a single click (or Enter or Space on the button), never the second click of a double click, and
  // never within a moment of the button having changed between Call and End call.
  el.toggle.addEventListener('click', async (event) => {
    if (!call.ready || call.busy) return;
    if (event.detail > 1 || Date.now() < call.holdUntil) return;

    let to = null;
    if (call.id === null) {
      to = validated();
      if (!to) return;
    }

    // Disabling the controls during the request drops keyboard focus; hand it back afterwards.
    const hadFocus = el.form.contains(document.activeElement);
    call.busy = true;
    paintControls();
    let focusTarget = null;
    try {
      focusTarget = await (call.id === null ? dial(to) : hangUp());
    } finally {
      call.busy = false;
      paintControls();
      const active = document.activeElement;
      const adrift = !active || active === document.body || active.disabled;
      if (focusTarget) focusTarget.focus();
      else if (hadFocus && adrift) el.toggle.focus();
    }
  });

  // Enter in a field never dials. It checks the number and moves to the Call button, which is one more press.
  const toButton = (event) => {
    event.preventDefault();
    if (!call.ready || call.busy || call.id !== null) return;
    if (validated()) el.toggle.focus();
  };
  el.form.addEventListener('submit', toButton);
  for (const field of [el.to, el.name]) {
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) toButton(event);
    });
  }

  el.to.addEventListener('input', () => {
    if (el.to.getAttribute('aria-invalid') === 'true') fieldError(null);
    paintHelp();
  });

  // No pagehide handler on purpose: a phone call should survive the tab closing.
  // The server enforces a maximum duration, and a reload picks the call up again below.

  // ----------------------------------------------------------------- init ----

  const block = (message) => {
    call.ready = false;
    el.notice.textContent = message;
    el.notice.hidden = false;
    paintControls();
  };

  const resume = () => {
    const saved = recall('sessionStorage', LIVE_KEY);
    if (!saved || typeof saved.id !== 'string' || !saved.id) return;
    Object.assign(call, {
      id: saved.id, t0: Number(saved.t0) || Date.now(), to: typeof saved.to === 'string' ? saved.to : null, status: '',
    });
    paintControls();
    paintLive();
    startPolling(0);
  };

  // The server runs one call at a time. If one is live that this page did not place (the public
  // front page, another window), follow it here: the stage shows it and End call can hang it up.
  // sites.js passes the recent calls list in on every refresh.
  const follow = (calls) => {
    if (!call.ready || call.busy || call.id !== null || !Array.isArray(calls)) return;
    const live = calls.find((c) => c && typeof c.callId === 'string' && c.callId && !dismissed.has(c.callId)
      && ACTIVE.has(typeof c.status === 'string' ? c.status.toUpperCase() : ''));
    if (!live) return;
    Object.assign(call, {
      id: live.callId, t0: Number(live.startedAt) || Date.now(), to: typeof live.to === 'string' ? live.to : null,
      status: '', phone: null, site: null, adopted: true,
      ending: false, stopError: '', lost: false, failures: 0, holdUntil: Date.now() + HOLD_MS,
    });
    fieldError(null);
    paintControls();
    apply(live);
    if (call.id !== null) startPolling(POLL_MS);
  };
  window.LaunchpadCall = { follow };

  const init = async () => {
    const last = recall('localStorage', LAST_KEY);
    if (last && typeof last === 'object') {
      if (typeof last.to === 'string') el.to.value = last.to;
      if (typeof last.name === 'string') el.name.value = last.name;
    }
    paintHelp();

    let res;
    try {
      res = await fetch('/api/health');
    } catch {
      return block('Phone calling is not available: cannot reach the server.');
    }
    // An older server has no `phone` key (or no JSON at all); both mean the feature is not there.
    const phone = (await res.json().catch(() => null))?.phone;
    if (!phone || typeof phone !== 'object') return block('Phone calling is not available on this server.');

    call.from = typeof phone.from === 'string' && phone.from ? phone.from : null;
    const facts = [];
    if (phone.voiceModel) facts.push(`Model on the call: ${phone.voiceModel}`);
    if (call.from) facts.push(`Caller ID: ${call.from}`);
    el.meta.textContent = facts.join(' · ');
    el.meta.hidden = facts.length === 0;

    if (!phone.ready) {
      const missing = Array.isArray(phone.missing) ? phone.missing.filter(Boolean) : [];
      const hint = typeof phone.hint === 'string' && phone.hint ? ` ${phone.hint}` : '';
      return block(missing.length
        ? `Phone calling is not set up yet. Missing in .env: ${missing.join(', ')}.${hint}`
        : `Phone calling is not set up yet.${hint}`);
    }

    call.ready = true;
    paintControls();
    return resume();
  };

  init();
})();
