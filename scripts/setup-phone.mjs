#!/usr/bin/env node
// One-time phone plumbing: lets the voice agent place calls with a Twilio number as its caller ID.
//
//   node scripts/setup-phone.mjs           read-only: prints the plan, changes nothing
//   node scripts/setup-phone.mjs --apply   performs the plan (safe to re-run: existing resources are reused)
//
// Twilio side: an Elastic SIP trunk with a Termination SIP URI, an IP Access Control List that
// whitelists Agora's SIP source IPs, and the phone number attached to the trunk.
// Agora side:  the number imported into the project, pointing at that trunk.
//
// Secrets (auth token, SIP password) are sent to Twilio/Agora and never printed.

import { env, E164, maskNumber } from '../server/env.mjs';
import { platform, listNumbers, platformToken, PlatformError, PLATFORM_API } from '../server/platform.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
// Attaching the number to the trunk re-routes INBOUND voice calls to that number away from its
// current voice webhook. Outbound calls only need the number as caller ID, so this is opt-in.
const ATTACH_NUMBER = args.includes('--attach-number');
if (args.includes('--help') || args.includes('-h') || args.some((a) => !['--apply', '--attach-number'].includes(a))) {
  console.log('Usage: node scripts/setup-phone.mjs [--apply] [--attach-number]\n\n  (no flag)        read-only, prints what --apply would create or change\n  --apply          create/update the Twilio trunk and ACL, then import the number into Agora\n  --attach-number  also attach the number to the trunk (changes how INBOUND calls to it are routed)');
  process.exit(args.includes('--help') || args.includes('-h') ? 0 : 1);
}

const TRUNK_NAME = 'Agora Voice Agent';
const ACL_NAME = 'Agora SIP';
const CRED_LIST_NAME = 'Agora SIP Credentials';
const NUMBER_DESCRIPTION = 'Outbound caller ID for the voice agent';

// Agora SIP outgoing IPs per country-code group, copied from Agora's "Set up SIP trunk" guide.
const IP_GROUPS = [
  {
    label: 'United States',
    codes: ['1'],
    // The last address is not in Agora's guide. Twilio logged it as the real source of calls placed
    // through the Platform (Preview) API on 2026-11-21 (an AWS us-west-2 host). If Twilio starts
    // rejecting calls with error 32201, read SipSrcIp in the Twilio alert and add it here.
    ips: ['49.51.250.59', '49.51.250.76', '32.191.115.179'],
  },
  {
    label: 'Americas, Europe, Oceania',
    codes: ['52', '54', '55', '56', '51', '44', '33', '49', '39', '34', '61', '64'],
    ips: [
      '43.157.157.7', '43.157.180.46', '43.157.154.150', '43.157.147.39', '43.157.160.149', '43.157.170.160',
      '43.157.176.50', '43.157.182.24', '43.157.150.207', '43.157.146.198', '43.157.186.243', '43.157.149.172',
    ],
  },
  {
    label: 'Asia-Pacific, India, Africa',
    codes: ['82', '65', '81', '91', '886', '27', '20', '254'],
    ips: [
      '3.111.249.176', '15.207.132.164', '13.205.109.117', '13.127.230.35', '13.200.127.200', '13.205.242.117',
      '13.232.246.98', '13.235.159.216', '43.204.61.200', '52.66.173.52', '65.1.195.82', '65.1.38.21',
    ],
  },
];

// ---------- output ----------

const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const TAG = {
  ok: paint(32, 'ok  '),
  plan: paint(33, 'plan'),
  done: paint(32, 'done'),
  warn: paint(33, 'warn'),
  fail: paint(31, 'FAIL'),
};
const say = (tag, text) => console.log(`  ${TAG[tag]}  ${text}`);
const heading = (text) => console.log(`\n${text}`);

let changes = 0; // planned (read-only) or performed (--apply)
const warnings = [];
const manual = [];
const warn = (text) => { warnings.push(text); say('warn', text); };

class TwilioError extends Error {
  constructor(status, code, message) {
    super(String(message ?? 'no message').slice(0, 500));
    this.status = status;
    this.code = code;
  }
}

const describeError = (err) => {
  if (err instanceof TwilioError) return `Twilio HTTP ${err.status}${err.code ? ` (code ${err.code})` : ''}: ${err.message}`;
  if (err instanceof PlatformError) return `Agora HTTP ${err.status}: ${err.reason ?? 'Error'}: ${err.detail ?? 'no detail'}`.slice(0, 600);
  return err?.name === 'TimeoutError' ? 'request timed out' : (err?.message ?? String(err));
};

const die = (label, err) => {
  console.error(`  ${TAG.fail}  ${label}\n        ${typeof err === 'string' ? err : describeError(err)}`);
  if (APPLY && changes) console.error('\nEarlier steps were kept. Fix the problem and run the same command again; nothing will be duplicated.');
  process.exit(1);
};

/** A GET that must succeed for the script to continue. */
const read = async (label, fn) => {
  try { return await fn(); } catch (err) { return die(label, err); }
};

/** A state change. Read-only mode prints it and returns null; --apply runs it and returns the result. */
const change = async (text, fn) => {
  changes += 1;
  if (!APPLY) { say('plan', text); return null; }
  try {
    const result = await fn();
    say('done', text);
    return result;
  } catch (err) {
    return die(text, err);
  }
};

// ---------- preflight (no network) ----------

const required = {
  TWILIO_ACCOUNT_SID: env.twilioSid,
  TWILIO_AUTH_TOKEN: env.twilioToken,
  TWILIO_PHONE_NUMBER: env.twilioNumber,
  AGORA_APP_ID: env.appId,
  AGORA_APP_CERTIFICATE: env.appCert,
};
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(', ')}\nFill these in and run again. Nothing was contacted or changed.`);
  process.exit(1);
}

const problems = [];
if (!/^AC[0-9a-fA-F]{32}$/.test(env.twilioSid)) problems.push('TWILIO_ACCOUNT_SID must be an Account SID (AC followed by 32 hex characters), not an API key SID.');
if (!E164.test(env.twilioNumber)) problems.push('TWILIO_PHONE_NUMBER must be in E.164 format, for example +14155550100.');
if (!['tcp', 'udp', 'tls'].includes(env.sipTransport)) problems.push('TWILIO_SIP_TRANSPORT must be tcp, udp or tls.');
if (Boolean(env.sipUser) !== Boolean(env.sipPass)) problems.push('Set both TWILIO_SIP_USERNAME and TWILIO_SIP_PASSWORD, or neither.');
if (env.sipUser.length > 32) problems.push('TWILIO_SIP_USERNAME can be at most 32 characters (Twilio limit).');

// The trunk's DomainName is always <label>.pstn.twilio.com. A localized Termination URI such as
// <label>.pstn.ashburn.twilio.com belongs to the same trunk and is what Agora is told to dial.
const defaultDomain = `agora-voice-${env.twilioSid.slice(-8).toLowerCase()}.pstn.twilio.com`;
const givenHost = env.sipHost.toLowerCase();
const hostMatch = givenHost.match(/^([a-z0-9-]+)\.pstn\.(?:[a-z0-9-]+\.)?twilio\.com$/);
if (givenHost && !hostMatch) problems.push('TWILIO_SIP_HOSTNAME must be a bare Twilio Termination URI host such as acme.pstn.twilio.com (no sip: prefix, no port).');

const digits = env.twilioNumber.slice(1);
const group = [3, 2, 1]
  .map((len) => IP_GROUPS.find((g) => g.codes.includes(digits.slice(0, len))))
  .find(Boolean);
if (E164.test(env.twilioNumber) && !group) {
  const supported = IP_GROUPS.flatMap((g) => g.codes).map((c) => `+${c}`).join(', ');
  problems.push(`Agora publishes no SIP source IPs for the country code of TWILIO_PHONE_NUMBER. Supported country codes: ${supported}.`);
}

if (problems.length) {
  console.error(`Cannot continue:\n${problems.map((p) => `  - ${p}`).join('\n')}\nNothing was contacted or changed.`);
  process.exit(1);
}

const transport = env.sipTransport;
const secure = transport === 'tls';
const useCreds = Boolean(env.sipUser && env.sipPass);
const number = env.twilioNumber;
const masked = maskNumber(number);
let trunkDomain = hostMatch ? `${hostMatch[1]}.pstn.twilio.com` : defaultDomain; // Twilio DomainName
let agoraHost = givenHost || defaultDomain; // what Agora dials

// ---------- Twilio client ----------

const API = `https://api.twilio.com/2010-04-01/Accounts/${env.twilioSid}`;
const TRUNKING = 'https://trunking.twilio.com/v1';
const VOICE = 'https://voice.twilio.com/v1';
const TWILIO_HOSTS = new Set(['api.twilio.com', 'trunking.twilio.com', 'voice.twilio.com']);
const twilioAuth = `Basic ${Buffer.from(`${env.twilioSid}:${env.twilioToken}`).toString('base64')}`;

const twilio = async (url, { method = 'GET', form } = {}) => {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !TWILIO_HOSTS.has(target.hostname)) throw new Error(`refusing to send Twilio credentials to ${target.hostname}`);
  if (method !== 'GET' && !APPLY) throw new Error(`internal error: ${method} attempted in read-only mode`);
  const res = await fetch(target, {
    method,
    headers: {
      Authorization: twilioAuth,
      Accept: 'application/json',
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(25_000),
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.replace(/\s+/g, ' ').slice(0, 300) }; }
  if (!res.ok) throw new TwilioError(res.status, data.code, data.message ?? data.detail);
  return data;
};

/** Every item of a paged Twilio list. 2010-04-01 pages with next_page_uri, v1 APIs with meta.next_page_url. */
const twilioList = async (url, key) => {
  const out = [];
  let next = url;
  while (next) {
    const page = await twilio(next);
    out.push(...(page[key] ?? []));
    next = page.meta?.next_page_url ?? (page.next_page_uri ? `https://api.twilio.com${page.next_page_uri}` : null);
  }
  return out;
};

const ipToInt = (ip) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
/** Does an existing ACL entry already allow this IP? */
const covers = (entry, ip) => {
  const prefix = Number(entry.cidr_prefix_length);
  if (!(prefix >= 1 && prefix < 32)) return entry.ip_address === ip;
  const size = 2 ** (32 - prefix);
  return Math.floor(ipToInt(entry.ip_address) / size) === Math.floor(ipToInt(ip) / size);
};

// ---------- Agora helpers ----------

const agoraWrite = (path, options) => {
  if (!APPLY) throw new Error(`internal error: ${options.method} attempted in read-only mode`);
  return platform(path, options);
};

/** PATCH /numbers/{id} requires If-Match with the ETag of the latest GET of that number. */
const numberEtag = async (numberId) => {
  const res = await fetch(`${PLATFORM_API}/numbers/${numberId}`, {
    headers: { Authorization: `agora token="${platformToken()}"` },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) {
    let data = {};
    try { data = await res.json(); } catch { /* not JSON */ }
    throw new PlatformError(res.status, data.reason, data.detail);
  }
  const etag = res.headers.get('etag');
  if (!etag) throw new Error('Agora returned no ETag header for the number, so it cannot be updated safely. Update it in Agora Console instead.');
  return etag;
};

// ---------- run ----------

console.log(`Phone setup for ${masked}  (${APPLY ? '--apply: making changes' : 'read-only: nothing will be changed'})`);
console.log(`Agora SIP source IPs: ${group.ips.length} addresses for the "${group.label}" group`);

heading('Twilio');

const account = await read('Read the Twilio account', () => twilio(`${API}.json`));
if (account.status && account.status !== 'active') warn(`The Twilio account status is "${account.status}".`);
const trial = String(account.type ?? '').toLowerCase() === 'trial';
say('ok', `Credentials accepted. Account type: ${account.type ?? 'unknown'}`);

// 1. The number must belong to this account.
const owned = await read('Look up the phone number', () =>
  twilioList(`${API}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`, 'incoming_phone_numbers'));
const twilioNumber = owned.find((n) => n.phone_number === number);
if (!twilioNumber) die('Look up the phone number', `${masked} is not an active number on this Twilio account. Check TWILIO_PHONE_NUMBER, or buy the number first.`);
say('ok', `${masked} is owned by this account`);
if (twilioNumber.capabilities && twilioNumber.capabilities.voice === false) warn('This number is not voice-capable according to Twilio.');

// 2. The trunk: matched by Termination URI domain first, then by friendly name.
const trunks = await read('List Elastic SIP trunks', () => twilioList(`${TRUNKING}/Trunks?PageSize=100`, 'trunks'));
const named = trunks.find((t) => t.friendly_name === TRUNK_NAME);
if (!givenHost && named?.domain_name) {
  // No hostname in .env but the trunk from an earlier run has one: keep it rather than renaming it.
  trunkDomain = named.domain_name.toLowerCase();
  agoraHost = trunkDomain;
}
let trunk = trunks.find((t) => (t.domain_name ?? '').toLowerCase() === trunkDomain) ?? named ?? null;
const secureLabel = `Secure Trunking ${secure ? 'on' : 'off'}`;

if (!trunk) {
  trunk = await change(`Create Elastic SIP trunk "${TRUNK_NAME}" with Termination URI ${trunkDomain}, ${secureLabel}`, () =>
    twilio(`${TRUNKING}/Trunks`, { method: 'POST', form: { FriendlyName: TRUNK_NAME, DomainName: trunkDomain, Secure: String(secure) } }));
} else {
  const form = {};
  const what = [];
  if ((trunk.domain_name ?? '').toLowerCase() !== trunkDomain) { form.DomainName = trunkDomain; what.push(`set Termination URI to ${trunkDomain}`); }
  if (Boolean(trunk.secure) !== secure) { form.Secure = String(secure); what.push(`turn ${secureLabel}`); }
  if (what.length) {
    const sid = trunk.sid;
    const updated = await change(`Update trunk "${trunk.friendly_name}" (${sid}): ${what.join(', ')}`, () =>
      twilio(`${TRUNKING}/Trunks/${sid}`, { method: 'POST', form }));
    if (updated) trunk = updated;
  } else {
    say('ok', `Trunk "${trunk.friendly_name}" (${trunk.sid}) exists: ${trunkDomain}, ${secureLabel}`);
  }
}

if (twilioNumber.trunk_sid && twilioNumber.trunk_sid !== trunk?.sid) {
  const other = trunks.find((t) => t.sid === twilioNumber.trunk_sid);
  die('Attach the phone number to the trunk',
    `${masked} is already attached to a different trunk (${twilioNumber.trunk_sid}${other?.domain_name ? `, ${other.domain_name}` : ''}). `
    + 'This script will not move it. Either set TWILIO_SIP_HOSTNAME to that trunk\'s Termination URI, or detach the number in Twilio Console and run again.');
}

// 3. The IP Access Control List holding Agora's SIP source IPs.
const acls = await read('List IP Access Control Lists', () =>
  twilioList(`${API}/SIP/IpAccessControlLists.json?PageSize=1000`, 'ip_access_control_lists'));
let acl = acls.find((a) => a.friendly_name === ACL_NAME) ?? null;
if (!acl) {
  acl = await change(`Create IP Access Control List "${ACL_NAME}"`, () =>
    twilio(`${API}/SIP/IpAccessControlLists.json`, { method: 'POST', form: { FriendlyName: ACL_NAME } }));
}
const aclEntries = acl
  ? await read('List the IPs in the Access Control List', () =>
    twilioList(`${API}/SIP/IpAccessControlLists/${acl.sid}/IpAddresses.json?PageSize=1000`, 'ip_addresses'))
  : [];
const missingIps = group.ips.filter((ip) => !aclEntries.some((entry) => covers(entry, ip)));
if (missingIps.length) {
  await change(`Add ${missingIps.length} Agora IP${missingIps.length > 1 ? 's' : ''} to "${ACL_NAME}": ${missingIps.join(', ')}`, async () => {
    for (const ip of missingIps) {
      await twilio(`${API}/SIP/IpAccessControlLists/${acl.sid}/IpAddresses.json`, {
        method: 'POST',
        form: { FriendlyName: `Agora SIP ${ip}`, IpAddress: ip, CidrPrefixLength: '32' },
      });
    }
  });
} else {
  say('ok', `"${ACL_NAME}" (${acl.sid}) already allows all ${group.ips.length} Agora IPs`);
}

// 4. Trunk termination auth: the ACL.
const trunkAcls = trunk && acl
  ? await read('List the trunk\'s IP Access Control Lists', () =>
    twilioList(`${TRUNKING}/Trunks/${trunk.sid}/IpAccessControlLists?PageSize=100`, 'ip_access_control_lists'))
  : [];
if (trunk && acl && trunkAcls.some((a) => a.sid === acl.sid)) {
  say('ok', `"${ACL_NAME}" is attached to the trunk's termination`);
} else {
  await change(`Attach "${ACL_NAME}" to the trunk's termination`, () =>
    twilio(`${TRUNKING}/Trunks/${trunk.sid}/IpAccessControlLists`, { method: 'POST', form: { IpAccessControlListSid: acl.sid } }));
}

// 5. The phone number on the trunk.
if (trunk && twilioNumber.trunk_sid === trunk.sid) {
  say('ok', `${masked} is attached to the trunk`);
} else if (!ATTACH_NUMBER) {
  say('ok', `${masked} is left as it is: not attached to the trunk, inbound calls keep their current routing (pass --attach-number to change that)`);
} else {
  await change(`Attach ${masked} to the trunk (calls to this number will then be routed by the trunk, not by its voice webhook)`, () =>
    twilio(`${TRUNKING}/Trunks/${trunk.sid}/PhoneNumbers`, { method: 'POST', form: { PhoneNumberSid: twilioNumber.sid } }));
}

// 6. Optional credential list (username and password on top of the IP ACL).
const trunkCredLists = trunk
  ? await read('List the trunk\'s credential lists', () =>
    twilioList(`${TRUNKING}/Trunks/${trunk.sid}/CredentialLists?PageSize=100`, 'credential_lists'))
  : [];
if (useCreds) {
  const credLists = await read('List SIP credential lists', () =>
    twilioList(`${API}/SIP/CredentialLists.json?PageSize=1000`, 'credential_lists'));
  let credList = credLists.find((c) => c.friendly_name === CRED_LIST_NAME) ?? null;
  if (!credList) {
    credList = await change(`Create credential list "${CRED_LIST_NAME}"`, () =>
      twilio(`${API}/SIP/CredentialLists.json`, { method: 'POST', form: { FriendlyName: CRED_LIST_NAME } }));
  }
  const creds = credList
    ? await read('List the credentials in the credential list', () =>
      twilioList(`${API}/SIP/CredentialLists/${credList.sid}/Credentials.json?PageSize=1000`, 'credentials'))
    : [];
  if (creds.some((c) => c.username === env.sipUser)) {
    say('ok', `"${CRED_LIST_NAME}" already holds the username from TWILIO_SIP_USERNAME (its password cannot be read back and was left as is)`);
    manual.push('If calls fail with 403, the password stored in Twilio differs from TWILIO_SIP_PASSWORD: reset it under Elastic SIP Trunking > Credential Lists.');
  } else {
    const p = env.sipPass;
    if (p.length < 12 || !/[0-9]/.test(p) || !/[a-z]/.test(p) || !/[A-Z]/.test(p)) {
      die('Add the SIP credential', 'TWILIO_SIP_PASSWORD does not meet Twilio\'s rules: at least 12 characters, with a digit, a lowercase and an uppercase letter.');
    }
    await change(`Add the username from TWILIO_SIP_USERNAME (with its password) to "${CRED_LIST_NAME}"`, () =>
      twilio(`${API}/SIP/CredentialLists/${credList.sid}/Credentials.json`, { method: 'POST', form: { Username: env.sipUser, Password: env.sipPass } }));
  }
  if (trunk && credList && trunkCredLists.some((c) => c.sid === credList.sid)) {
    say('ok', `"${CRED_LIST_NAME}" is attached to the trunk's termination`);
  } else {
    await change(`Attach "${CRED_LIST_NAME}" to the trunk's termination`, () =>
      twilio(`${TRUNKING}/Trunks/${trunk.sid}/CredentialLists`, { method: 'POST', form: { CredentialListSid: credList.sid } }));
  }
} else if (trunkCredLists.length) {
  warn(`The trunk has ${trunkCredLists.length} credential list(s) attached but TWILIO_SIP_USERNAME / TWILIO_SIP_PASSWORD are empty. Twilio will ask Agora for a username and password and reject its calls.`);
  manual.push('Either set TWILIO_SIP_USERNAME and TWILIO_SIP_PASSWORD in .env and run again, or detach the credential list from the trunk in Twilio Console (Trunk > Termination > Authentication).');
} else {
  say('ok', 'No SIP username/password configured: the trunk authenticates Agora by IP only');
}

// 7. Advisory reads. These never change anything and never stop the script.
if (trial) {
  warn('This is a Twilio trial account: it can only call phone numbers you have verified in Twilio.');
  manual.push('Trial account: verify each number you want to call (Twilio Console > Phone Numbers > Verified Caller IDs), or upgrade the account.');
}
try {
  const india = await twilio(`${VOICE}/DialingPermissions/Countries/IN`);
  if (india.low_risk_numbers_enabled) {
    say('ok', 'Voice dialing permission for India (IN) is enabled');
  } else {
    warn('Voice dialing permission for India (IN) is NOT enabled: calls to +91 numbers will be blocked by Twilio.');
    manual.push('Enable India under Twilio Console > Voice > Settings > Geo permissions.');
  }
} catch (err) {
  warn(`Could not read the voice dialing permission for India: ${describeError(err)}`);
  manual.push('Check that India is enabled under Twilio Console > Voice > Settings > Geo permissions.');
}

heading('Agora');

const sipTrunk = {
  name: 'twilio',
  hostname: agoraHost,
  transport,
  ...(useCreds ? { auth: { username: env.sipUser, password: env.sipPass } } : {}),
};
const sameNumber = (n) => String(n ?? '').replace(/[^\d+]/g, '') === number;
const imported = await read('List the phone numbers in the Agora project', () => listNumbers());
const existing = imported.find((n) => sameNumber(n.number));
let numberId = existing?.number_id ?? null;

if (!existing) {
  const created = await change(`Import ${masked} into the Agora project: SIP trunk ${agoraHost} over ${transport}${useCreds ? ' with username/password' : ''}, outbound only`, () =>
    agoraWrite('/numbers', { method: 'POST', body: { number, description: NUMBER_DESCRIPTION, sip_trunk: sipTrunk } }));
  numberId = created?.number_id ?? null;
} else {
  const current = existing.sip_trunk ?? {};
  const diffs = [];
  if ((current.hostname ?? '').toLowerCase() !== agoraHost) diffs.push(`hostname ${current.hostname ?? '(none)'} -> ${agoraHost}`);
  if ((current.transport ?? '').toLowerCase() !== transport) diffs.push(`transport ${current.transport ?? '(none)'} -> ${transport}`);
  // Agora never returns sip_trunk.auth, so it cannot be compared: re-send it on every --apply.
  if (!diffs.length && useCreds) diffs.push('re-send the SIP username/password (Agora never returns them, so they cannot be compared)');
  if (diffs.length) {
    // sip_trunk is replaced as a whole: keep the saved name and allowed_ips, port follows the transport.
    const body = {
      sip_trunk: {
        ...sipTrunk,
        name: current.name ?? sipTrunk.name,
        ...(current.allowed_ips?.length ? { allowed_ips: current.allowed_ips } : {}),
      },
    };
    await change(`Update the Agora number ${masked}: ${diffs.join(', ')}`, async () => {
      const etag = await numberEtag(existing.number_id);
      return agoraWrite(`/numbers/${existing.number_id}`, { method: 'PATCH', headers: { 'If-Match': etag }, body });
    });
  } else {
    say('ok', `${masked} is already imported with ${agoraHost} over ${transport}`);
  }
}
console.log(`  number_id: ${numberId ?? '(assigned when the number is imported with --apply)'}`);

// ---------- summary ----------

if (!givenHost) manual.unshift(`Add this line to .env: TWILIO_SIP_HOSTNAME=${agoraHost}`);
manual.push('Inbound calls are not set up: the trunk has no Origination URI and the Agora number has no inbound agent, so calls to this number are rejected.');

if (!APPLY) {
  heading(changes
    ? `Read-only run: ${changes} change${changes > 1 ? 's' : ''} planned (the "plan" lines above). Nothing was changed.`
    : 'Read-only run: everything is already in place. Nothing to change.');
  if (changes) console.log('Run `node scripts/setup-phone.mjs --apply` to perform them.');
} else {
  heading(`Done${changes ? `: ${changes} change${changes > 1 ? 's' : ''} made` : ': nothing needed changing'}. What is now true:`);
  const facts = [
    ATTACH_NUMBER || twilioNumber.trunk_sid === trunk.sid
      ? `${masked} belongs to the Twilio account and is attached to trunk "${trunk.friendly_name}" (${trunk.sid})`
      : `${masked} belongs to the Twilio account and is used as caller ID only; its inbound routing was not touched`,
    `The trunk's Termination URI is ${trunkDomain} with ${secureLabel}`,
    `IP Access Control List "${ACL_NAME}" allows the ${group.ips.length} Agora SIP IPs and is attached to the trunk`,
    useCreds ? `Credential list "${CRED_LIST_NAME}" is attached to the trunk and the same username/password was given to Agora` : 'No SIP username/password is used (IP whitelist only)',
    `Agora has the number imported as number_id ${numberId}, dialing ${agoraHost} over ${transport}`,
  ];
  for (const fact of facts) console.log(`  [x] ${fact}`);
}

if (warnings.length) {
  heading('Warnings');
  for (const w of warnings) console.log(`  ! ${w}`);
}
heading(APPLY ? 'Still to do by hand' : 'To do by hand (now or after --apply)');
for (const item of manual) console.log(`  [ ] ${item}`);
