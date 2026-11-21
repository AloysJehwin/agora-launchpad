// Pictures made on request during a call ("put a photo of gears in the top section").
// Google's image model is used when its key works; until then a free image service stands in
// (its pictures carry that service's small mark in a corner). The file is saved with the site,
// so the page does not depend on the generator staying up.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { env } from './env.mjs';

const STYLE = 'Realistic photograph, bright natural light, sharp focus, clean uncluttered composition, professional quality. No text, no lettering, no logos, no watermark, no people\'s faces.';
const SIZES = { '3:2': [1200, 800], '4:3': [1200, 900], '1:1': [1000, 1000], '16:9': [1280, 720] };

const withGoogle = async (prompt, ratio) => {
  const model = (process.env.GEMINI_IMAGE_MODEL ?? '').trim() || 'gemini-3.1-flash-image';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': env.geminiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: ratio } } }),
    signal: AbortSignal.timeout(45_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google ${res.status}: ${data.error?.message ?? 'refused'}`.slice(0, 160));
  const part = (data.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data);
  if (!part) throw new Error('Google returned no image');
  return { bytes: Buffer.from(part.inlineData.data, 'base64'), type: part.inlineData.mimeType ?? 'image/png', by: 'Google' };
};

const withFreeService = async (prompt, ratio) => {
  const [w, h] = SIZES[ratio] ?? SIZES['3:2'];
  // Without an account the free service makes one picture every 45 seconds per address. When it
  // says "retry after N seconds", wait and try again only if that fits in about 20 seconds; a
  // caller should not be kept waiting longer (the page then gets a drawn illustration instead).
  const deadline = Date.now() + 20_000;
  let last = '';
  for (;;) {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 600))}?width=${w}&height=${h}&seed=${Math.floor(Math.random() * 1e9)}&nologo=true&model=flux`;
    const res = await fetch(url, { signal: AbortSignal.timeout(45_000) }).catch((err) => ({ ok: false, status: 599, headers: new Headers(), text: async () => err.message }));
    if (res.ok && String(res.headers.get('content-type')).startsWith('image/')) return { bytes: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type'), by: 'free image service' };
    const body = await res.text().catch(() => '');
    last = `image service answered ${res.status}${/FREE_LIMIT/.test(body) ? ' (one picture per 45 seconds)' : ''}`;
    if (![402, 429, 503, 599].includes(res.status)) break;
    const wait = (Number((body.match(/Retry after (\d+)s/i) ?? [])[1]) || 10) * 1000 + 1500;
    if (Date.now() + wait > deadline) break;
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error(last);
};

let googleBlockedUntil = 0; // a refused key (for example unpaid billing) is not retried on every picture

/**
 * Make a picture of `subject` and store it with the site.
 * Resolves to { src, alt, by } or throws when every generator failed.
 * `subject` is the caller's description of the picture; never put names or contact details in it.
 */
export const generateImage = async ({ dir, subject, ratio = '3:2' }) => {
  const what = String(subject ?? '').replace(/[\r\n]+/g, ' ').replace(/\+?\d[\d\s-]{6,}/g, '').trim().slice(0, 300);
  if (!what) throw new Error('nothing to draw');
  const prompt = `${what}. ${STYLE}`;
  const errors = [];
  for (const [has, make] of [[() => env.geminiKey && Date.now() > googleBlockedUntil, withGoogle], [() => true, withFreeService]]) {
    if (!has()) continue;
    try {
      const out = await make(prompt, SIZES[ratio] ? ratio : '3:2');
      if (out.bytes.length < 4000) throw new Error('the picture came back empty');
      const ext = /png/.test(out.type) ? 'png' : /webp/.test(out.type) ? 'webp' : 'jpg';
      const name = `${randomBytes(6).toString('hex')}.${ext}`;
      await mkdir(join(dir, 'img'), { recursive: true });
      await writeFile(join(dir, 'img', name), out.bytes);
      const [w, h] = SIZES[ratio] ?? SIZES['3:2'];
      return { src: `/_lp/img/${name}`, alt: what.charAt(0).toUpperCase() + what.slice(1), by: out.by, width: w, height: h };
    } catch (err) {
      if (make === withGoogle && /Google 40[13]/.test(err.message)) googleBlockedUntil = Date.now() + 10 * 60_000;
      errors.push(err.message.slice(0, 120));
    }
  }
  throw new Error(errors.join('; ').slice(0, 300));
};
