// Turns what the caller said into the content of their page (a small JSON object that
// site-template.mjs renders). Claude writes it when a key is set, then Gemini, then OpenAI.
// If no model answers in time, the page is built from the caller's own words: the link must
// always work while they are still on the phone.
import Anthropic from '@anthropic-ai/sdk';
import { env } from './env.mjs';
import { THEMES, MOODS, normaliseSite } from './site-template.mjs';

const WRITER_TIMEOUT_MS = 14_000;

const describe = (set) => Object.entries(set).map(([key, v]) => `  ${key}: ${v.description}`).join('\n');

const SYSTEM = `You write the content for a one-page website for a small business or an individual, from notes taken on a phone call with the owner.

Return ONLY a JSON object, no markdown fence and no commentary, with exactly these fields:
{
  "name": string,            // the business or person name, spelled as given
  "kind": string,            // two or three words for what it is, e.g. "neighbourhood cafe"; "" if unclear
  "tagline": string,         // at most 12 words, concrete, no hype
  "intro": string,           // 1 to 3 sentences in a plain, confident voice
  "highlights": [{ "title": string, "text": string }],   // 2 to 4 items; title up to 5 words, text one or two sentences
  "audience": string,        // one sentence about who it is for; "" if unknown
  "contact": { "phone": string, "whatsapp": string, "email": string, "address": string, "hours": string, "note": string },
  "cta": string,             // 2 to 4 words for the main button, matching the best contact method, e.g. "Call to order"
  "theme": string,           // one key from THEMES
  "mood": string             // one key from MOODS
}

THEMES (pick the one that fits the business and anything the owner said about colour or style):
${describe(THEMES)}

MOODS:
${describe(MOODS)}

Rules:
- Use only facts from the notes. Never invent prices, awards, years in business, opening hours, addresses, phone numbers, emails or customer quotes. Leave a contact field as "" when it was not given.
- You may phrase what the owner said more clearly, and you may describe a highlight in general terms that follow directly from what they said.
- Write in the same language the notes are in. No emoji. No exclamation marks. No words like "premier", "world-class", "passionate" or "solutions".
- Phone numbers: keep the digits exactly as given.`;

const briefText = (brief) => [
  `Business or person name: ${brief.business_name || '(not given)'}`,
  `What they do or sell: ${brief.what_they_do || '(not given)'}`,
  `Who it is for: ${brief.audience || '(not given)'}`,
  `Things to highlight: ${brief.highlights || '(not given)'}`,
  `How customers should contact them: ${brief.contact || '(not given)'}`,
  `Colour or style wishes: ${brief.style || '(none)'}`,
  brief.owner_name ? `Owner's name: ${brief.owner_name}` : '',
].filter(Boolean).join('\n');

const userPrompt = ({ brief, current, change }) =>
  current && change
    ? `Here is the current page content as JSON:\n${JSON.stringify(current)}\n\nThe owner asked for this change on the phone: "${change}"\n\nReturn the full updated JSON. Change only what the request needs and keep everything else exactly as it is.`
    : `Notes from the call:\n${briefText(brief)}\n\nReturn the JSON for the page.`;

const parseJson = (text) => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the writer returned no JSON object');
  return JSON.parse(text.slice(start, end + 1));
};

// ---------------------------------------------------------------- writers ----

const withClaude = async (prompt, signal) => {
  const client = new Anthropic({ apiKey: env.anthropicKey, maxRetries: 0 });
  const response = await client.messages.create({
    model: env.anthropicModel,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort: 'low' }, // short copy on a live call: favour speed
  }, { signal });
  if (response.stop_reason === 'refusal') throw new Error('Claude declined the request');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return parseJson(text);
};

const withGemini = async (prompt, signal) => {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.geminiModel)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.geminiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${data.error?.message ?? 'request failed'}`.slice(0, 200));
  return parseJson((data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join(''));
};

const withOpenAI = async (prompt, signal) => {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.openaiKey}` },
    body: JSON.stringify({
      model: env.openaiModel,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
    }),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${data.error?.message ?? 'request failed'}`.slice(0, 200));
  return parseJson(data.choices?.[0]?.message?.content ?? '');
};

const WRITERS = [
  ['claude', () => env.anthropicKey, withClaude],
  ['gemini', () => env.geminiKey, withGemini],
  ['openai', () => env.openaiKey, withOpenAI],
];

export const availableWriters = () => WRITERS.filter(([, has]) => has()).map(([name]) => name);

// ------------------------------------------------- no-model fallback ----

const phoneIn = (s) => (String(s ?? '').match(/\+?\d[\d\s().-]{7,}\d/) ?? [''])[0].trim();
const emailIn = (s) => (String(s ?? '').match(/[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/) ?? [''])[0];

/** Build the page from the caller's own words, with no model involved. */
export const contentFromBrief = (brief) => {
  const highlights = String(brief.highlights ?? '').split(/;|\n|,| and /).map((h) => h.trim()).filter((h) => h.length > 2).slice(0, 4);
  const phone = phoneIn(brief.contact);
  const email = emailIn(brief.contact);
  return normaliseSite({
    name: brief.business_name,
    kind: '',
    tagline: brief.what_they_do,
    intro: '',
    highlights: highlights.map((h) => ({ title: h.charAt(0).toUpperCase() + h.slice(1), text: '' })),
    audience: brief.audience,
    contact: { phone, email, note: !phone && !email ? brief.contact : '' },
    cta: phone ? 'Call us' : email ? 'Email us' : '',
  });
};

// --------------------------------------------------------------- public ----

/**
 * Returns { site, writer, ms, errors }. `writer` is 'claude' | 'gemini' | 'openai' | 'none'.
 * For an edit, pass { current, change }; if every writer fails the current content is kept.
 */
export const writeContent = async ({ brief, current, change }) => {
  const prompt = userPrompt({ brief, current, change });
  const started = Date.now();
  const errors = [];
  for (const [name, has, write] of WRITERS) {
    if (!has()) continue;
    const left = WRITER_TIMEOUT_MS - (Date.now() - started);
    if (left < 2_000) break;
    try {
      const raw = await write(prompt, AbortSignal.timeout(left));
      // Facts the model must not change on its own: the name on a fresh build.
      if (!change && brief?.business_name) raw.name = brief.business_name;
      return { site: normaliseSite(raw), writer: name, ms: Date.now() - started, errors };
    } catch (err) {
      errors.push(`${name}: ${err.message}`.slice(0, 220));
    }
  }
  return { site: current ? normaliseSite(current) : contentFromBrief(brief), writer: 'none', ms: Date.now() - started, errors };
};
