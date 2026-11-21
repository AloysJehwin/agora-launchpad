// Console helper: fills the language picker and lists the websites built on calls, live.
(() => {
  const list = document.getElementById('sites');
  const empty = document.getElementById('sites-empty');
  const note = document.getElementById('sites-note');
  const lang = document.getElementById('call-lang');
  if (!list) return;

  const LABEL = { designing: 'Designing', ready: 'Preview ready', revising: 'Updating', published: 'Published', failed: 'Failed' };
  const link = (href, text) => { const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = text; return a; };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  const render = (sites) => {
    empty.hidden = sites.length > 0;
    list.replaceChildren(...sites.slice(0, 8).map((s) => {
      const li = el('li'); li.dataset.status = s.status;
      const head = el('div', 'site-head');
      head.append(el('span', 'site-name', s.name), el('span', 'site-status', (LABEL[s.status] ?? s.status) + (s.step && s.status !== 'ready' && s.status !== 'published' ? `: ${s.step}` : '')));
      const links = el('div', 'site-links');
      links.append(link(s.previewUrl, 'Open live preview'));
      if (s.url) links.append(link(s.url, s.url.replace(/^https?:\/\//, '')));
      const meta = el('div', 'site-meta', [s.madeBy ? `Designed by ${s.madeBy}` : '', s.lang ? `language ${s.lang}` : '', s.unpublishedChanges ? 'has changes not yet published' : '', s.error ?? ''].filter(Boolean).join(' · '));
      li.append(head, links, meta);
      return li;
    }));
  };

  const tick = async () => {
    try {
      const data = await fetch('/api/sites').then((r) => r.json());
      render(data.sites ?? []);
    } catch { /* the console keeps its last list */ }
  };

  fetch('/api/health').then((r) => r.json()).then((h) => {
    const phone = h.phone ?? {};
    if (lang && Array.isArray(phone.languages)) {
      const keep = (() => { try { return localStorage.getItem('call-lang'); } catch { return null; } })();
      lang.replaceChildren(...phone.languages.map((l) => { const o = document.createElement('option'); o.value = l.code; o.textContent = l.label + (l.experimental ? ' (experimental)' : ''); return o; }));
      if (keep && phone.languages.some((l) => l.code === keep)) lang.value = keep;
      lang.addEventListener('change', () => { try { localStorage.setItem('call-lang', lang.value); } catch { /* optional */ } });
    }
    note.textContent = phone.websiteTools
      ? 'The agent can build, change and publish websites during a call.'
      : 'Website building is off: this server has no public address for the agent to reach (PUBLIC_URL and TOOL_SECRET).';
  }).catch(() => {});

  const wa = document.getElementById('wa-list');
  const templates = async () => {
    if (!wa) return;
    try {
      const data = await fetch('/api/whatsapp').then((r) => r.json());
      wa.replaceChildren(...(data.templates ?? []).map((t) => {
        const li = el('li'); li.dataset.status = t.status === 'approved' ? 'published' : t.status === 'rejected' ? 'failed' : 'designing';
        const head = el('div', 'site-head');
        head.append(el('span', 'site-name', t.name), el('span', 'site-status', t.status));
        li.append(head);
        if (t.reason) li.append(el('div', 'site-meta', t.reason));
        return li;
      }));
    } catch { /* keep the last list */ }
  };
  wa?.setAttribute('id', 'wa-list');
  templates();
  setInterval(templates, 60000);

  const callsList = document.getElementById('calls-list');
  const calls = async () => {
    if (!callsList) return;
    try {
      const data = await fetch('/api/calls').then((r) => r.json());
      callsList.replaceChildren(...(data.calls ?? []).map((c) => {
        const li = el('li'); li.dataset.status = c.status === 'FAILED' ? 'failed' : c.endedAt ? 'published' : 'designing';
        const head = el('div', 'site-head');
        const outcome = c.phone ? (c.phone.state === 'ended' ? `ended: ${(c.phone.hangupReason ?? 'unknown').toLowerCase().replace(/_/g, ' ')}${c.phone.seconds != null ? `, ${Math.round(c.phone.seconds)} s connected` : ''}` : c.phone.state) : c.status.toLowerCase();
        head.append(el('span', 'site-name', `${c.to} at ${new Date(c.startedAt).toLocaleTimeString()}`), el('span', 'site-status', outcome));
        li.append(head);
        if (c.site) li.append(el('div', 'site-meta', `Built: ${c.site.name} (${c.site.status})`));
        for (const e of c.errors ?? []) li.append(el('div', 'site-meta', `Error${e.module ? ` in ${e.module}` : ''}: ${e.message}`));
        for (const t of (c.transcript ?? []).slice(-30)) li.append(el('div', 'site-meta', `${t.role === 'assistant' ? 'Agent' : 'Caller'}: ${t.text}`));
        return li;
      }));
    } catch { /* keep the last list */ }
  };
  calls();
  setInterval(calls, 5000);

  tick();
  setInterval(tick, 3000);
})();
