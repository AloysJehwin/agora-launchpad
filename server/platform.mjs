// Client for Agora's Conversational AI Platform API (Preview): sessions, phone numbers.
// This is the API that can place phone calls. The browser path still uses the v2 /join API.
import { createRequire } from 'node:module';
import { env } from './env.mjs';

const { ConvoAITokenBuilder } = createRequire(import.meta.url)('agora-token');

export const PLATFORM_API = `https://preview.ai.agora.io/conversational-ai/v1/projects/${env.appId}`;

export class PlatformError extends Error {
  constructor(status, reason, detail) {
    super(`${reason ?? 'Error'} (${status}): ${detail ?? 'no detail'}`.slice(0, 500));
    this.status = status;
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * A token that carries the ConvoAI, RTC and RTM services.
 * For phone calls and management requests the channel and uid are irrelevant.
 * For an RTC session they must match transport.channel and transport.uid.
 */
export const platformToken = (channel = 'platform', uid = '1001', ttl = 3600) =>
  ConvoAITokenBuilder.buildToken(env.appId, env.appCert, channel, String(uid), ttl, ttl);

/** JSON request to the Platform API. Throws PlatformError with Agora's reason and detail. */
export const platform = async (path, { method = 'GET', body, token, headers } = {}) => {
  const res = await fetch(`${PLATFORM_API}${path}`, {
    method,
    headers: {
      Authorization: `agora token="${token ?? platformToken()}"`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25_000),
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { detail: text }; }
  if (!res.ok) throw new PlatformError(res.status, data.reason, data.detail ?? text);
  return data;
};

/** Every imported phone number in the project: [{ number_id, number, sip_trunk, ... }]. */
export const listNumbers = async () => {
  const out = [];
  let cursor = null;
  do {
    const page = await platform(`/numbers${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...(page.data?.list ?? []));
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return out;
};
