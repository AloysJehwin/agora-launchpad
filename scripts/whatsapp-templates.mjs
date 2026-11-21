#!/usr/bin/env node
// Creates Launchpad's WhatsApp templates in Twilio and submits them to Meta for approval.
//
//   node scripts/whatsapp-templates.mjs            list our templates and their approval status
//   node scripts/whatsapp-templates.mjs --submit   create any that are missing and submit them
//
// Safe to re-run: a template that already exists (same name) is left alone.
import { env } from '../server/env.mjs';
import { TEMPLATES } from '../server/whatsapp-templates.mjs';

const SUBMIT = process.argv.includes('--submit');
if (!env.twilioSid || !env.twilioToken) { console.error('Missing in .env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN'); process.exit(1); }

const auth = `Basic ${Buffer.from(`${env.twilioSid}:${env.twilioToken}`).toString('base64')}`;
const api = async (path, body) => {
  const res = await fetch(`https://content.twilio.com/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: auth, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio ${res.status}${data.code ? ` (error ${data.code})` : ''}: ${data.message ?? 'request failed'}`);
  return data;
};

const existing = async () => {
  const out = new Map();
  let url = '/ContentAndApprovals?PageSize=100';
  while (url) {
    const page = await api(url);
    for (const c of page.contents ?? []) if (/^launchpad_/.test(c.friendly_name ?? '')) out.set(c.friendly_name, c);
    const next = page.meta?.next_page_url;
    url = next ? next.replace('https://content.twilio.com/v1', '') : null;
  }
  return out;
};

const have = await existing();
let failed = 0;

for (const t of Object.values(TEMPLATES)) {
  let current = have.get(t.name);
  if (!current && SUBMIT) {
    try {
      const created = await api('/Content', { friendly_name: t.name, language: t.language, variables: t.variables, types: t.types });
      const approval = await api(`/Content/${created.sid}/ApprovalRequests/whatsapp`, { name: t.name, category: t.category });
      current = { sid: created.sid, approval_requests: approval };
      console.log(`submitted  ${t.name.padEnd(34)} ${created.sid}  ${approval.status ?? 'received'}`);
      continue;
    } catch (err) {
      failed += 1;
      console.log(`FAILED     ${t.name.padEnd(34)} ${err.message}`);
      continue;
    }
  }
  const a = current?.approval_requests ?? {};
  console.log(`${(current ? (a.status ?? 'created') : 'missing').padEnd(10)} ${t.name.padEnd(34)} ${current?.sid ?? ''}  ${a.rejection_reason ?? ''}`.trimEnd());
}

if (!SUBMIT && [...Object.values(TEMPLATES)].some((t) => !have.has(t.name))) console.log('\nRun with --submit to create the missing ones and send them to Meta.');
process.exit(failed ? 1 : 0);
