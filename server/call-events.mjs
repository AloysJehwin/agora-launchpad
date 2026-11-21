// What Agora tells us about sessions after the fact, through its notification webhooks:
// whether a phone call was answered, why it ended, errors, and the transcript.
// Register https://<PUBLIC_HOST>/hooks/agora in the Agora console (Notifications) to receive them.
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env.mjs';

/** session id -> { states: [], call: {}, errors: [], transcript: [], raw: n } */
const sessions = new Map();
const seen = new Set(); // notice ids, for de-duplication (Agora retries)

const entry = (sid) => {
  if (!sessions.has(sid)) sessions.set(sid, { states: [], call: null, errors: [], transcript: [], events: 0, updatedAt: Date.now() });
  return sessions.get(sid);
};

/** True when the signature matches, or when no secret is configured (then events are informational only). */
export const signatureOk = (raw, headers) => {
  const secret = (process.env.AGORA_NCS_SECRET ?? '').trim();
  if (!secret) return true;
  const given = String(headers['agora-signature-v2'] ?? '');
  const want = createHmac('sha256', secret).update(raw).digest('hex');
  return given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
};

const lines = (payload) => {
  // The transcript's exact shape is not documented in detail; accept the common ones.
  const items = payload.transcript ?? payload.transcripts ?? payload.messages ?? payload.contents ?? [];
  return (Array.isArray(items) ? items : []).map((t) => ({
    role: /assistant|agent/i.test(String(t.role ?? t.speaker ?? '')) ? 'assistant' : 'caller',
    text: String(t.content ?? t.text ?? '').slice(0, 1200),
  })).filter((t) => t.text);
};

export const recordEvent = async (event) => {
  if (!event || typeof event !== 'object' || !event.sid) return;
  if (event.noticeId) { if (seen.has(event.noticeId)) return; seen.add(event.noticeId); if (seen.size > 5000) seen.clear(); }
  const s = entry(String(event.sid));
  const p = event.payload ?? {};
  s.events += 1; s.updatedAt = Date.now();
  if (event.eventType === 1001) s.states.push({ at: p.occurred_at_ms ?? Date.now(), status: p.status, reason: p.reason ?? p.message ?? null });
  else if (event.eventType === 1201) {
    s.call = { ...(s.call ?? {}), state: p.state, direction: p.direction, at: p.occurred_at_ms ?? Date.now(), ...(p.state === 'answered' ? { answeredAt: p.occurred_at_ms } : {}),
      ...(p.state === 'ended' ? { hangupReason: p.hangup_reason ?? null, hangupCode: p.hangup_reason_code ?? null, seconds: p.duration_seconds ?? null } : {}) };
    console.log(`call ${event.sid} ${p.state}${p.hangup_reason ? ` (${p.hangup_reason}, ${p.duration_seconds ?? 0}s)` : ''}`);
  } else if (event.eventType === 1003) { s.errors.push({ at: p.occurred_at_ms ?? Date.now(), module: p.module ?? p.component ?? null, message: String(p.message ?? p.detail ?? p.reason ?? '').slice(0, 300) }); console.warn(`session ${event.sid} error: ${JSON.stringify(p).slice(0, 300)}`); }
  else if (event.eventType === 1002) { const got = lines(p); if (got.length) s.transcript = got; else s.transcriptKeys = Object.keys(p); }
  // Keep the raw events too (numbers masked), so an unfamiliar shape can be inspected later.
  try {
    await mkdir(join(env.sitesDir, '_calls'), { recursive: true });
    await appendFile(join(env.sitesDir, '_calls', 'events.jsonl'), `${JSON.stringify(event).replace(/\+\d{6,15}/g, (n) => `${n.slice(0, 3)}•••${n.slice(-2)}`)}\n`);
  } catch { /* logging is best effort */ }
};

export const eventsFor = (sid) => sessions.get(sid) ?? null;
