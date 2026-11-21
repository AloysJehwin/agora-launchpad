// The lead store behind every site's admin panel: one JSON file per site (sites/<slug>/crm.json).
// Small on purpose. A lead is one person who talked to the site's assistant, left a message,
// or was phoned back.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { siteDir } from './sites.mjs';

const STATUSES = ['new', 'contacted', 'won', 'lost'];
const cache = new Map(); // slug -> { leads: [] }
const writing = new Map(); // slug -> Promise, so writes never interleave

const file = (slug) => join(siteDir(slug), 'crm.json');
const cap = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const load = async (slug) => {
  if (cache.has(slug)) return cache.get(slug);
  let data = { leads: [] };
  if (existsSync(file(slug))) {
    try { data = JSON.parse(await readFile(file(slug), 'utf8')); } catch { /* start fresh on a corrupt file */ }
  }
  if (!Array.isArray(data.leads)) data.leads = [];
  cache.set(slug, data);
  return data;
};

const save = (slug) => {
  const next = (writing.get(slug) ?? Promise.resolve()).then(async () => {
    await mkdir(siteDir(slug), { recursive: true });
    await writeFile(file(slug), JSON.stringify(cache.get(slug), null, 2));
  }).catch((err) => console.warn(`crm save ${slug}: ${err.message}`));
  writing.set(slug, next);
  return next;
};

export const listLeads = async (slug) => {
  const { leads } = await load(slug);
  const sorted = [...leads].sort((a, b) => b.createdAt - a.createdAt);
  const counts = { total: sorted.length, new: 0, contacted: 0, won: 0, lost: 0 };
  for (const l of sorted) counts[l.status] = (counts[l.status] ?? 0) + 1;
  return { leads: sorted, counts };
};

export const getLead = async (slug, id) => (await load(slug)).leads.find((l) => l.id === id) ?? null;
export const leadForTalk = async (slug, talkId) => (await load(slug)).leads.find((l) => l.talkId === talkId) ?? null;

export const addLead = async (slug, fields) => {
  const data = await load(slug);
  const now = Date.now();
  const lead = {
    id: randomBytes(8).toString('hex'), createdAt: now, updatedAt: now,
    name: cap(fields.name, 80), phone: cap(fields.phone, 32), email: cap(fields.email, 120),
    source: ['voice', 'form', 'call'].includes(fields.source) ? fields.source : 'form',
    lang: cap(fields.lang, 12) || 'en', summary: cap(fields.summary, 400), message: cap(fields.message, 2000),
    status: 'new', notes: [], transcript: [], messages: [], talkId: fields.talkId ?? null,
  };
  data.leads.push(lead);
  if (data.leads.length > 500) data.leads.splice(0, data.leads.length - 500);
  await save(slug);
  return lead;
};

/** Merge details into a lead: empty values never overwrite what is already known. */
export const updateLead = async (slug, id, patch = {}, by = 'system') => {
  const lead = await getLead(slug, id);
  if (!lead) return null;
  for (const [key, max] of [['name', 80], ['phone', 32], ['email', 120], ['summary', 400], ['lang', 12]]) {
    const value = cap(patch[key], max);
    if (value) lead[key] = value;
  }
  if (patch.status && STATUSES.includes(patch.status)) lead.status = patch.status;
  if (cap(patch.note, 1000)) lead.notes.push({ at: Date.now(), text: cap(patch.note, 1000), by });
  if (patch.outMessage) lead.messages.push({ at: Date.now(), direction: 'out', channel: 'sms', text: cap(patch.outMessage.text, 600), status: patch.outMessage.status ?? 'sent' });
  lead.updatedAt = Date.now();
  await save(slug);
  return lead;
};

export const appendTranscript = async (slug, id, lines) => {
  const lead = await getLead(slug, id);
  if (!lead) return null;
  for (const line of (Array.isArray(lines) ? lines : []).slice(0, 40)) {
    const text = cap(line?.text, 1200);
    if (!text) continue;
    lead.transcript.push({ role: line.role === 'assistant' ? 'assistant' : 'visitor', text, at: Date.now() });
  }
  if (lead.transcript.length > 400) lead.transcript.splice(0, lead.transcript.length - 400);
  lead.updatedAt = Date.now();
  await save(slug);
  return lead;
};
