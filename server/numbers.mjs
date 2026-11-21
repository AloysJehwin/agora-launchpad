// The phone numbers the PUBLIC front page may dial ("Call me now"). The operator console can
// call any number; this list exists so that a public form cannot be used to phone strangers.
// It is managed from the console and kept on disk; CALL_ALLOWLIST in .env seeds it.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { env, E164 } from './env.mjs';

const file = () => join(env.sitesDir, '_numbers.json');
let numbers = null;

const load = () => {
  if (numbers) return numbers;
  let saved = [];
  try { saved = JSON.parse(readFileSync(file(), 'utf8')); } catch { /* first run */ }
  numbers = [...new Set([...(Array.isArray(saved) ? saved : []), ...env.callAllowlist])].filter((n) => E164.test(n));
  return numbers;
};
const save = () => { try { mkdirSync(env.sitesDir, { recursive: true }); writeFileSync(file(), JSON.stringify(numbers)); } catch (err) { console.warn(`numbers not saved: ${err.message}`); } };

const idOf = (n) => createHash('sha256').update(n).digest('hex').slice(0, 12);
const masked = (n) => `${n.slice(0, 3)}${'•'.repeat(Math.max(0, n.length - 7))}${n.slice(-4)}`;

export const normaliseNumber = (raw) => {
  const digits = String(raw ?? '').replace(/[^\d+]/g, '');
  if (E164.test(digits)) return digits;
  return /^\d{10}$/.test(digits) ? `+91${digits}` : null; // a bare ten-digit number is taken as Indian
};

export const isAllowed = (number) => load().includes(number);
export const listNumbers = () => load().map((n) => ({ id: idOf(n), number: masked(n) }));
export const addNumber = (raw) => {
  const n = normaliseNumber(raw);
  if (!n) return false;
  if (!load().includes(n)) { numbers.push(n); save(); }
  return true;
};
export const removeNumber = (id) => { const before = load().length; numbers = numbers.filter((n) => idOf(n) !== id); save(); return numbers.length !== before; };
