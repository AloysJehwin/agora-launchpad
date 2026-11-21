// Everything around the live call: the status strip, the language picker, the lists of sites,
// calls and WhatsApp templates, and the numbers the public front page may dial.
// All text from the API is inserted with textContent; addresses are checked before they become links.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const list = $('sites');
  if (!list) return;

  const node = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const webUrl = (value) => {
    if (typeof value !== 'string' || !value) return null;
    try {
      const url = new URL(value, window.location.href);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch { return null; }
  };
  const link = (href, text) => {
    const a = node('a', null, text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  };
  const getJson = async (path) => {
    const res = await fetch(path);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(data?.error || `The server answered with status ${res.status}.`), { status: res.status });
    return data ?? {};
  };
  // Lists are redrawn only when their data changed, so polling does not close an open transcript or drop focus.
  const changed = (() => {
    const last = new Map();
    return (key, data) => {
      const json = JSON.stringify(data);
      if (last.get(key) === json) return false;
      last.set(key, json);
      return true;
    };
  })();

  // -------------------------------------------------------------- health ----

  const pips = $('pips');
  const pip = (key, value, tone) => {
    const li = node('li');
    li.dataset.tone = tone;
    li.append(node('span', 'pip-k', key), ' ', node('span', 'pip-v', value));
    return li;
  };
  const lang = $('call-lang');
  const note = $('sites-note');

  const health = async () => {
    let h;
    try {
      h = await getJson('/api/health');
    } catch {
      pips?.replaceChildren(pip('Server', 'cannot be reached', 'bad'));
      return;
    }
    const phone = h.phone && typeof h.phone === 'object' ? h.phone : {};
    const missing = Array.isArray(h.missing) ? h.missing.filter(Boolean) : [];
    const items = [];
    if (!h.ok) items.push(pip('Server', missing.length ? `missing ${missing.join(', ')}` : 'not ready', 'bad'));
    items.push(pip('Phone line', phone.ready ? 'ready' : 'not set up', phone.ready ? 'ok' : 'bad'));
    if (typeof phone.from === 'string' && phone.from) items.push(pip('Caller ID', phone.from, 'ok'));
    items.push(pip('Website tools', phone.websiteTools ? 'on' : 'off', phone.websiteTools ? 'ok' : 'bad'));
    pips?.replaceChildren(...items);

    if (lang && Array.isArray(phone.languages) && phone.languages.length) {
      const keep = (() => { try { return localStorage.getItem('call-lang'); } catch { return null; } })();
      lang.replaceChildren(...phone.languages.map((l) => {
        const o = node('option', null, l.label + (l.experimental ? ' (experimental)' : ''));
        o.value = l.code;
        return o;
      }));
      if (keep && phone.languages.some((l) => l.code === keep)) lang.value = keep;
      lang.addEventListener('change', () => { try { localStorage.setItem('call-lang', lang.value); } catch { /* optional */ } });
    }
    if (note) {
      note.textContent = phone.websiteTools
        ? 'The agent can build, change and publish websites during a call.'
        : 'Website building is off: this server has no public address for the agent to reach (PUBLIC_URL and TOOL_SECRET).';
    }
  };

  // --------------------------------------------------------------- sites ----

  const empty = $('sites-empty');
  const LABEL = { collecting: 'Filling in', designing: 'Designing', ready: 'Preview ready', revising: 'Updating', published: 'Published', failed: 'Failed' };
  const TONE = { collecting: 'busy', designing: 'busy', revising: 'busy', ready: 'ok', published: 'live', failed: 'bad' };
  const MAX_SITES = 8;
  let sites = [];

  const renderSites = () => {
    empty.hidden = sites.length > 0;
    const onShow = window.LaunchpadStage?.framed() ?? '';
    list.replaceChildren(...sites.slice(0, MAX_SITES).map((s) => {
      const li = node('li', 'row');
      li.dataset.tone = TONE[s.status] ?? '';
      const busy = s.step && s.status !== 'ready' && s.status !== 'published';
      const head = node('div', 'row-head');
      head.append(node('span', 'row-name', s.name || s.slug || 'Unnamed site'), node('span', 'row-status', (LABEL[s.status] ?? String(s.status ?? '')) + (busy ? `: ${s.step}` : '')));

      const links = node('div', 'row-links');
      const preview = webUrl(s.previewUrl);
      const live = webUrl(s.url);
      if (live) links.append(link(live, live.replace(/^https?:\/\//, '').replace(/\/$/, '')));
      if (preview) {
        links.append(link(preview, 'Live preview'));
        const showing = preview === onShow;
        const button = node('button', 'quiet small', showing ? 'In the frame' : 'Show in frame');
        button.type = 'button';
        button.setAttribute('aria-pressed', String(showing));
        button.setAttribute('aria-label', `Show ${s.name || 'this site'} in the phone frame`);
        button.addEventListener('click', () => {
          if (window.LaunchpadStage?.frame(s)) {
            const label = button.getAttribute('aria-label');
            renderSites();
            // The list was redrawn, so hand keyboard focus back to the same button.
            [...list.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label)?.focus({ preventScroll: true });
            document.getElementById('phone')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
        });
        links.append(button);
      }

      const meta = [
        s.madeBy ? `Designed by ${s.madeBy}` : '',
        s.lang ? `language ${s.lang}` : '',
        Number.isFinite(Number(s.version)) && s.version != null ? `version ${s.version}` : '',
        s.unpublishedChanges ? 'has changes not yet published' : '',
      ].filter(Boolean).join(' · ');
      li.append(head, links);
      if (meta) li.append(node('div', 'row-meta', meta));
      if (s.error) li.append(node('div', 'row-meta row-error', s.error));
      return li;
    }));
    if (sites.length > MAX_SITES) list.append(node('li', 'row-more', `and ${sites.length - MAX_SITES} more`));
  };

  const tick = async () => {
    try {
      const data = await getJson('/api/sites');
      sites = Array.isArray(data.sites) ? data.sites.filter((s) => s && typeof s === 'object') : [];
      window.LaunchpadStage?.sites(sites);
      if (changed('sites', [sites, window.LaunchpadStage?.framed() ?? ''])) renderSites();
    } catch { /* the console keeps its last list */ }
  };

  // --------------------------------------------------------------- calls ----

  const callsList = $('calls-list');
  const callsEmpty = $('calls-empty');
  const openTranscripts = new Set(); // callIds whose transcript the operator opened

  const outcomeOf = (c) => {
    if (c.phone && typeof c.phone === 'object') {
      if (c.phone.state === 'ended') {
        const reason = String(c.phone.hangupReason ?? 'unknown').toLowerCase().replace(/[_-]/g, ' ');
        return `ended: ${reason}${c.phone.seconds != null ? `, ${Math.round(c.phone.seconds)} s connected` : ''}`;
      }
      return String(c.phone.state ?? '');
    }
    return String(c.status ?? '').toLowerCase();
  };

  const renderCalls = (calls) => {
    if (callsEmpty) callsEmpty.hidden = calls.length > 0;
    callsList.replaceChildren(...calls.map((c) => {
      const li = node('li', 'row');
      li.dataset.tone = c.status === 'FAILED' ? 'bad' : c.endedAt ? '' : 'busy';
      const head = node('div', 'row-head');
      const when = Number.isFinite(Number(c.startedAt)) ? ` at ${new Date(Number(c.startedAt)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
      head.append(node('span', 'row-name', `${c.to ?? 'Unknown number'}${when}`), node('span', 'row-status', outcomeOf(c)));
      li.append(head);
      if (typeof c.message === 'string' && c.message) li.append(node('div', 'row-meta', c.message));
      if (c.site) li.append(node('div', 'row-meta', `Built: ${c.site.name} (${LABEL[c.site.status] ?? c.site.status})`));
      for (const e of c.errors ?? []) li.append(node('div', 'row-meta row-error', `Error${e.module ? ` in ${e.module}` : ''}: ${e.message}`));
      const said = (c.transcript ?? []).slice(-30);
      if (said.length) {
        const details = node('details', 'said');
        details.open = openTranscripts.has(c.callId);
        details.addEventListener('toggle', () => { if (details.open) openTranscripts.add(c.callId); else openTranscripts.delete(c.callId); });
        details.append(node('summary', null, `What was said (${said.length} line${said.length === 1 ? '' : 's'})`));
        const lines = node('ol');
        for (const t of said) {
          const line = node('li');
          line.append(node('span', 'said-who', t.role === 'assistant' ? 'Agent' : 'Caller'), ' ', node('span', null, t.text));
          lines.append(line);
        }
        details.append(lines);
        li.append(details);
      }
      return li;
    }));
  };

  const calls = async () => {
    if (!callsList) return;
    try {
      const data = await getJson('/api/calls');
      const all = Array.isArray(data.calls) ? data.calls.filter((c) => c && typeof c === 'object') : [];
      window.LaunchpadCall?.follow(all);
      if (changed('calls', all)) renderCalls(all);
    } catch { /* keep the last list */ }
  };

  // ------------------------------------------------------------ whatsapp ----

  const wa = $('wa-list');
  const waEmpty = $('wa-empty');
  const templates = async () => {
    if (!wa) return;
    try {
      const data = await getJson('/api/whatsapp');
      const all = Array.isArray(data.templates) ? data.templates : [];
      if (!changed('wa', all)) return;
      if (waEmpty) waEmpty.hidden = all.length > 0;
      wa.replaceChildren(...all.map((t) => {
        const li = node('li', 'chip');
        li.dataset.tone = t.status === 'approved' ? 'ok' : t.status === 'rejected' ? 'bad' : 'busy';
        li.append(node('span', 'chip-k', t.name || t.key || 'template'), node('span', 'chip-v', String(t.status ?? 'unknown')));
        if (t.reason) li.append(node('span', 'chip-why', t.reason));
        return li;
      }));
    } catch { /* keep the last list */ }
  };

  // ---------------------------------------------------- front-page numbers ----

  const numbers = {
    panel: $('numbers'), list: $('numbers-list'), empty: $('numbers-empty'), form: $('numbers-form'),
    input: $('numbers-input'), add: $('numbers-add'), msg: $('numbers-msg'), busy: false,
  };

  const numbersSay = (text, tone) => {
    numbers.msg.textContent = text;
    numbers.msg.dataset.tone = tone ?? '';
    if (tone === 'error') numbers.input.setAttribute('aria-invalid', 'true');
    else numbers.input.removeAttribute('aria-invalid');
  };

  const post = async (path, body) => {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(data?.error || `The server answered with status ${res.status}.`), { status: res.status });
    return data ?? {};
  };

  const renderNumbers = (all) => {
    numbers.empty.hidden = all.length > 0;
    numbers.list.replaceChildren(...all.map((n) => {
      const li = node('li', 'chip');
      li.append(node('span', 'chip-k number', n.number));
      const remove = node('button', 'quiet small', 'Remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${n.number}`);
      remove.addEventListener('click', async () => {
        if (numbers.busy) return;
        numbers.busy = true;
        remove.disabled = true;
        try {
          const data = await post('/api/numbers/remove', { id: n.id });
          renderNumbers(Array.isArray(data.numbers) ? data.numbers : []);
          numbersSay(`Removed ${n.number}.`);
          numbers.input.focus();
        } catch (err) {
          remove.disabled = false;
          numbersSay(typeof err.status === 'number' ? err.message : 'Cannot reach the server.', 'error');
        } finally {
          numbers.busy = false;
        }
      });
      li.append(remove);
      return li;
    }));
  };

  const loadNumbers = async () => {
    if (!numbers.panel || !numbers.form) return;
    try {
      const data = await getJson('/api/numbers');
      renderNumbers(Array.isArray(data.numbers) ? data.numbers : []);
      numbers.panel.hidden = false;
    } catch {
      // 404 means this server does not have the feature yet; any other failure also leaves the block out.
      numbers.panel.hidden = true;
    }
  };

  numbers.form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (numbers.busy) return;
    const raw = numbers.input.value.trim();
    const digits = raw.replace(/[\s\-().]/g, '');
    if (!digits) return numbersSay('Enter a phone number to add.', 'error');
    if (!/^[0-9]{10}$/.test(digits) && !/^\+[1-9][0-9]{6,14}$/.test(digits)) {
      return numbersSay('Enter ten digits for an Indian number, or start with + and the country code.', 'error');
    }
    numbers.busy = true;
    numbers.add.disabled = true;
    try {
      const data = await post('/api/numbers', { number: digits });
      renderNumbers(Array.isArray(data.numbers) ? data.numbers : []);
      numbers.input.value = '';
      numbersSay('Added. The public page can now call it.');
    } catch (err) {
      numbersSay(typeof err.status === 'number' ? err.message : 'Cannot reach the server.', 'error');
    } finally {
      numbers.busy = false;
      numbers.add.disabled = false;
    }
    return undefined;
  });
  numbers.input?.addEventListener('input', () => { if (numbers.msg.dataset.tone === 'error') numbersSay(''); });

  // ---------------------------------------------------------------- start ----

  health();
  loadNumbers();
  templates();
  setInterval(templates, 60000);
  calls();
  setInterval(calls, 5000);
  tick();
  setInterval(tick, 3000);
})();
