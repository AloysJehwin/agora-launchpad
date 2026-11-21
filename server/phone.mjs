// Outbound phone calls: dial a number, follow the call, hang up.
// Agora dials out from an imported number through the Twilio SIP trunk (see scripts/setup-phone.mjs).
import { randomUUID } from 'node:crypto';
import { env, E164, maskNumber, voiceLlmLabel } from './env.mjs';
import { platform, platformToken, listNumbers, PlatformError } from './platform.mjs';
import { buildPhoneAgent, LANGUAGES, toolsReady } from './phone-agent.mjs';
import { registerCaller } from './callers.mjs';
import { siteForRef, publicView, attachRef } from './sites.mjs';
import { eventsFor } from './call-events.mjs';
import { isAllowed, normaliseNumber } from './numbers.mjs';
import { notify } from './notify.mjs';
import { adminUrl, previewUrl } from './sites.mjs';

const MAX_LIVE_CALLS = 1; // one test call at a time; raise once the trunk is proven
const LIVE = new Set(['STARTING', 'RUNNING', 'STOPPING']);
const CALL_POLICY = {
  max_ring_duration_ms: 35_000,
  max_call_duration_seconds: 600,
  // The person is quiet for long stretches while they watch their page being designed, so the
  // silence limit is generous; a 45-second limit ended a real call after 47 seconds.
  max_silence_duration_ms: 240_000,
  // Automatic hang-up on "voicemail" or "another AI" is off: a wrong guess ends a real conversation.
  // The platform's own "hang up when the caller asks" is off too: on a real call the model used
  // it when asked to switch language, which dropped the line with no call back. The call ends
  // when the person hangs up, when we stop it, or at the limits above.
  end_call: { on_user_request: false, on_voicemail: false, on_ai_assistant: false },
};

/** callId -> { to, name, status, startedAt, endedAt, message } */
const calls = new Map();
let fromNumber = { at: 0, value: null, error: null }; // cached lookup of the imported caller ID

class CallError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fromAgora = (err, doing) =>
  err instanceof PlatformError
    ? new CallError(502, `Agora could not ${doing}: ${err.reason ?? err.status}. ${err.detail ?? ''}`.trim())
    : err;

/** The imported number we call from: the one in TWILIO_PHONE_NUMBER, or the only one in the project. */
const resolveFromNumber = async () => {
  if (Date.now() - fromNumber.at < 60_000) return fromNumber;
  try {
    const numbers = await listNumbers();
    const match = env.twilioNumber ? numbers.find((n) => n.number === env.twilioNumber) : numbers.length === 1 ? numbers[0] : null;
    fromNumber = { at: Date.now(), value: match ?? null, error: null, count: numbers.length };
  } catch (err) {
    fromNumber = { at: Date.now(), value: null, error: err.message, count: 0 };
  }
  return fromNumber;
};

/** For /api/health: can we place a call right now, and if not, what is missing. */
export const phoneStatus = async () => {
  const missing = [
    ['AGORA_APP_ID', env.appId], ['AGORA_APP_CERTIFICATE', env.appCert], ['MURF_API_KEY', env.murfKey],
  ].filter(([, v]) => !v).map(([k]) => k);
  let hint = null;
  let from = null;
  if (!missing.length) {
    const found = await resolveFromNumber();
    from = found.value;
    if (found.error) hint = `Could not reach Agora to look up the caller ID: ${found.error}`;
    else if (!from && !env.twilioNumber && found.count === 0) missing.push('TWILIO_PHONE_NUMBER');
    else if (!from) hint = 'The Twilio number is not imported into Agora yet. Run "npm run phone:setup -- --apply".';
  }
  return {
    ready: !missing.length && Boolean(from),
    from: from ? maskNumber(from.number) : null,
    missing,
    hint,
    voiceModel: voiceLlmLabel(),
    allowlist: env.callAllowlist.length > 0,
    websiteTools: toolsReady(),
    languages: Object.entries(LANGUAGES).map(([code, l]) => ({ code, label: l.label, experimental: l.experimental })),
  };
};

const normalise = (to) => String(to ?? '').replace(/[\s().-]/g, '');
const callView = (callId, c) => ({
  callId, status: c.status, to: maskNumber(c.to), startedAt: c.startedAt, endedAt: c.endedAt, message: c.message,
  site: publicView(siteForRef(c.ref)) ?? null,
  // From Agora's notifications, when they are switched on: was it answered, why it ended, what was said.
  // Without them, what the phone line itself reported when it closed (see settleFromLine).
  phone: eventsFor(callId)?.call ?? (c.line ? { state: 'ended', hangupReason: c.line.outcome, hangupCode: null, seconds: c.line.seconds, at: c.line.endedAt } : null),
  errors: eventsFor(callId)?.errors ?? [],
  transcript: eventsFor(callId)?.transcript ?? [],
});

/**
 * Dial a number. By default the website-building agent talks; pass `agent` (a function of the
 * call ref returning an inline agent) to have a different one speak, e.g. a site's assistant
 * phoning a lead back, and `about` ({ slug, leadId }) to tie the call to that lead.
 */
export const startCall = async ({ to, name, lang, agent, about, business, trusted = false } = {}) => {
  const number = normaliseNumber(to) ?? normalise(to);
  if (!E164.test(number)) throw new CallError(400, 'Enter the number in international format, for example +919812345678.');
  // The operator console (trusted) may call anyone. Everything else, such as the public front
  // page or an owner phoning a lead back, may only reach numbers enabled in the console.
  if (!trusted && !isAllowed(number)) throw new CallError(403, 'That number is not enabled for calls. Add it under "Front-page numbers" in the console first.');
  // A person cannot be on two calls: if an earlier call to this number is still winding down
  // (its session lingers for a while after they hang up), end it instead of refusing the new one.
  for (const [id, c] of calls) {
    if (c.to === number && LIVE.has(c.status)) { await stopCall(id).catch(() => {}); c.status = 'STOPPED'; c.endedAt ??= Date.now(); }
  }
  if ([...calls.values()].filter((c) => LIVE.has(c.status)).length >= MAX_LIVE_CALLS) {
    throw new CallError(429, 'A call is already in progress. End it or wait for it to finish.');
  }
  const { value: from } = await resolveFromNumber();
  if (!from) throw new CallError(503, 'Phone calling is not set up: no caller ID is imported into Agora.');

  const ref = randomUUID();
  registerCaller(ref, { to: number, name: name ?? null, ...(about ?? {}) });
  let started;
  try {
    started = await platform('/sessions/ephemeral', {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: {
        agent: agent ? agent(ref) : buildPhoneAgent({ name, ref, lang, business }),
        transport: { type: 'telephony', from: from.number_id, to: number, call_policy: CALL_POLICY },
        // idle_timeout counts ringing as "nobody present", so it must outlast max_ring_duration_ms
        // or the call is cancelled while the phone is still ringing.
        lifecycle: { idle_timeout_ms: 50_000, max_duration_ms: 600_000, graceful_stop: { enabled: true, timeout_ms: 6_000 } },
        labels: { app: 'launchpad', kind: 'outbound-call' },
      },
    });
  } catch (err) {
    throw fromAgora(err, 'start the call');
  }
  const callId = started.agent_session_id;
  calls.set(callId, { ref, to: number, name: name ?? null, status: started.status ?? 'STARTING', startedAt: Date.now(), endedAt: null, message: null });
  console.log(`call ${callId} to ${maskNumber(number)} started (${started.status})`);
  watch(callId);
  return { callId, status: started.status };
};

// The phone line is the source of truth for "the call is over". After the person hangs up,
// Agora keeps the session RUNNING for minutes (it ends only at the silence limit): a real call
// that ended after 346 seconds still read RUNNING four and a half minutes later, so the console
// showed a live call and nothing that waits for the end of a call happened. Twilio lists a trunk
// call only once it has ended, so a record for this call means the line has closed.
const LINE_OVER = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);
const span = (seconds) => (seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds} s`);

const lineRecord = async (c) => {
  if (!env.twilioSid || !env.twilioToken) return null;
  const day = new Date(c.startedAt - 60_000).toISOString().slice(0, 10);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.twilioSid}/Calls.json?PageSize=50&StartTime%3E=${day}`, {
    headers: { authorization: `Basic ${Buffer.from(`${env.twilioSid}:${env.twilioToken}`).toString('base64')}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return null;
  const digits = c.to.replace(/\D/g, '');
  // Only a record that began after we dialled is this call: an earlier call to the same person
  // (for example the one a language switch replaced) must not end the new one.
  return ((await res.json()).calls ?? []).find((r) =>
    LINE_OVER.has(r.status) && String(r.to ?? '').replace(/\D/g, '').endsWith(digits) && Date.parse(r.start_time) >= c.startedAt - 5_000) ?? null;
};

/** If the phone line has closed, close our side too: stop the lingering session and mark the call ended. */
const settleFromLine = async (callId, c) => {
  if (Date.now() - (c.lineCheckedAt ?? 0) < 4_000) return;
  c.lineCheckedAt = Date.now();
  const rec = await lineRecord(c).catch(() => null);
  if (!rec || !LIVE.has(c.status)) return;
  const seconds = Number(rec.duration) || 0;
  c.line = { outcome: rec.status, seconds, endedAt: Date.parse(rec.end_time) || Date.now() };
  platform(`/sessions/${callId}/stop`, { method: 'POST' }).catch(() => {});
  c.status = 'STOPPED';
  c.endedAt = c.line.endedAt;
  c.message = rec.status === 'completed' ? `The call ended after ${span(seconds)}.`
    : rec.status === 'no-answer' ? 'Nobody answered.' : rec.status === 'busy' ? 'The line was busy.' : `The call did not go through (${rec.status}).`;
  console.log(`call ${callId} to ${maskNumber(c.to)} is over on the phone line (${rec.status}, ${seconds}s); session stopped`);
};

export const getCall = async (callId) => {
  const c = calls.get(callId);
  if (!c) throw new CallError(404, 'Unknown call.');
  if (LIVE.has(c.status)) {
    try {
      const s = await platform(`/sessions/${callId}`);
      c.status = s.status ?? c.status;
      c.message = s.message ?? null;
      if (!LIVE.has(c.status)) c.endedAt = s.stop_ts ? s.stop_ts * 1000 : Date.now();
    } catch (err) {
      if (err instanceof PlatformError && err.status === 404) Object.assign(c, { status: 'STOPPED', endedAt: Date.now() });
      else { await settleFromLine(callId, c); if (LIVE.has(c.status)) throw fromAgora(err, 'read the call status'); }
    }
    if (LIVE.has(c.status)) await settleFromLine(callId, c);
  }
  return callView(callId, c);
};

export const stopCall = async (callId) => {
  const c = calls.get(callId);
  if (!c) return { stopped: false };
  if (!LIVE.has(c.status)) return { stopped: false };
  try {
    await platform(`/sessions/${callId}/stop`, { method: 'POST' });
  } catch (err) {
    // Already over is fine; anything else is worth reporting.
    if (!(err instanceof PlatformError && [404, 409].includes(err.status))) throw fromAgora(err, 'end the call');
  }
  c.status = 'STOPPING';
  return { stopped: true };
};

/**
 * Follow a call to its end. When it is over, the owner must not be left without a way back to
 * their page: if a site was started and its dashboard link has not been sent (the call ended
 * before publishing), send it now, so they can review and publish it themselves.
 */
const watch = (callId) => {
  const timer = setInterval(async () => {
    const c = calls.get(callId);
    if (!c) return clearInterval(timer);
    if (LIVE.has(c.status)) await getCall(callId).catch(() => {});
    if (LIVE.has(c.status)) return undefined;
    clearInterval(timer);
    const site = siteForRef(c.ref);
    if (!site || !site.html || site.adminMessage?.sent || c.switched) return undefined;
    site.adminMessage = await notify({
      to: c.to, template: 'callSummary',
      vars: [c.name || site.name, site.name, site.publishedAt ? 'your website, which is now live' : 'a preview of your website, which is not published yet; open your dashboard to review and publish it', `${site.slug}/admin/${site.claimToken}`],
      text: `Launchpad: your ${site.publishedAt ? 'website' : 'website preview'} for ${site.name} is ready. Review${site.publishedAt ? '' : ', publish'} and manage it here (keep this link private): ${adminUrl(site)}`,
    }).catch((err) => ({ sent: false, error: err.message }));
    console.log(`call ${callId} ended; dashboard link ${site.adminMessage.sent ? 'sent' : 'NOT sent'} for ${site.slug}`);
    return undefined;
  }, 5_000);
  timer.unref();
};

/**
 * The caller asked to speak another language. A call's hearing and voice are fixed when it
 * starts, so end this call and phone straight back in the new language, carrying over what was
 * said and, if a website was already started, the link to it.
 */
export const redialInLanguage = async ({ ref, lang, details }) => {
  const found = [...calls.entries()].find(([, c]) => c.ref === ref);
  if (!found) throw new CallError(404, 'That call is no longer known.');
  const [callId, old] = found;
  const site = siteForRef(ref);
  old.switched = true; // this call is being replaced, not finished: no end-of-call message
  await stopCall(callId).catch(() => {});
  for (let i = 0; i < 20 && LIVE.has(old.status); i++) { await new Promise((r) => setTimeout(r, 750)); await getCall(callId).catch(() => {}); }
  old.status = LIVE.has(old.status) ? 'STOPPED' : old.status; // do not let a slow status block the call back
  old.endedAt ??= Date.now();
  return startCall({
    to: old.to, name: old.name, lang, trusted: true,
    agent: (ref2) => {
      if (site) attachRef(ref2, site.slug);
      return buildPhoneAgent({ name: old.name, ref: ref2, lang, resume: { details }, followUp: site ? { name: site.name, sections: site.sections ?? [], published: Boolean(site.publishedAt) } : undefined });
    },
  });
};

/** The most recent calls, newest first, for the console. */
export const recentCalls = () => [...calls.entries()].map(([id, c]) => callView(id, c)).sort((a, b) => b.startedAt - a.startedAt).slice(0, 6);

export const stopAllCalls = () =>
  Promise.allSettled([...calls.keys()].filter((id) => LIVE.has(calls.get(id).status)).map(stopCall));

/**
 * Run the same phone agent in a browser channel instead of on a phone line.
 * Lets us hear the persona, the models and the interruption behaviour without dialling anyone.
 * Returns the Agora session id; stop it with stopRehearsal().
 */
export const startRehearsal = async ({ channel, agentUid, userUid, name, lang }) => {
  const token = platformToken(channel, agentUid);
  const ref = randomUUID();
  registerCaller(ref, { to: null, name: name ?? null });
  try {
    const started = await platform('/sessions/ephemeral', {
      method: 'POST',
      token,
      headers: { 'Idempotency-Key': randomUUID() },
      body: {
        agent: buildPhoneAgent({ name, ref, lang }),
        transport: { type: 'rtc', channel, token, uid: String(agentUid), subscribe_uids: [String(userUid)] },
        lifecycle: { idle_timeout_ms: 30_000, max_duration_ms: 600_000 },
        labels: { app: 'launchpad', kind: 'rehearsal' },
      },
    });
    return { sessionId: started.agent_session_id, status: started.status, ref };
  } catch (err) {
    throw fromAgora(err, 'start the rehearsal');
  }
};

export const stopRehearsal = (sessionId) =>
  platform(`/sessions/${sessionId}/stop`, { method: 'POST' }).catch((err) => {
    if (!(err instanceof PlatformError && [404, 409].includes(err.status))) console.warn(`stop rehearsal ${sessionId}: ${err.message}`);
  });

/** For checks only. */
export const __test = { lineRecord };
