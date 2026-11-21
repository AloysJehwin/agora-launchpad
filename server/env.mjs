// One place that reads .env. Everything else imports `env` from here.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// .env.local (server-only settings, never deployed over) wins over .env: loadEnvFile keeps
// variables that are already set, so the file loaded first has priority.
for (const file of ['.env.local', '.env']) if (existsSync(join(root, file))) process.loadEnvFile(join(root, file));

const read = (name, fallback = '') => (process.env[name] ?? '').trim() || fallback;

export const env = {
  // Agora
  appId: read('AGORA_APP_ID'),
  appCert: read('AGORA_APP_CERTIFICATE'),

  // Murf Falcon (the voice)
  murfKey: read('MURF_API_KEY'),
  murfVoice: read('MURF_VOICE_ID', 'Matthew'),
  murfLocale: read('MURF_LOCALE', 'en-US'),
  murfWs: read('MURF_WS_URL', 'wss://global.api.murf.ai/v1/speech/stream-input'),

  // Models. Gemini Flash talks on the call; Claude does the heavier work behind it.
  voiceLlm: read('VOICE_LLM').toLowerCase(), // gemini | anthropic | openai | managed | '' (auto)
  geminiKey: read('GEMINI_API_KEY'),
  geminiModel: read('GEMINI_MODEL', 'gemini-flash-latest'),
  anthropicKey: read('ANTHROPIC_API_KEY'),
  // Opus is the default; for live voice (VOICE_LLM=anthropic) claude-haiku-5-5 answers faster.
  anthropicModel: read('ANTHROPIC_MODEL', 'claude-opus-5-5'),
  llmKey: read('LLM_API_KEY'), // optional OpenAI-compatible key; empty = Agora managed
  llmUrl: read('LLM_URL', 'https://api.openai.com/v1/chat/completions'),
  llmModel: read('LLM_MODEL', 'gpt-4.1-mini'),
  asrLanguage: read('ASR_LANGUAGE', 'en-US'),

  // Phone: a Twilio number reached through an Elastic SIP trunk
  twilioSid: read('TWILIO_ACCOUNT_SID'),
  twilioToken: read('TWILIO_AUTH_TOKEN'),
  twilioNumber: read('TWILIO_PHONE_NUMBER'), // E.164, e.g. +14155550100
  sipHost: read('TWILIO_SIP_HOSTNAME'), // the trunk's Termination URI, e.g. acme.pstn.twilio.com
  sipTransport: read('TWILIO_SIP_TRANSPORT', 'tcp').toLowerCase(), // tls only if Secure Trunking is on
  sipUser: read('TWILIO_SIP_USERNAME'),
  sipPass: read('TWILIO_SIP_PASSWORD'),
  // Optional comma-separated E.164 numbers. When set, the server dials only these.
  callAllowlist: read('CALL_ALLOWLIST').split(',').map((n) => n.trim()).filter(Boolean),

  // Website builder. The writer turns the call into page copy: Claude when a key is set,
  // then Gemini, then OpenAI. With no working model the page is built from the caller's own words.
  openaiKey: read('OPENAI_API_KEY'),
  openaiModel: read('OPENAI_MODEL', 'gpt-4.1-mini'),
  // Public https address of the public listener (a tunnel while developing). Agora calls the
  // agent's tools here and the finished pages are served from here.
  publicUrl: read('PUBLIC_URL').replace(/\/+$/, ''),
  publicPort: Number(read('PUBLIC_PORT', '3211')),
  // Base domain for sites: each one lives at <slug>.<publicHost>. Empty = path-based on publicUrl.
  publicHost: read('PUBLIC_HOST').toLowerCase(),
  sitesDir: read('SITES_DIR', join(root, 'sites')),
  // Shared secret Agora sends when it calls the agent's tools.
  toolSecret: read('TOOL_SECRET'),
  bindHost: read('BIND_HOST', '127.0.0.1'),
  // Google sign-in for site owners (admin panel) and, optionally, visitors. The OAuth client
  // must list PUBLIC_URL as an authorised JavaScript origin. Empty = private-link sign-in only.
  googleClientId: read('GOOGLE_CLIENT_ID'),
  sessionSecret: read('SESSION_SECRET'),
  // How the link reaches the caller: sms | whatsapp | none
  linkChannel: read('LINK_CHANNEL', 'whatsapp').toLowerCase(), // whatsapp (text message as fallback) | sms | none
  whatsappFrom: read('TWILIO_WHATSAPP_FROM'),
  // WhatsApp through Meta's Cloud API (templates must be approved by Meta before they can be sent)
  metaToken: read('META_ACCESS_TOKEN'),
  metaPhoneId: read('META_PHONE_NUMBER_ID'),
  metaWabaId: read('META_WABA_ID'),
  metaAppId: read('META_APP_ID'),
  metaAppSecret: read('META_APP_SECRET'),
  metaGraph: read('META_GRAPH_VERSION', 'v21.0'),

  port: Number(read('PORT', '3210')),
};

/** Which model answers on a live conversation, given what is configured. */
export const voiceLlmChoice = () => {
  const has = { gemini: env.geminiKey, anthropic: env.anthropicKey, openai: env.llmKey, managed: true };
  if (env.voiceLlm && has[env.voiceLlm]) return env.voiceLlm;
  return ['gemini', 'anthropic', 'openai'].find((k) => has[k]) ?? 'managed';
};

export const voiceLlmLabel = () => ({
  gemini: `Gemini (${env.geminiModel})`,
  anthropic: `Claude (${env.anthropicModel})`,
  openai: `${env.llmModel} (your key)`,
  managed: `${env.llmModel} (Agora managed)`,
})[voiceLlmChoice()];

export const E164 = /^\+[1-9][0-9]{6,14}$/;
export const maskNumber = (n) => (n ? `${n.slice(0, 3)}${'•'.repeat(Math.max(0, n.length - 5))}${n.slice(-2)}` : null);
