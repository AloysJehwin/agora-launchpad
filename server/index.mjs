#!/usr/bin/env node
// Backend for the voice companion. It never touches audio: it issues tokens and
// starts / stops the Agora agent. The App Certificate and Murf key stay on this side.
//
//   POST /api/token         -> a fresh channel + RTC and RTM tokens for the browser
//   POST /api/agent/start   -> brings the agent (Murf Falcon voice) into that channel
//   POST /api/agent/stop    -> removes it
//   GET  /api/health        -> which credentials are configured (no values)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { env, root, voiceLlmLabel } from './env.mjs';
import { AGENT_UID, buildJoinBody, persona } from './agent-config.mjs';
import { phonePersona } from './phone-agent.mjs';
import { phoneStatus, startCall, getCall, stopCall, stopAllCalls, startRehearsal, stopRehearsal, recentCalls } from './phone.mjs';
import { startPublicServer } from './public.mjs';
import { registerCaller } from './callers.mjs';
import { stopAllTalks } from './concierge.mjs';
import { whatsappStatus } from './notify.mjs';
import { careConsole, careStart, careStop } from './care-mount.mjs';
import { addNumber, isAllowed, listNumbers, removeNumber } from './numbers.mjs';
import { listSites, siteForRef, publicView } from './sites.mjs';

const { RtcTokenBuilder, RtcRole, RtmTokenBuilder, ConvoAITokenBuilder } = createRequire(import.meta.url)('agora-token');

const PORT = env.port;
// Which agent the browser page talks to: 'phone' rehearses the agent that makes phone calls,
// 'companion' is the original generic voice companion.
const BROWSER_AGENT = (process.env.BROWSER_AGENT ?? 'phone').trim().toLowerCase() === 'companion' ? 'companion' : 'phone';
const AGORA_API = `https://api.agora.io/api/conversational-ai-agent/v2/projects/${env.appId}`;
const TOKEN_TTL = 60 * 60; // seconds
const MAX_AGENTS = 2; // Murf's trial allows 3 concurrent Falcon streams; stay under it.

const missing = ['appId', 'appCert', 'murfKey'].filter((k) => !env[k]);

/** channel -> { uid, agentId, token, createdAt } */
const sessions = new Map();
const activeAgents = () => [...sessions.values()].filter((s) => s.agentId).length;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const agora = async (path, token, init = {}) => {
  const res = await fetch(`${AGORA_API}${path}`, {
    ...init,
    headers: { Authorization: `agora token="${token}"`, 'content-type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { detail: text }; }
  if (!res.ok) throw new HttpError(502, `Agora ${path} returned ${res.status}: ${body.detail ?? body.message ?? body.reason ?? text}`.slice(0, 400));
  return body;
};

const stopAgent = async (channel) => {
  const s = sessions.get(channel);
  if (!s?.agentId) return false;
  const { agentId, token, kind } = s;
  s.agentId = null;
  if (kind === 'phone') await stopRehearsal(agentId);
  else await agora(`/agents/${agentId}/leave`, token, { method: 'POST' }).catch((err) => console.warn(`stop ${agentId}: ${err.message}`));
  return true;
};

const routes = {
  'GET /api/health': async () => ({
    ok: missing.length === 0,
    missing: missing.map((k) => ({ appId: 'AGORA_APP_ID', appCert: 'AGORA_APP_CERTIFICATE', murfKey: 'MURF_API_KEY' })[k]),
    agent: BROWSER_AGENT === 'phone'
      ? { name: phonePersona.name, voice: env.murfVoice, llm: 'phone agent rehearsal', model: voiceLlmLabel() }
      : { name: persona.name, voice: env.murfVoice, llm: env.llmKey ? 'your key' : 'Agora managed', model: env.llmModel },
    activeAgents: activeAgents(),
    phone: await phoneStatus(),
  }),

  'POST /api/token': async () => {
    if (missing.length) throw new HttpError(503, 'Server is missing credentials. Run "npm run check".');
    const channel = `room-${randomBytes(6).toString('hex')}`;
    const uid = randomInt(100_000, 999_999);
    sessions.set(channel, { uid, agentId: null, token: null, createdAt: Date.now() });
    return {
      appId: env.appId,
      channel,
      uid,
      agentUid: AGENT_UID,
      rtcToken: RtcTokenBuilder.buildTokenWithUid(env.appId, env.appCert, channel, uid, RtcRole.PUBLISHER, TOKEN_TTL, TOKEN_TTL),
      rtmToken: RtmTokenBuilder.buildToken(env.appId, env.appCert, String(uid), TOKEN_TTL),
      expiresIn: TOKEN_TTL,
    };
  },

  'POST /api/agent/start': async ({ channel, lang }) => {
    const s = sessions.get(channel);
    if (!s) throw new HttpError(404, 'Unknown channel. Request a token first.');
    if (s.agentId) return { agentId: s.agentId, alreadyRunning: true };
    if (activeAgents() >= MAX_AGENTS) throw new HttpError(429, `Already running ${MAX_AGENTS} conversations. Try again in a minute.`);
    if (BROWSER_AGENT === 'phone') {
      const rehearsal = await startRehearsal({ channel, agentUid: AGENT_UID, userUid: s.uid, lang });
      Object.assign(s, { agentId: rehearsal.sessionId, kind: 'phone', ref: rehearsal.ref });
      console.log(`rehearsal ${s.agentId} started in ${channel} (${rehearsal.status})`);
      return { agentId: s.agentId, status: rehearsal.status };
    }
    // One token serves both the REST call and the agent's own RTC + RTM join.
    s.token = ConvoAITokenBuilder.buildToken(env.appId, env.appCert, channel, String(AGENT_UID), TOKEN_TTL, TOKEN_TTL);
    const joined = await agora('/join', s.token, {
      method: 'POST',
      body: JSON.stringify(buildJoinBody({ env, channel, token: s.token, userUid: s.uid })),
    });
    s.agentId = joined.agent_id;
    console.log(`agent ${s.agentId} started in ${channel} (${joined.status})`);
    return { agentId: s.agentId, status: joined.status };
  },

  'POST /api/agent/stop': async ({ channel }) => {
    const stopped = await stopAgent(channel);
    sessions.delete(channel);
    return { stopped };
  },

  // Outbound phone calls
  // The console is the operator's own tool (password protected), so it may call any number.
  'POST /api/call': async ({ to, name, lang }) => startCall({ to, name, lang, trusted: true }),
  // Numbers the public front page is allowed to dial
  'GET /api/numbers': async () => ({ numbers: listNumbers() }),
  'POST /api/numbers': async ({ number }) => { if (!addNumber(number)) throw new HttpError(400, 'Enter a full phone number, for example +91 98765 43210.'); return { ok: true, numbers: listNumbers() }; },
  'POST /api/numbers/remove': async ({ id }) => { removeNumber(String(id ?? '')); return { ok: true, numbers: listNumbers() }; },
  // A caller reference with no phone behind it, for driving the website tools by hand (testing)
  // Pass `to` (it must be on the allow-list) to have the links sent to that phone as on a real call.
  'POST /api/demo-ref': async ({ name, to }) => {
    const ref = randomUUID();
    const phone = to && isAllowed(to) ? to : null;
    registerCaller(ref, { to: phone, name: name ?? null });
    return { ref, messages: Boolean(phone) };
  },
  'GET /api/whatsapp': async () => ({ templates: await whatsappStatus() }),
  'GET /api/calls': async () => ({ calls: recentCalls() }),
  // Websites built so far (newest first), and the one belonging to a browser rehearsal
  'GET /api/sites': async (_body, query) => {
    const channel = query.get('channel');
    if (channel) return { site: publicView(siteForRef(sessions.get(channel)?.ref)) ?? null };
    return { sites: (await listSites()).reverse() };
  },
  'GET /api/call': async (_body, query) => getCall(query.get('id') ?? ''),
  'POST /api/call/stop': async ({ callId }) => stopCall(callId),
};

// ---------------------------------------------------------------- static ----

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.json': 'application/json' };
const VENDOR = {
  '/vendor/agora-rtc.js': 'node_modules/agora-rtc-sdk-ng/AgoraRTC_N-production.js',
  '/vendor/agora-rtm.js': 'node_modules/agora-rtm/agora-rtm.js',
};
const publicDir = join(root, 'public');

const serveStatic = async (pathname, res) => {
  let file;
  if (VENDOR[pathname]) file = join(root, VENDOR[pathname]);
  else {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    file = join(publicDir, rel);
    if (!file.startsWith(publicDir)) return false;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': VENDOR[pathname] ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
};

const readJson = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'Body must be JSON'); }
};

const server = createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  const handler = routes[`${req.method} ${pathname}`];
  try {
    if (await careConsole(req, res, new URL(req.url, 'http://localhost'))) return undefined;
    if (handler) {
      const body = req.method === 'POST' ? await readJson(req) : {};
      const out = await handler(body, searchParams);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(out));
    }
    if (req.method === 'GET' && (await serveStatic(pathname, res))) return undefined;
    throw new HttpError(404, 'Not found');
  } catch (err) {
    const status = err.status ?? 500;
    if (status >= 500) console.error(`${req.method} ${pathname}: ${err.message}`);
    res.writeHead(status, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: err.message }));
  }
});

// Forget abandoned sessions; the agent's own idle_timeout has already removed it from the channel.
setInterval(() => {
  const cutoff = Date.now() - TOKEN_TTL * 1000;
  for (const [channel, s] of sessions) if (s.createdAt < cutoff) sessions.delete(channel);
}, 60_000).unref();

const shutdown = async () => {
  server.close();
  await Promise.allSettled([...sessions.keys()].map(stopAgent));
  await stopAllCalls();
  await stopAllTalks();
  await careStop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startPublicServer();
careStart().catch((err) => console.warn(`care app did not start: ${err.message}`));

server.listen(PORT, env.bindHost, () => {
  console.log(`Voice companion on http://localhost:${PORT}`);
  if (missing.length) console.warn(`Missing credentials (${missing.join(', ')}). Fill .env, then run "npm run check".`);
});
