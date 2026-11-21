#!/usr/bin/env node
// Verifies every provider the voice companion depends on.
//
//   npm run check        credentials + each service on its own (cheap: a few TTS characters,
//                        one one-word reply from Gemini and from Claude)
//   npm run check:e2e    also starts a real Agora agent with Murf as TTS, makes it speak, stops it
//
// Each check prints PASS / FAIL / SKIP. SKIP means a credential is missing from .env;
// Gemini, Anthropic and Twilio are optional, so a missing key there is never a failure.
// Exit code is 1 if anything failed.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// The phone and model checks read their config from the server's own env module,
// so they test exactly what the server will use.
import { env as conf, voiceLlmLabel, E164, maskNumber } from '../server/env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = (name, fallback = '') => (process.env[name] ?? '').trim() || fallback;
const E2E = process.argv.includes('--e2e');

const cfg = {
  appId: env('AGORA_APP_ID'),
  appCert: env('AGORA_APP_CERTIFICATE'),
  customerId: env('AGORA_CUSTOMER_ID'),
  customerSecret: env('AGORA_CUSTOMER_SECRET'),
  murfKey: env('MURF_API_KEY'),
  murfVoice: env('MURF_VOICE_ID', 'Matthew'),
  murfLocale: env('MURF_LOCALE', 'en-US'),
  murfWs: env('MURF_WS_URL', 'wss://global.api.murf.ai/v1/speech/stream-input'),
  llmKey: env('LLM_API_KEY'),
  llmUrl: env('LLM_URL', 'https://api.openai.com/v1/chat/completions'),
  llmModel: env('LLM_MODEL', 'gpt-4.1-mini'),
};

const AGORA_API = 'https://api.agora.io/api/conversational-ai-agent/v2/projects';
const MURF_API = 'https://api.murf.ai/v1';
const MURF_STREAM = 'https://global.api.murf.ai/v1/speech/stream';
const CHANNEL = 'provider-check';
const AGENT_UID = '1001';
const USER_UID = '1002';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const TWILIO_API = 'https://api.twilio.com';
const PROBE = 'Reply with the single word ready.';
const outDir = join(root, 'out');

// Belt and braces: no secret value may reach the terminal, even inside a provider's error text.
const secrets = [
  cfg.appCert, cfg.customerSecret, cfg.murfKey, cfg.llmKey,
  conf.geminiKey, conf.anthropicKey, conf.twilioToken, conf.sipPass,
].filter((s) => s && s.length >= 8);
const scrub = (text) => secrets.reduce((out, s) => out.split(s).join('[redacted]'), String(text));

const results = [];
const record = (status, name, rawDetail) => {
  const detail = scrub(rawDetail);
  results.push({ status, name, detail });
  const tag = { pass: '\x1b[32mPASS\x1b[0m', fail: '\x1b[31mFAIL\x1b[0m', skip: '\x1b[33mSKIP\x1b[0m' }[status];
  console.log(`${tag}  ${name.padEnd(28)} ${detail}`);
};
const check = async (name, needs, fn) => {
  const missing = Object.entries(needs).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return record('skip', name, `set ${missing.join(', ')} in .env`);
  try {
    record('pass', name, await fn());
  } catch (err) {
    record('fail', name, err.message);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s, n = 220) => String(s).replace(/\s+/g, ' ').slice(0, n);
const http = async (url, init = {}) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  return res;
};
const expectOk = async (res, what) => {
  if (res.ok) return res;
  throw new Error(`${what}: HTTP ${res.status} ${short(await res.text())}`);
};
const saveAudio = (file, buf) => {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, file), buf);
  return `out/${file}`;
};

// ---------------------------------------------------------------- Murf ----

console.log('\nMurf');

await check('murf.reachable', {}, async () => {
  const res = await http(`${MURF_API}/speech/voices`);
  if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
  return `api.murf.ai answered HTTP ${res.status} without a key (expected 4xx)`;
});

await check('murf.api_key', { MURF_API_KEY: cfg.murfKey }, async () => {
  const res = await expectOk(await http(`${MURF_API}/auth/token`, { headers: { 'api-key': cfg.murfKey } }), 'auth/token');
  const body = await res.json();
  if (!body.token) throw new Error('no token in response');
  return 'key accepted, short-lived token issued';
});

let falconVoiceId = cfg.murfVoice;
await check('murf.falcon_voices', { MURF_API_KEY: cfg.murfKey }, async () => {
  const res = await expectOk(
    await http(`${MURF_API}/speech/voices?model=falcon-2.1`, { headers: { 'api-key': cfg.murfKey } }),
    'voices',
  );
  const voices = await res.json();
  if (!Array.isArray(voices) || !voices.length) throw new Error('empty voice list');
  const want = cfg.murfVoice.toLowerCase();
  const hit = voices.find((v) => [v.voiceId, v.displayName].some((x) => {
    const s = String(x ?? '').toLowerCase();
    return s === want || s.endsWith(`-${want}`) || s.split(' ')[0] === want;
  }));
  if (!hit) {
    const sample = voices.slice(0, 8).map((v) => v.voiceId).join(', ');
    throw new Error(`${voices.length} Falcon voices, but "${cfg.murfVoice}" is not one of them. Try: ${sample}`);
  }
  falconVoiceId = hit.voiceId;
  const locales = Object.keys(hit.supportedLocales ?? {});
  const localeNote = locales.length && !locales.includes(cfg.murfLocale)
    ? ` (warning: ${cfg.murfLocale} not in its locales: ${locales.slice(0, 6).join(', ')})`
    : '';
  return `${voices.length} Falcon voices; using ${hit.voiceId}${localeNote}`;
});

await check('murf.falcon_http_stream', { MURF_API_KEY: cfg.murfKey }, async () => {
  const t0 = performance.now();
  const res = await expectOk(
    await http(MURF_STREAM, {
      method: 'POST',
      headers: { 'api-key': cfg.murfKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Provider check. Murf Falcon is working.',
        voiceId: falconVoiceId,
        model: 'falcon-2.1',
        locale: cfg.murfLocale,
        format: 'WAV',
        sampleRate: 24000,
      }),
    }),
    'speech/stream',
  );
  const reader = res.body.getReader();
  const chunks = [];
  let ttfb = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttfb === null) ttfb = performance.now() - t0;
    chunks.push(Buffer.from(value));
  }
  const audio = Buffer.concat(chunks);
  if (audio.length < 1000) throw new Error(`only ${audio.length} bytes of audio: ${short(audio.toString())}`);
  const file = saveAudio('murf-falcon-http.wav', audio);
  const region = res.headers.get('x-murf-region') ?? 'unknown';
  const conc = res.headers.get('x-murf-concurrency-limit');
  return `${audio.length} bytes, first audio in ${Math.round(ttfb)} ms, region ${region}${conc ? `, concurrency limit ${conc}` : ''} -> ${file}`;
});

// The WebSocket endpoint is the one Agora's agent calls, so this is the check that matters most.
const murfWsOnce = (auth) => new Promise((resolve, reject) => {
  const params = new URLSearchParams({ model: 'falcon-2.1', sample_rate: '24000', channel_type: 'MONO', format: 'WAV' });
  if (auth === 'query') params.set('api-key', cfg.murfKey);
  const url = `${cfg.murfWs}?${params}`;
  const ws = auth === 'header' ? new WebSocket(url, { headers: { 'api-key': cfg.murfKey } }) : new WebSocket(url);
  const chunks = [];
  const t0 = performance.now();
  let ttfb = null;
  let settled = false;
  const finish = (fn, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { ws.close(); } catch { /* already closed */ }
    fn(value);
  };
  const timer = setTimeout(() => finish(reject, new Error('timed out after 25 s waiting for audio')), 25_000);
  ws.addEventListener('open', () => {
    const context_id = 'provider-check';
    ws.send(JSON.stringify({ voice_config: { voice_id: falconVoiceId, locale: cfg.murfLocale }, context_id }));
    ws.send(JSON.stringify({ text: 'Provider check. The streaming socket is working.', end: true, context_id }));
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
    if (msg.error || msg.error_code) return finish(reject, new Error(`server error: ${short(JSON.stringify(msg))}`));
    if (msg.audio) {
      if (ttfb === null) ttfb = performance.now() - t0;
      chunks.push(Buffer.from(msg.audio, 'base64'));
    }
    if (msg.final) finish(resolve, { audio: Buffer.concat(chunks), ttfb });
  });
  ws.addEventListener('close', (ev) => {
    const err = new Error(`socket closed (${ev.code}) ${ev.reason || ''}`.trim());
    err.code = ev.code;
    if (chunks.length) finish(resolve, { audio: Buffer.concat(chunks), ttfb });
    else finish(reject, err);
  });
  ws.addEventListener('error', () => finish(reject, new Error('socket error before any audio')));
});

await check('murf.falcon_websocket', { MURF_API_KEY: cfg.murfKey }, async () => {
  let out;
  let via = 'api-key header';
  try {
    out = await murfWsOnce('header');
  } catch (err) {
    // Some runtimes drop custom handshake headers; Murf also accepts the key as a query parameter.
    via = 'api-key query parameter';
    out = await murfWsOnce('query').catch((err2) => { throw new Error(`${err2.message} (header attempt: ${err.message})`); });
  }
  if (out.audio.length < 1000) throw new Error(`only ${out.audio.length} bytes of audio`);
  const file = saveAudio('murf-falcon-ws.wav', out.audio);
  return `${out.audio.length} bytes, first audio in ${Math.round(out.ttfb)} ms via ${via} -> ${file}`;
});

// --------------------------------------------------------------- Agora ----

console.log('\nAgora');

await check('agora.reachable', {}, async () => {
  const res = await http(`${AGORA_API}/unknown/agents`);
  if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
  return `api.agora.io answered HTTP ${res.status} without credentials (expected 401)`;
});

let token = '';
await check('agora.token_build', { AGORA_APP_ID: cfg.appId, AGORA_APP_CERTIFICATE: cfg.appCert }, async () => {
  if (!/^[0-9a-f]{32}$/i.test(cfg.appId)) throw new Error('AGORA_APP_ID should be 32 hex characters');
  if (!/^[0-9a-f]{32}$/i.test(cfg.appCert)) throw new Error('AGORA_APP_CERTIFICATE should be 32 hex characters');
  const { ConvoAITokenBuilder } = createRequire(import.meta.url)('agora-token');
  if (!ConvoAITokenBuilder) throw new Error('agora-token has no ConvoAITokenBuilder; run npm install agora-token@latest');
  token = ConvoAITokenBuilder.buildToken(cfg.appId, cfg.appCert, CHANNEL, AGENT_UID, 3600, 3600);
  if (!token.startsWith('007')) throw new Error('token does not start with 007');
  return `ConvoAI + RTC + RTM token built (${token.length} chars) for channel "${CHANNEL}", uid ${AGENT_UID}`;
});

const tokenAuth = () => ({ Authorization: `agora token="${token}"` });
const listAgents = async (headers) => {
  const res = await expectOk(await http(`${AGORA_API}/${cfg.appId}/agents?state=0,1,2&limit=5`, { headers }), 'list agents');
  const body = await res.json();
  return `Conversational AI enabled for this project; ${body?.meta?.total ?? body?.data?.count ?? 0} agent(s) active`;
};

await check('agora.rest_token_auth', { AGORA_APP_ID: cfg.appId, AGORA_APP_CERTIFICATE: cfg.appCert }, async () => {
  if (!token) throw new Error('no token (see agora.token_build)');
  return listAgents(tokenAuth());
});

if (cfg.customerId || cfg.customerSecret) {
  await check('agora.rest_basic_auth', { AGORA_APP_ID: cfg.appId, AGORA_CUSTOMER_ID: cfg.customerId, AGORA_CUSTOMER_SECRET: cfg.customerSecret }, async () => {
    const basic = Buffer.from(`${cfg.customerId}:${cfg.customerSecret}`).toString('base64');
    return listAgents({ Authorization: `Basic ${basic}` });
  });
}

// The Platform API (Preview) is the one that places phone calls. It is imported lazily so a
// problem loading it shows up as one FAIL line instead of stopping the whole script.
let agoraNumbers = null;
const loadAgoraNumbers = async () => {
  const { listNumbers } = await import('../server/platform.mjs');
  agoraNumbers = await listNumbers();
  return agoraNumbers;
};

await check('agora.platform_api', { AGORA_APP_ID: conf.appId, AGORA_APP_CERTIFICATE: conf.appCert }, async () => {
  const numbers = await loadAgoraNumbers();
  return `Platform API (Preview) answered; ${numbers.length} phone number(s) imported`;
});

// -------------------------------------------------------------- Gemini ----

console.log('\nGemini (talks on the call)');

const geminiId = conf.geminiModel.replace(/^models\//, '');
const geminiHeaders = () => ({ 'x-goog-api-key': conf.geminiKey });

let geminiModels = null;
await check('gemini.api_key', { GEMINI_API_KEY: conf.geminiKey }, async () => {
  const models = [];
  let pageToken = '';
  do {
    const page = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
    const res = await expectOk(await http(`${GEMINI_API}/models?pageSize=1000${page}`, { headers: geminiHeaders() }), 'list models');
    const body = await res.json();
    models.push(...(body.models ?? []));
    pageToken = body.nextPageToken ?? '';
  } while (pageToken);
  if (!models.length) throw new Error('key accepted, but the model list is empty');
  geminiModels = models;
  return `key accepted, ${models.length} models returned`;
});

await check('gemini.model', { GEMINI_API_KEY: conf.geminiKey }, async () => {
  if (!geminiModels) throw new Error('no model list (see gemini.api_key)');
  const hit = geminiModels.find((m) => m.name === `models/${geminiId}`);
  if (!hit) {
    const flash = geminiModels.map((m) => String(m.name ?? '').replace(/^models\//, '')).filter((id) => id.includes('flash')).slice(0, 8);
    throw new Error(`GEMINI_MODEL "${geminiId}" is not one of the ${geminiModels.length} models. ${flash.length ? `Flash models: ${flash.join(', ')}` : 'No flash models are available to this key'}`);
  }
  const methods = hit.supportedGenerationMethods;
  if (Array.isArray(methods) && !methods.includes('generateContent')) {
    throw new Error(`${geminiId} does not support generateContent (it supports: ${methods.join(', ') || 'nothing'})`);
  }
  return `${geminiId} is available${hit.displayName ? ` (${hit.displayName})` : ''}`;
});

// Same endpoint style Agora's agent uses for a Gemini LLM: streamGenerateContent over SSE.
await check('gemini.flash_stream', { GEMINI_API_KEY: conf.geminiKey }, async () => {
  const t0 = performance.now();
  const res = await expectOk(
    await http(`${GEMINI_API}/models/${encodeURIComponent(geminiId)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { ...geminiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: PROBE }] }] }),
    }),
    'streamGenerateContent',
  );
  const decoder = new TextDecoder();
  let pending = '';
  let text = '';
  let ttfb = null;
  let finish = '';
  const onLine = (line) => {
    if (!line.startsWith('data:')) return;
    let chunk;
    try { chunk = JSON.parse(line.slice(5)); } catch { return; }
    if (chunk.error) throw new Error(`stream error: ${short(chunk.error.message ?? JSON.stringify(chunk.error))}`);
    if (chunk.promptFeedback?.blockReason) throw new Error(`prompt blocked: ${chunk.promptFeedback.blockReason}`);
    const candidate = chunk.candidates?.[0];
    finish = candidate?.finishReason ?? finish;
    const piece = (candidate?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
    if (!piece) return;
    if (ttfb === null) ttfb = performance.now() - t0;
    text += piece;
  };
  for await (const bytes of res.body) {
    const lines = (pending + decoder.decode(bytes, { stream: true })).split(/\r?\n/);
    pending = lines.pop();
    lines.forEach(onLine);
  }
  onLine(pending);
  if (!text.trim()) throw new Error(`stream ended without any text (finishReason ${finish || 'unknown'})`);
  return `first text in ${Math.round(ttfb)} ms, done in ${Math.round(performance.now() - t0)} ms: "${short(text.trim(), 60)}"`;
});

// ----------------------------------------------------------- Anthropic ----

console.log('\nAnthropic (heavier work behind the call)');

let claude = null;
const anthropic = async () => {
  if (!claude) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    claude = { Anthropic, client: new Anthropic({ apiKey: conf.anthropicKey, maxRetries: 1, timeout: 60_000 }) };
  }
  return claude;
};
// Words an SDK error for the FAIL line. Most specific class first.
const anthropicFailure = (Anthropic, err) => {
  if (err instanceof Anthropic.AuthenticationError) return new Error('ANTHROPIC_API_KEY was rejected (HTTP 401)');
  if (err instanceof Anthropic.PermissionDeniedError) return new Error(`this key may not use ${conf.anthropicModel} (HTTP 403)`);
  if (err instanceof Anthropic.NotFoundError) return new Error(`ANTHROPIC_MODEL "${conf.anthropicModel}" was not found for this key (HTTP 404)`);
  if (err instanceof Anthropic.RateLimitError) return new Error('rate limited (HTTP 429); try again shortly');
  if (err instanceof Anthropic.APIConnectionError) return new Error(`could not reach api.anthropic.com: ${short(err.message, 120)}`);
  if (err instanceof Anthropic.APIError) return new Error(`API error ${err.status ?? ''}: ${short(err.message)}`);
  return err;
};

// One models.retrieve call answers two questions: is the key good, and does the model exist.
let claudeModel = null; // { info } | { error }
await check('anthropic.api_key', { ANTHROPIC_API_KEY: conf.anthropicKey }, async () => {
  const { Anthropic, client } = await anthropic();
  try {
    claudeModel = { info: await client.models.retrieve(conf.anthropicModel) };
  } catch (err) {
    claudeModel = { error: anthropicFailure(Anthropic, err) };
    // A 404 for the model still proves the key was accepted; anthropic.model reports it.
    if (!(err instanceof Anthropic.NotFoundError)) throw claudeModel.error;
  }
  return 'key accepted';
});

await check('anthropic.model', { ANTHROPIC_API_KEY: conf.anthropicKey }, async () => {
  if (!claudeModel) throw new Error('not checked (see anthropic.api_key)');
  if (claudeModel.error) throw claudeModel.error;
  return `${claudeModel.info.id} is available (${claudeModel.info.display_name})`;
});

await check('anthropic.message', { ANTHROPIC_API_KEY: conf.anthropicKey }, async () => {
  const { Anthropic, client } = await anthropic();
  const t0 = performance.now();
  let message;
  try {
    // No thinking or sampling parameters: current Claude models reject some of them.
    message = await client.messages.create({
      model: conf.anthropicModel,
      max_tokens: 256,
      messages: [{ role: 'user', content: PROBE }],
    });
  } catch (err) {
    throw anthropicFailure(Anthropic, err);
  }
  const ms = Math.round(performance.now() - t0);
  if (message.stop_reason === 'refusal') {
    throw new Error(`the model declined the request${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}`);
  }
  const text = message.content.find((block) => block.type === 'text')?.text?.trim();
  if (!text) throw new Error(`no text in the reply after ${ms} ms (stop_reason ${message.stop_reason})`);
  return `replied in ${ms} ms (stop_reason ${message.stop_reason}): "${short(text, 60)}"`;
});

// --------------------------------------------------------------- Phone ----

console.log('\nPhone (Twilio number through an Elastic SIP trunk)');

const twilioNeeds = { TWILIO_ACCOUNT_SID: conf.twilioSid, TWILIO_AUTH_TOKEN: conf.twilioToken };
const twilioGet = async (path, what) => {
  const basic = Buffer.from(`${conf.twilioSid}:${conf.twilioToken}`).toString('base64');
  const res = await http(`${TWILIO_API}${path}`, { headers: { Authorization: `Basic ${basic}` } });
  if (res.status === 401) throw new Error('Twilio rejected TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN (HTTP 401)');
  return (await expectOk(res, what)).json();
};
const sameNumber = (a, b) => String(a ?? '').replace(/[^\d+]/g, '') === String(b ?? '').replace(/[^\d+]/g, '');

await check('twilio.credentials', twilioNeeds, async () => {
  const account = await twilioGet(`/2010-04-01/Accounts/${encodeURIComponent(conf.twilioSid)}.json`, 'account');
  if (account.status !== 'active') throw new Error(`account is ${account.status}, not active`);
  const trial = account.type === 'Trial' ? '; trial accounts can only call verified numbers' : '';
  return `account ${account.status}, type ${account.type}${trial}`;
});

await check('twilio.number', { ...twilioNeeds, TWILIO_PHONE_NUMBER: conf.twilioNumber }, async () => {
  if (!E164.test(conf.twilioNumber)) throw new Error('TWILIO_PHONE_NUMBER should be E.164, e.g. +14155550100');
  // The whole list is read and matched here, so the number never goes into a URL.
  let owned = null;
  let total = 0;
  let path = `/2010-04-01/Accounts/${encodeURIComponent(conf.twilioSid)}/IncomingPhoneNumbers.json?PageSize=1000`;
  while (path && !owned) {
    const page = await twilioGet(path, 'incoming phone numbers');
    const list = page.incoming_phone_numbers ?? [];
    total += list.length;
    owned = list.find((n) => sameNumber(n.phone_number, conf.twilioNumber)) ?? null;
    path = page.next_page_uri;
  }
  if (!owned) throw new Error(`this account does not own ${maskNumber(conf.twilioNumber)} (${total} number(s) checked)`);
  const voice = owned.capabilities?.voice ? 'voice capable' : 'NO voice capability';
  const trunk = owned.trunk_sid ? 'attached to a SIP trunk' : 'not attached to a SIP trunk';
  return `${maskNumber(conf.twilioNumber)} is owned by this account; ${voice}; ${trunk}`;
});

await check('agora.phone_number', { TWILIO_PHONE_NUMBER: conf.twilioNumber, AGORA_APP_ID: conf.appId, AGORA_APP_CERTIFICATE: conf.appCert }, async () => {
  const numbers = agoraNumbers ?? await loadAgoraNumbers();
  const hit = numbers.find((n) => sameNumber(n.number, conf.twilioNumber));
  if (!hit) throw new Error(`${maskNumber(conf.twilioNumber)} is not imported in Agora (${numbers.length} imported); run npm run phone:setup`);
  const trunk = hit.sip_trunk ?? {};
  return `${maskNumber(conf.twilioNumber)} is imported in Agora; trunk ${trunk.hostname ?? 'hostname missing'} over ${trunk.transport ?? 'unknown transport'}`;
});

// Not a check: just says which model the server will put on a live conversation.
console.log(`\x1b[36mINFO\x1b[0m  ${'voice.llm'.padEnd(28)} ${voiceLlmLabel()} will talk on calls`);

// ------------------------------------------------- Agora + Murf, live ----

if (E2E) {
  console.log('\nEnd to end (starts a real agent for a few seconds)');
  await check('e2e.agent_with_murf_tts', { AGORA_APP_ID: cfg.appId, AGORA_APP_CERTIFICATE: cfg.appCert, MURF_API_KEY: cfg.murfKey }, async () => {
    if (!token) throw new Error('no token (see agora.token_build)');
    const headers = { ...tokenAuth(), 'content-type': 'application/json' };
    const system = [{ role: 'system', content: 'You are a concise voice assistant used for a provider health check.' }];
    const llm = cfg.llmKey
      ? { url: cfg.llmUrl, api_key: cfg.llmKey, params: { model: cfg.llmModel }, system_messages: system, greeting_message: 'Provider check started.', max_history: 8 }
      : { credential_mode: 'managed', vendor: 'openai', style: 'openai', url: 'https://api.openai.com/v1/chat/completions', params: { model: cfg.llmModel }, system_messages: system, greeting_message: 'Provider check started.', max_history: 8 };
    const body = {
      name: `provider-check-${Date.now()}`,
      properties: {
        channel: CHANNEL,
        token,
        agent_rtc_uid: AGENT_UID,
        remote_rtc_uids: [USER_UID],
        enable_string_uid: false,
        idle_timeout: 30,
        asr: { credential_mode: 'managed', vendor: 'deepgram', params: { url: 'wss://api.deepgram.com/v1/listen', model: 'nova-3', language: 'en-US' } },
        llm,
        tts: {
          vendor: 'murf',
          params: { api_key: cfg.murfKey, base_url: cfg.murfWs, voiceId: cfg.murfVoice, locale: cfg.murfLocale, rate: 0, pitch: 0, model: 'FALCON', sample_rate: 24000 },
        },
      },
    };
    const joined = await (await expectOk(await http(`${AGORA_API}/${cfg.appId}/join`, { method: 'POST', headers, body: JSON.stringify(body) }), 'join')).json();
    const agentId = joined.agent_id;
    const agentUrl = `${AGORA_API}/${cfg.appId}/agents/${agentId}`;
    const status = async () => (await (await expectOk(await http(agentUrl, { headers }), 'query')).json()).status;
    try {
      let state = joined.status;
      for (let i = 0; i < 20 && state !== 'RUNNING'; i += 1) {
        if (state === 'FAILED' || state === 'STOPPED') throw new Error(`agent went to ${state} during startup`);
        await sleep(1000);
        state = await status();
      }
      if (state !== 'RUNNING') throw new Error(`agent stuck in ${state} after 20 s`);
      const spoke = await http(`${agentUrl}/speak`, { method: 'POST', headers, body: JSON.stringify({ text: 'Murf Falcon is speaking through the Agora agent.', priority: 'INTERRUPT', interruptable: false }) });
      const speakNote = spoke.ok ? 'speak accepted' : `speak returned HTTP ${spoke.status} ${short(await spoke.text(), 120)}`;
      await sleep(7000);
      state = await status();
      if (state !== 'RUNNING') throw new Error(`agent left RUNNING after TTS broadcast (now ${state}); ${speakNote}`);
      // The turn log is the proof that Murf audio was actually synthesised inside the agent.
      // Agora only publishes it once the session has ended, so stop the agent first.
      await http(`${agentUrl}/leave`, { method: 'POST', headers });
      let turnNote = 'no turn log available';
      let turnsRes;
      for (let i = 0; i < 6; i += 1) {
        await sleep(2500);
        turnsRes = await http(`${agentUrl}/turns`, { headers });
        if (turnsRes.ok) break;
      }
      if (turnsRes.ok) {
        const turns = (await turnsRes.json()).turns ?? [];
        const spoken = turns.filter((t) => ['api_speak', 'greeting'].includes(t.start?.type));
        const errored = spoken.find((t) => t.end?.type === 'error');
        if (errored) throw new Error(`TTS turn failed: ${errored.end?.metadata?.reason ?? ''} ${short(errored.end?.metadata?.details ?? '', 160)}`);
        turnNote = spoken.length
          ? spoken.map((t) => {
              const ttfb = t.metrics?.segmented_latency_ms?.find((s) => s.name === 'tts_ttfb')?.latency;
              const played = t.end?.metadata?.playback_duration_ms;
              return `${t.start.type} turn ${t.end?.type ?? 'in progress'}${played != null ? `, ${played} ms of audio played` : ''}${ttfb != null ? `, Murf first byte ${Math.round(ttfb)} ms` : ''}`;
            }).join('; ')
          : `no spoken turn recorded out of ${turns.length}`;
      } else {
        turnNote = `turn log returned HTTP ${turnsRes.status} ${short(await turnsRes.text(), 120)}`;
      }
      return `agent ${agentId} RUNNING with ${cfg.llmKey ? 'your' : 'managed'} LLM (${cfg.llmModel}) + Murf FALCON; ${speakNote}; ${turnNote}; stopped cleanly`;
    } finally {
      await http(`${agentUrl}/leave`, { method: 'POST', headers }).catch(() => {});
    }
  });
}

// ------------------------------------------------------------- summary ----

const count = (s) => results.filter((r) => r.status === s).length;
console.log(`\n${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped${E2E ? '' : '  (run "npm run check:e2e" to also start a live agent)'}`);
process.exit(count('fail') ? 1 : 0);
