#!/usr/bin/env node
// Copies selected keys from an AWS Secrets Manager secret into .env without printing them.
// The secret JSON arrives in the SECRET_JSON environment variable, resolved by asm-exec,
// so the values never appear on the command line or in the terminal:
//
//   SECRET_JSON='{{resolve:secretsmanager:<your-secret-name>}}' asm-exec node scripts/pull-env.mjs
//
// Existing non-empty values in .env are kept unless --force is passed.
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
const force = process.argv.includes('--force');

// .env name  <-  candidate names in the secret, first non-empty wins
const MAP = {
  TWILIO_ACCOUNT_SID: ['TWILIO_ACCOUNT_SID'],
  TWILIO_AUTH_TOKEN: ['TWILIO_AUTH_TOKEN'],
  TWILIO_PHONE_NUMBER: ['TWILIO_PHONE_NUMBER', 'TWILIO_FROM_NUMBER'],
  GEMINI_API_KEY: ['GEMINI_API_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  ANTHROPIC_API_KEY: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
  OPENAI_API_KEY: ['OPENAI_API_KEY'],
  TWILIO_WHATSAPP_FROM: ['TWILIO_WHATSAPP_FROM'],
  META_ACCESS_TOKEN: ['META_ACCESS_TOKEN'],
  META_PHONE_NUMBER_ID: ['META_PHONE_NUMBER_ID'],
  META_APP_ID: ['META_APP_ID'],
  META_APP_SECRET: ['META_APP_SECRET'],
  META_WABA_ID: ['META_WABA_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID'],
};

let secret;
try {
  secret = JSON.parse(process.env.SECRET_JSON ?? '');
} catch {
  console.error('SECRET_JSON is missing or not JSON. Run this through asm-exec (see the comment at the top of this file).');
  process.exit(1);
}

const lines = existsSync(envPath) ? readFileSync(envPath, 'utf8').split('\n') : [];
const current = Object.fromEntries(lines.filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const report = [];

for (const [name, candidates] of Object.entries(MAP)) {
  const source = candidates.find((c) => typeof secret[c] === 'string' && secret[c].trim());
  if (!source) { report.push(`  ${name}: not in the secret`); continue; }
  if (current[name]?.trim() && !force) { report.push(`  ${name}: kept the value already in .env`); continue; }
  const value = secret[source].trim();
  if (/[\r\n]/.test(value)) { report.push(`  ${name}: skipped, value spans several lines`); continue; }
  const row = `${name}=${value}`;
  const at = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (at >= 0) lines[at] = row; else lines.push(row);
  report.push(`  ${name}: set from ${source} (${value.length} characters)`);
}

writeFileSync(envPath, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
chmodSync(envPath, 0o600);
console.log(`Updated ${envPath}\n${report.join('\n')}`);
