// Try the designer on a sample brief.
//
//   node scripts/try-designer.mjs [--lang hi] [--change "make it dark green"]
//
// Designs a page for a neighbourhood cafe, printing each section as it arrives, and writes
// out/design-sample.html. With --change it then revises that page and writes
// out/design-sample-revised.html. Needs ANTHROPIC_API_KEY in .env.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { env, root } from '../server/env.mjs';
import { describeSite, designerReady, designSite, reviseSite, DesignRefusedError } from '../server/site-designer.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return '';
  const value = args[at + 1];
  if (!value || value.startsWith('--')) {
    console.error(`--${name} needs a value`);
    process.exit(1);
  }
  return value;
};
const lang = option('lang') || 'en';
const change = option('change');

if (!designerReady()) {
  console.error('ANTHROPIC_API_KEY is missing. Paste your Anthropic key after ANTHROPIC_API_KEY= in .env, then run this again.');
  process.exit(1);
}

const brief = {
  business_name: 'Kaapi & Crumb',
  what_they_do: 'A small neighbourhood cafe in Indiranagar, Bengaluru. South Indian filter coffee, pour-overs and bakes that are made in-house every morning.',
  audience: 'People who live and work nearby: remote workers, college students, families on weekend mornings.',
  highlights: 'Filter coffee made with beans roasted in Chikmagalur. Banana walnut bread. Masala chai. A quiet back room with plug points for people who want to work. Dog friendly.',
  contact: 'Phone 080 5550 0142. Open every day from 7 in the morning to 9 at night. 12th Main Road, Indiranagar.',
  style: 'Warm and earthy, a bit old Bangalore, not too fancy.',
  owner_name: 'Meera',
};

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const kb = (text) => `${(Buffer.byteLength(text) / 1024).toFixed(1)} KB`;
const usageLine = (usage) => [
  `in ${usage?.input_tokens ?? '?'}`,
  `out ${usage?.output_tokens ?? '?'}`,
  usage?.output_tokens_details?.thinking_tokens != null ? `of which thinking ${usage.output_tokens_details.thinking_tokens}` : '',
  usage?.cache_read_input_tokens ? `cache read ${usage.cache_read_input_tokens}` : '',
  usage?.cache_creation_input_tokens ? `cache write ${usage.cache_creation_input_tokens}` : '',
].filter(Boolean).join(', ');

const explain = (err) => {
  if (err instanceof DesignRefusedError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return 'ANTHROPIC_API_KEY was rejected (HTTP 401). Check the key in .env.';
  if (err instanceof Anthropic.PermissionDeniedError) return `this key may not use ${env.anthropicModel} (HTTP 403)`;
  if (err instanceof Anthropic.NotFoundError) return `model "${env.anthropicModel}" was not found for this key (HTTP 404). Check ANTHROPIC_MODEL.`;
  if (err instanceof Anthropic.RateLimitError) return 'rate limited (HTTP 429). Try again shortly.';
  if (err instanceof Anthropic.BadRequestError) return `the API rejected the request (HTTP 400): ${String(err.message).slice(0, 300)}`;
  if (err instanceof Anthropic.APIConnectionError) return `could not reach api.anthropic.com: ${String(err.message).slice(0, 160)}`;
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ''}: ${String(err.message).slice(0, 300)}`;
  return String(err?.message ?? err);
};

const outDir = join(root, 'out');
mkdirSync(outDir, { recursive: true });

try {
  console.log(`Designing "${brief.business_name}" in ${lang} with ${env.anthropicModel} (effort ${process.env.DESIGN_EFFORT?.trim() || 'low'})`);
  const started = Date.now();
  let firstChunk = null;
  let streamed = 0;
  const page = await designSite({
    brief,
    lang,
    onHtml: (text) => {
      firstChunk ??= Date.now() - started;
      streamed += text.length;
    },
    onStep: (label) => console.log(`  ${seconds(Date.now() - started).padStart(6)}  ${label}`),
  });
  const file = join(outDir, 'design-sample.html');
  writeFileSync(file, page.html);
  console.log(`\nFirst HTML chunk  ${firstChunk === null ? 'never' : seconds(firstChunk)}`);
  console.log(`Total             ${seconds(page.ms)}`);
  console.log(`Output            ${kb(page.html)} (${streamed} characters streamed)${page.truncated ? '  TRUNCATED by DESIGN_MAX_TOKENS' : ''}`);
  console.log(`Tokens            ${usageLine(page.usage)}`);
  console.log(`Model             ${page.model}`);
  console.log(`Title             ${describeSite(page.html).title}`);
  console.log(`Sections          ${page.sections.join(' | ')}`);
  console.log(`Wrote             ${file}`);

  if (change) {
    console.log(`\nRevising: "${change}"`);
    const revisedAt = Date.now();
    const revised = await reviseSite({
      html: page.html,
      change,
      lang,
      onStep: (label) => console.log(`  ${seconds(Date.now() - revisedAt).padStart(6)}  ${label}`),
    });
    const revisedFile = join(outDir, 'design-sample-revised.html');
    writeFileSync(revisedFile, revised.html);
    console.log(`\nMode              ${revised.mode}`);
    console.log(`Summary           ${revised.summary}`);
    console.log(`Total             ${seconds(revised.ms)}`);
    console.log(`Output            ${kb(revised.html)}`);
    console.log(`Wrote             ${revisedFile}`);
  }
} catch (err) {
  console.error(`\nFailed: ${explain(err)}`);
  process.exit(1);
}
