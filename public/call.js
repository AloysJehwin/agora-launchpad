// "Call a phone" panel: asks the server to dial a number, then follows the call by polling.
// Self-contained on purpose. app.js is also a classic script, so everything here stays inside
// one function scope to keep its top-level names (`$`, `el`, `post`, ...) from colliding.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    form: $('call-form'), to: $('call-to'), name: $('call-name'), toError: $('call-to-error'),
    toggle: $('call-toggle'), statusLine: $('call-status-line'), status: $('call-status'),
    timer: $('call-timer'), notice: $('call-notice'), meta: $('call-meta'),
  };
  if (!el.form) return;

  const E164 = /^\+[1-9][0-9]{6,14}$/;
  const POLL_MS = 2000;
  const POLL_TIMEOUT_MS = 8000;
  const MAX_POLL_FAILURES = 3;
  const ENDED = new Set(['STOPPED', 'IDLE']);
  const LAST_KEY = 'voice.call.last'; // localStorage: the last number and name typed
  const LIVE_KEY = 'voice.call.live'; // sessionStorage: the live call, so a reload keeps the End call button
  const LOST = `Lost contact with the server after ${MAX_POLL_FAILURES} tries, so this page stopped checking. `
    + 'The call may still be going. Try End call, or it ends on its own at the server\'s time limit.';

  const call = {
    ready: false,   // phone.ready from /api/health
    from: null,     // masked caller ID from /api/health
    busy: false,    // a start or stop request is in flight (also the double-submit guard)
    id: null,       // callId while a call is live
    to: null,       // masked destination
    t0: 0,          // this browser's clock when the call was placed
    status: '',     // last status the server reported; empty until the first report
    ending: false,  // the user asked to hang up and the server accepted
    stopError: '',  // why the last hang-up attempt did not work
    lost: false,    // polling gave up after repeated failures
    failures: 0,    // consecutive failed polls
    run: 0,         // bumped to retire an older polling chain
    pollTimer: 0,
    tick: 0,
  };

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

  const normalise = (value) => value.replace(/[\s\-()]/g, '');
  const check = (to) => {
    if (!to) return 'Enter the phone number to call.';
    if (!to.startsWith('+')) return 'Start with + and the country code, for example +919812345678.';
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

  const paintControls = () => {
    const live = call.id !== null;
    el.form.dataset.ready = String(call.ready);
    el.toggle.textContent = live ? 'End call' : 'Call this number';
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
  const stopTimer = () => {
    clearInterval(call.tick);
    call.tick = 0;
    el.timer.textContent = '';
  };

  const dialing = () => `Dialing ${call.to ?? 'the number'}${call.from ? ` from ${call.from}` : ''}…`;

  // RUNNING only means the session is live. The API cannot say whether anyone picked up, so the copy does not either.
  const paintLive = () => {
    if (call.status === 'RUNNING' && !call.ending && !call.lost) startTimer();
    else stopTimer();
    if (call.lost) return say(LOST, 'error');
    if (call.ending || call.status === 'STOPPING') return say('Ending the call…');
    let text = 'Waiting for the call status…';
    if (call.status === 'RUNNING') text = 'Ringing or in the call';
    else if (call.status === 'STARTING') text = dialing();
    return say(call.stopError ? `${call.stopError} ${text}` : text, call.stopError ? 'error' : '');
  };

  // ------------------------------------------------------- call lifecycle ----

  const finish = (text, tone) => {
    call.run += 1;
    clearTimeout(call.pollTimer);
    stopTimer();
    Object.assign(call, { id: null, to: null, status: '', ending: false, stopError: '', lost: false, failures: 0 });
    remember('sessionStorage', LIVE_KEY, null);
    say(text, tone);
    paintControls();
  };

  const apply = (data) => {
    const status = typeof data.status === 'string' ? data.status.toUpperCase() : '';
    if (typeof data.to === 'string' && data.to) call.to = data.to;
    if (status === 'FAILED') return finish(data.message ? `Call failed: ${data.message}` : 'Call failed.', 'error');
    if (ENDED.has(status)) {
      const span = Number(data.endedAt) - Number(data.startedAt); // both from the server's clock
      return finish(span > 0 ? `Call ended after ${clock(span)}` : 'Call ended');
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
        if (call.status) finish('The server no longer has a record of this call.', 'error');
        else finish('');
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
    remember('localStorage', LAST_KEY, { to, name });
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
        ending: false, stopError: '', lost: false, failures: 0,
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
        finish('Could not reach the server to end the call. It ends on its own at the server\'s time limit.', 'error');
      } else {
        call.stopError = `Could not end the call: ${sentence(explain(err))}`;
        paintLive();
      }
    }
    return null;
  };

  // --------------------------------------------------------------- events ----

  el.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!call.ready || call.busy) return;

    let to = null;
    if (call.id === null) {
      to = normalise(el.to.value);
      const problem = check(to);
      if (problem) {
        fieldError(problem);
        el.to.focus();
        return;
      }
      fieldError(null);
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

  el.to.addEventListener('input', () => {
    if (el.to.getAttribute('aria-invalid') === 'true') fieldError(null);
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

  const init = async () => {
    const last = recall('localStorage', LAST_KEY);
    if (last && typeof last === 'object') {
      if (typeof last.to === 'string') el.to.value = last.to;
      if (typeof last.name === 'string') el.name.value = last.name;
    }

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
      return block(missing.length
        ? `Phone calling is not set up yet. Missing in .env: ${missing.join(', ')}.`
        : 'Phone calling is not set up yet.');
    }

    call.ready = true;
    paintControls();
    return resume();
  };

  init();
})();
