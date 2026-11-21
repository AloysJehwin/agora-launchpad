// Sends the finished link to the caller's phone through Twilio (SMS or WhatsApp).
import { env, E164, maskNumber } from './env.mjs';
import { TEMPLATES, param } from './whatsapp-templates.mjs';

const send = async (form) => {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.twilioSid}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${env.twilioSid}:${env.twilioToken}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(12_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio ${res.status}${data.code ? ` (error ${data.code})` : ''}: ${data.message ?? 'message rejected'}`.slice(0, 240));
  return data;
};

/** What Twilio finally did with a message: queued | sent | delivered | undelivered | failed. */
export const messageStatus = async (sid) => {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.twilioSid}/Messages/${sid}.json`, {
    headers: { authorization: `Basic ${Buffer.from(`${env.twilioSid}:${env.twilioToken}`).toString('base64')}` },
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: data.status ?? `http ${res.status}`, errorCode: data.error_code ?? null, errorMessage: data.error_message ?? null };
};

/**
 * Text the link. Returns { sent, channel, sid, error }. "sent" means Twilio accepted the
 * message, not that the phone received it; use messageStatus(sid) for that.
 */
export const sendLink = async ({ to, url, name, kind = 'live' }) => {
  const channel = env.linkChannel;
  if (channel === 'none') return { sent: false, channel: null, sid: null, error: 'messaging is turned off (LINK_CHANNEL=none)' };
  if (!E164.test(to ?? '')) return { sent: false, channel: null, sid: null, error: 'no phone number to send to' };
  if (!env.twilioSid || !env.twilioToken) return { sent: false, channel: null, sid: null, error: 'Twilio is not configured' };
  const body = kind === 'preview'
    ? `Launchpad: watch your page for ${name || 'your business'} being built: ${url}`
    : `Launchpad: your page for ${name || 'your business'} is live: ${url}`;
  try {
    const form = channel === 'whatsapp'
      ? { From: `whatsapp:${env.whatsappFrom}`, To: `whatsapp:${to}`, Body: body }
      : { From: env.twilioNumber, To: to, Body: body };
    if (channel === 'whatsapp' && !env.whatsappFrom) throw new Error('TWILIO_WHATSAPP_FROM is not set');
    const message = await send(form);
    console.log(`link sent by ${channel} to ${maskNumber(to)} (${message.status})`);
    return { sent: true, channel, sid: message.sid, error: null };
  } catch (err) {
    console.warn(`link NOT sent to ${maskNumber(to)}: ${err.message}`);
    return { sent: false, channel, sid: null, error: err.message };
  }
};

/** Send any text message. Returns { sent, sid, status, error }. */
export const sendText = async ({ to, body }) => {
  if (!E164.test(to ?? '')) return { sent: false, sid: null, status: null, error: 'That is not a full phone number with country code.' };
  if (!env.twilioSid || !env.twilioToken) return { sent: false, sid: null, status: null, error: 'Text messaging is not configured.' };
  try {
    const message = await send({ From: env.twilioNumber, To: to, Body: String(body).slice(0, 600) });
    return { sent: true, sid: message.sid, status: message.status, error: null };
  } catch (err) {
    return { sent: false, sid: null, status: null, error: err.message };
  }
};

// ------------------------------------------------------------- WhatsApp ----
// WhatsApp is the main channel. A business may only open a conversation with a template Meta
// has approved, so until a template is approved (or if a send fails) the same information goes
// out as a plain text message instead, unless SMS_FALLBACK=0.

const smsFallback = () => (process.env.SMS_FALLBACK ?? '1').trim() !== '0';
let approvals = { at: 0, byName: new Map() };

const loadApprovals = async () => {
  if (Date.now() - approvals.at < 60_000) return approvals.byName;
  const byName = new Map();
  try {
    let url = 'https://content.twilio.com/v1/ContentAndApprovals?PageSize=100';
    while (url) {
      const res = await fetch(url, { headers: { authorization: `Basic ${Buffer.from(`${env.twilioSid}:${env.twilioToken}`).toString('base64')}` }, signal: AbortSignal.timeout(12_000) });
      const page = await res.json();
      for (const c of page.contents ?? []) if (/^launchpad_/.test(c.friendly_name ?? '')) byName.set(c.friendly_name, { sid: c.sid, status: c.approval_requests?.status ?? 'unsubmitted', reason: c.approval_requests?.rejection_reason ?? '' });
      url = page.meta?.next_page_url ?? null;
    }
    approvals = { at: Date.now(), byName };
  } catch (err) {
    console.warn(`whatsapp template status unavailable: ${err.message}`);
    approvals = { at: Date.now() - 45_000, byName: approvals.byName }; // retry soon, keep what we knew
  }
  return approvals.byName;
};

/** For the console: each template and where it stands with Meta. */
export const whatsappStatus = async () => {
  const known = await loadApprovals();
  return Object.values(TEMPLATES).map((t) => ({ key: t.key, name: t.name, status: known.get(t.name)?.status ?? 'missing', reason: known.get(t.name)?.reason ?? '' }));
};

/**
 * Tell someone something. `template` is a key of TEMPLATES and `vars` its values in order;
 * `text` is the plain wording used when WhatsApp cannot carry it yet.
 * Returns { sent, channel: 'whatsapp' | 'sms' | null, error }.
 */
export const notify = async ({ to, template, vars = [], text }) => {
  if (env.linkChannel === 'none') return { sent: false, channel: null, error: 'messaging is turned off' };
  if (!E164.test(to ?? '')) return { sent: false, channel: null, error: 'no phone number to send to' };
  if (!env.twilioSid || !env.twilioToken) return { sent: false, channel: null, error: 'Twilio is not configured' };
  let why = 'WhatsApp is not configured';
  const t = TEMPLATES[template];
  if (t && env.whatsappFrom && env.linkChannel !== 'sms') {
    const state = (await loadApprovals()).get(t.name);
    if (state?.status === 'approved') {
      try {
        const variables = Object.fromEntries(vars.map((v, i) => [String(i + 1), param(v)]));
        const message = await send({ From: `whatsapp:${env.whatsappFrom}`, To: `whatsapp:${to}`, ContentSid: state.sid, ContentVariables: JSON.stringify(variables) });
        console.log(`whatsapp ${t.name} to ${maskNumber(to)} (${message.status})`);
        return { sent: true, channel: 'whatsapp', sid: message.sid, error: null };
      } catch (err) {
        why = err.message;
        console.warn(`whatsapp ${t.name} to ${maskNumber(to)} failed: ${err.message}`);
      }
    } else why = `template ${t.name} is ${state?.status ?? 'missing'}`;
  }
  if (text && smsFallback()) {
    const sms = await sendText({ to, body: text });
    if (sms.sent) console.log(`text (WhatsApp unavailable: ${why}) to ${maskNumber(to)}`);
    return { sent: sms.sent, channel: sms.sent ? 'sms' : null, sid: sms.sid, error: sms.sent ? null : sms.error };
  }
  return { sent: false, channel: null, error: why };
};
