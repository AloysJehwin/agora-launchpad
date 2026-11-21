// The assistant that speaks for a published site: visitors talk to it in the browser, and the
// owner can have it phone a lead back. Same voice pipeline as the phone agent (Agora + Murf),
// different job: answer from what the site says, and take a message for the owner.
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { env } from './env.mjs';
import { platform, platformToken, PlatformError } from './platform.mjs';
import { LANGUAGES, languageFor, voiceLlmBlock, turnDetection, toolsReady } from './phone-agent.mjs';

const { RtcTokenBuilder, RtcRole, RtmTokenBuilder } = createRequire(import.meta.url)('agora-token');

const AGENT_UID = 1001;
const MAX_TALKS = 2;           // Murf allows three voices at once; leave one for a phone call
const TALK_SECONDS = 240;
const PER_IP = { max: 4, windowMs: 10 * 60_000 };

/** talkId -> { slug, ref, sessionId, startedAt, lang, visitor, leadId } */
const talks = new Map();
const recent = new Map(); // ip -> [timestamps]

export const liveTalks = () => talks.size;
export const getTalk = (talkId) => talks.get(talkId) ?? null;
export const talkForRef = (ref) => [...talks.entries()].find(([, t]) => t.ref === ref) ?? null;

export const conciergeLanguages = () => Object.entries(LANGUAGES).filter(([code]) => code !== 'en-IN').map(([code, l]) => ({ code, label: l.label }));

// -------------------------------------------------------------- knowledge ----

/** Everything the assistant may say about the business: the brief plus the page's visible text. */
export const siteFacts = (site) => {
  const b = site.brief ?? {};
  const lines = [
    `Name: ${site.name}`,
    b.what_they_do && `What they do: ${b.what_they_do}`,
    b.audience && `Who it is for: ${b.audience}`,
    b.highlights && `Highlights: ${b.highlights}`,
    b.contact && `Contact details: ${b.contact}`,
  ].filter(Boolean);
  const html = site.publishedHtml ?? site.html ?? '';
  const visible = html.replace(/<(script|style|svg|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 2600);
  if (visible) lines.push(`Text on their website: ${visible}`);
  return lines.join('\n');
};

const GREET = {
  en: (n) => `Hi, I'm the assistant for ${n}. How can I help you today?`,
  hi: (n) => `नमस्ते, मैं ${n} का असिस्टेंट हूँ। मैं आपकी क्या मदद कर सकता हूँ?`,
  ta: (n) => `வணக்கம், நான் ${n}-இன் உதவியாளர். உங்களுக்கு எப்படி உதவலாம்?`,
};
const CALLBACK = {
  en: (n, who) => `Hello${who ? ` ${who}` : ''}, this is the AI assistant for ${n}, calling back about your enquiry. Is this a good time?`,
  hi: (n, who) => `नमस्ते${who ? ` ${who}` : ''}, मैं ${n} का AI असिस्टेंट बोल रहा हूँ, आपकी पूछताछ के बारे में कॉल किया है। क्या अभी बात हो सकती है?`,
  ta: (n, who) => `வணக்கம்${who ? ` ${who}` : ''}, நான் ${n}-இன் AI உதவியாளர், உங்கள் விசாரணை குறித்து அழைக்கிறேன். இப்போது பேசலாமா?`,
};

const str = (description) => ({ type: 'string', description });

const saveEnquiryTool = (ref) => ({
  type: 'function',
  name: 'saveEnquiry',
  description: 'Save the person\'s details and what they need so the owner can get back to them. Call it as soon as you know what they need and have a name or a phone number, and again if they add or correct something. Use an empty string for anything not given.',
  parameters: {
    type: 'object',
    properties: { name: str('Their name.'), phone: str('Their phone number, digits as they said them.'), need: str('What they want, in one or two sentences, in English.'), language: str('The language code they are speaking, such as en, hi or ta.') },
    required: ['name', 'phone', 'need', 'language'],
    additionalProperties: false,
  },
  execution: { mode: 'sync' },
  server: {
    method: 'POST',
    url: `${env.publicUrl}/tools/saveEnquiry`,
    headers: { Authorization: `Bearer ${env.toolSecret}`, 'Content-Type': 'application/json' },
    body: { ref, name: '{{args.name}}', phone: '{{args.phone}}', need: '{{args.need}}', language: '{{args.language}}' },
    timeout_ms: 10_000,
  },
});

/** Inline agent definition. mode 'visitor' = someone on the website; 'callback' = phoning a lead. */
export const buildConciergeAgent = ({ site, ref, lang, mode = 'visitor', lead = null }) => {
  const language = languageFor(lang);
  const code = LANGUAGES[lang] ? lang : 'en';
  const withTools = toolsReady();
  const llm = voiceLlmBlock();
  if (withTools) llm.tools = [saveEnquiryTool(ref)];
  const instructions = [
    `You are the AI voice assistant for "${site.name}". You speak with ${mode === 'callback' ? 'a customer you are phoning back on the owner\'s behalf' : 'a visitor on their website'}.`,
    `Speak ${language.speak}. If the person clearly speaks another language you can speak, switch to it.`,
    'Everything you know about the business is in the FACTS below. Answer only from them. If something is not in the facts (a price, availability, opening hours, a policy), say you do not have that information and offer to pass the question to the owner. Never guess.',
    mode === 'callback' && lead
      ? `You are calling about this enquiry: "${lead.summary || lead.message || 'they asked to be contacted'}". Confirm you have the right person, help with what they asked using the facts, and note anything the owner must follow up.`
      : 'Help them with what they came for. If they want to order, book, get a quote or be contacted, take their name, their phone number and what they need.',
    withTools ? 'When you know what they need and have a name or a phone number, call saveEnquiry, then tell them the owner will get back to them. For a phone number, repeat it back and confirm before saving.' : 'Tell them the owner will get back to them.',
    'This is a spoken conversation: one or two short sentences per turn, no lists, no symbols. Say numbers the way people say them.',
    'If the person talks over you, stop and respond to what they just said; do not go back to finish your sentence.',
    'Say you are an AI assistant if asked. You cannot take payments, confirm bookings, or transfer the call.',
    'When they are done, thank them and say goodbye.',
    `FACTS:\n${siteFacts(site)}`,
  ].filter(Boolean).join('\n');
  return {
    instructions,
    greeting: { mode: 'text', on: 'first_join', delay_ms: 300, text: mode === 'callback' ? (CALLBACK[code] ?? CALLBACK.en)(site.name, lead?.name) : (GREET[code] ?? GREET.en)(site.name) },
    pipeline: {
      mode: 'cascaded',
      asr: { credential: { mode: 'managed' }, vendor: 'deepgram', model: 'nova-3', language: language.asr },
      llm,
      tts: {
        credential: { mode: 'byok', fields: { api_key: env.murfKey } },
        vendor: 'murf',
        url: env.murfWs,
        params: { voiceId: language.voice, locale: language.locale, rate: 0, pitch: 0, model: 'FALCON', sample_rate: 24000 },
      },
      turn_detection: turnDetection,
    },
    filler_words: { enable: true, trigger: { mode: 'fixed_time', response_wait_ms: 1800 }, content: { mode: 'static', phrases: ['One moment.', 'Let me check.', 'Okay.'], selection_rule: 'shuffle' } },
  };
};

// ------------------------------------------------------- browser sessions ----

class TalkError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const allow = (ip) => {
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < PER_IP.windowMs);
  if (hits.length >= PER_IP.max) return false;
  hits.push(now);
  recent.set(ip, hits);
  return true;
};

/** Start a voice conversation between a website visitor and the site's assistant. */
export const startTalk = async ({ site, lang, visitor, ip, register }) => {
  if (!env.appId || !env.appCert || !env.murfKey) throw new TalkError(503, 'The voice assistant is not available right now.');
  if (talks.size >= MAX_TALKS) throw new TalkError(429, 'The assistant is busy with someone else. Please try again in a minute, or leave a message.');
  if (!allow(ip)) throw new TalkError(429, 'You have started several conversations just now. Please leave a message instead.');
  const talkId = randomBytes(9).toString('base64url');
  const ref = randomUUID();
  const channel = `site-${site.slug}-${randomBytes(5).toString('hex')}`;
  const uid = 100_000 + Math.floor(Math.random() * 800_000);
  const code = LANGUAGES[lang] ? lang : (LANGUAGES[site.lang] ? site.lang : 'en');
  register(ref, { to: null, name: visitor?.name ?? null, slug: site.slug, talkId });
  const token = platformToken(channel, AGENT_UID);
  let started;
  try {
    started = await platform('/sessions/ephemeral', {
      method: 'POST',
      token,
      headers: { 'Idempotency-Key': randomUUID() },
      body: {
        agent: buildConciergeAgent({ site, ref, lang: code }),
        transport: { type: 'rtc', channel, token, uid: String(AGENT_UID), subscribe_uids: [String(uid)] },
        lifecycle: { idle_timeout_ms: 20_000, max_duration_ms: TALK_SECONDS * 1000 },
        labels: { app: 'launchpad', kind: 'site-visitor', site: site.slug },
      },
    });
  } catch (err) {
    console.warn(`talk on ${site.slug} failed to start: ${err.message}`);
    throw new TalkError(err instanceof PlatformError && err.status === 429 ? 429 : 502, 'The assistant could not start. Please leave a message instead.');
  }
  const talk = { slug: site.slug, ref, sessionId: started.agent_session_id, startedAt: Date.now(), lang: code, visitor: visitor ?? null, leadId: null };
  talks.set(talkId, talk);
  talk.timer = setTimeout(() => stopTalk(talkId), (TALK_SECONDS + 20) * 1000);
  talk.timer.unref();
  console.log(`talk ${talkId} started on ${site.slug} (${code})`);
  return {
    talkId, appId: env.appId, channel, uid, agentUid: AGENT_UID, maxSeconds: TALK_SECONDS,
    rtcToken: RtcTokenBuilder.buildTokenWithUid(env.appId, env.appCert, channel, uid, RtcRole.PUBLISHER, 900, 900),
    rtmToken: RtmTokenBuilder.buildToken(env.appId, env.appCert, String(uid), 900),
  };
};

export const stopTalk = async (talkId) => {
  const talk = talks.get(talkId);
  if (!talk) return false;
  talks.delete(talkId);
  clearTimeout(talk.timer);
  await platform(`/sessions/${talk.sessionId}/stop`, { method: 'POST' }).catch((err) => {
    if (!(err instanceof PlatformError && [404, 409].includes(err.status))) console.warn(`stop talk ${talkId}: ${err.message}`);
  });
  return true;
};

export const stopAllTalks = () => Promise.allSettled([...talks.keys()].map(stopTalk));
