// The websites built during calls: one draft per call, designed live, revised by voice,
// then published. Everything a preview page needs to follow along is emitted as events.
//
//   designing -> ready -> (revising -> ready)* -> published
//
// Two ways a page gets made:
//   - Claude designs the whole document and streams it (site-designer.mjs), when a key is set.
//   - Otherwise a fast writer fills a built-in template (site-content.mjs + site-template.mjs).
// The template version is also the safety net if Claude fails mid-call.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { env } from './env.mjs';
import { writeContent, contentFromBrief } from './site-content.mjs';
import { renderSite, renderPending } from './site-template.mjs';
import { withKit, photoLibrary } from './site-kit.mjs';
import { generateImage } from './site-images.mjs';

const RESERVED = new Set(['www', 'console', 'api', 'app', 'admin', 'preview', 'launchpad', 'tools', 'internal', 'mail', 'static']);

/** slug -> site */
const sites = new Map();
/** call ref -> slug */
const byRef = new Map();

let designer = null; // loaded on first use so the app still runs if the module is missing
const loadDesigner = async () => {
  if (designer === null) designer = await import('./site-designer.mjs').catch((err) => { console.warn(`designer unavailable: ${err.message}`); return false; });
  return designer && designer.designerReady() ? designer : null;
};

// ------------------------------------------------------------- addresses ----

// Sites live at <slug>.<PUBLIC_HOST>, with the scheme and port of PUBLIC_URL (so local
// development works with PUBLIC_HOST=localhost and PUBLIC_URL=http://localhost:3311).
const origin = (() => { try { const u = new URL(env.publicUrl); return { scheme: u.protocol, port: u.port ? `:${u.port}` : '' }; } catch { return { scheme: 'https:', port: '' }; } })();
export const siteHost = (slug) => (env.publicHost ? `${slug}.${env.publicHost}` : null);
export const siteUrl = (slug) => (env.publicHost ? `${origin.scheme}//${slug}.${env.publicHost}${origin.port}` : `${env.publicUrl}/s/${slug}`);
export const adminUrl = (site) => `${siteUrl(site.slug)}/admin?claim=${site.claimToken}`;
export const previewUrl = (slug) => `${siteUrl(slug)}/preview`;
/** How to say the address aloud on a phone call. */
export const spokenAddress = (slug) => (env.publicHost ? `${slug}.${env.publicHost}` : `${env.publicUrl.replace(/^https?:\/\//, '')}/s/${slug}`)
  .replace(/-/g, ' dash ').replace(/\./g, ' dot ').replace(/\//g, ' slash ');

const slugify = (name) => String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28).replace(/-+$/, '');

const dirOf = (slug) => join(env.sitesDir, slug);
const taken = (slug) => RESERVED.has(slug) || sites.has(slug) || existsSync(dirOf(slug));

const freeSlug = (name) => {
  const base = slugify(name) || 'site';
  const start = base.length < 3 ? `${base}-site` : base;
  if (!taken(start)) return start;
  for (let n = 2; n < 500; n++) if (!taken(`${start}-${n}`)) return `${start}-${n}`;
  return `${start}-${Date.now().toString(36)}`;
};

// ------------------------------------------------------------ persistence ----

const persist = async (site) => {
  await mkdir(dirOf(site.slug), { recursive: true });
  const { bus, partial, html, publishedHtml, ...meta } = site;
  await Promise.all([
    writeFile(join(dirOf(site.slug), 'site.json'), JSON.stringify(meta, null, 2)),
    html ? writeFile(join(dirOf(site.slug), 'draft.html'), html) : null,
    publishedHtml ? writeFile(join(dirOf(site.slug), 'index.html'), publishedHtml) : null,
  ]);
};

/** A site by slug, from memory or from disk (so published pages survive a restart). */
export const getSite = async (slug) => {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug ?? '')) return null;
  if (sites.has(slug)) return sites.get(slug);
  const dir = dirOf(slug);
  if (!existsSync(join(dir, 'site.json'))) return null;
  try {
    const meta = JSON.parse(await readFile(join(dir, 'site.json'), 'utf8'));
    const read = (f) => (existsSync(join(dir, f)) ? readFile(join(dir, f), 'utf8') : null);
    const site = { ...meta, html: await read('draft.html'), publishedHtml: await read('index.html'), partial: '', bus: new EventEmitter() };
    // A draft that was mid-build when the server stopped cannot resume.
    if (site.status === 'designing' || site.status === 'revising') site.status = site.html ? 'ready' : 'failed';
    site.bus.setMaxListeners(100);
    sites.set(slug, site);
    return site;
  } catch {
    return null;
  }
};

export const siteForRef = (ref) => (byRef.has(ref) ? sites.get(byRef.get(ref)) : null);
/**
 * Every site, oldest first. Sites saved on disk are loaded first, so the console's list is
 * complete after a restart instead of showing only the sites touched since.
 */
export const listSites = async () => {
  let names = [];
  try { names = await readdir(env.sitesDir); } catch { /* no sites folder yet */ }
  await Promise.all(names.filter((n) => !sites.has(n)).map((n) => getSite(n)));
  return [...sites.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)).map(publicView);
};

export const publicView = (site) => site && ({
  slug: site.slug, name: site.name, status: site.status, lang: site.lang, madeBy: site.madeBy,
  version: site.version, previewUrl: previewUrl(site.slug), url: site.publishedAt ? siteUrl(site.slug) : null, unpublishedChanges: Boolean(site.dirty),
  sections: site.sections ?? [], step: site.step ?? null, error: site.error ?? null,
});

// ----------------------------------------------------------------- events ----

const emit = (site, type, data = {}) => site.bus.emit('event', { type, ...data, status: site.status, version: site.version });

const setStatus = (site, status, extra = {}) => {
  Object.assign(site, { status, ...extra });
  emit(site, 'state', { step: site.step ?? null });
};

/** Subscribe a preview page. Returns an unsubscribe function. */
export const follow = (site, onEvent) => {
  site.bus.on('event', onEvent);
  return () => site.bus.off('event', onEvent);
};

// ----------------------------------------------------------------- build ----

const cleanLang = (lang) => (/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(String(lang ?? '').trim()) ? String(lang).trim() : 'en');

const withTemplate = async (site, { change } = {}) => {
  const out = await writeContent({ brief: site.brief, current: change ? site.content : undefined, change });
  site.content = out.site;
  site.madeBy = out.writer === 'none' ? 'template (caller\'s own words)' : `template + ${out.writer}`;
  if (out.errors.length) console.warn(`site ${site.slug} writer notes: ${out.errors.join(' | ')}`);
  return renderSite(out.site, { url: siteUrl(site.slug), builtAt: new Date() });
};

const finish = async (site, html, sections) => {
  site.html = html;
  site.partial = '';
  site.version += 1;
  site.sections = sections ?? site.sections ?? [];
  site.step = null;
  setStatus(site, 'ready');
  emit(site, 'reload');
  await persist(site).catch((err) => console.warn(`persist ${site.slug}: ${err.message}`));
};

const design = async (site) => {
  const started = Date.now();
  try {
    const d = await loadDesigner();
    if (d) {
      site.madeBy = `Claude (${env.anthropicModel})`;
      const out = await d.designSite({
        brief: site.brief,
        lang: site.lang,
        onStep: (label) => { site.step = label; emit(site, 'step', { step: label }); },
        onHtml: (text) => { site.partial += text; emit(site, 'chunk', { text }); },
        signal: AbortSignal.timeout(170_000),
      });
      await finish(site, withKit(d.sanitiseHtml(out.html)), out.sections ?? d.describeSite(out.html).sections);
      console.log(`site ${site.slug} designed by Claude in ${Date.now() - started} ms`);
      return;
    }
  } catch (err) {
    console.warn(`site ${site.slug}: Claude design failed (${err.message}); using the template`);
    site.partial = '';
    emit(site, 'reset');
  }
  try {
    const html = await withTemplate(site);
    await finish(site, html, (site.content.highlights ?? []).map((h) => h.title));
    console.log(`site ${site.slug} built from the template in ${Date.now() - started} ms (${site.madeBy})`);
  } catch (err) {
    // Last resort: the caller's own words, no model at all.
    try {
      site.content = contentFromBrief(site.brief);
      site.madeBy = 'template (caller\'s own words)';
      await finish(site, renderSite(site.content, { url: siteUrl(site.slug), builtAt: new Date() }), []);
    } catch (err2) {
      setStatus(site, 'failed', { error: `${err.message}; ${err2.message}`.slice(0, 300) });
    }
  }
};

/** Start a draft for a call. Returns at once; the design continues in the background. */
export const startSite = async ({ ref, brief, lang, to }) => {
  const existing = siteForRef(ref);
  if (existing) return existing; // the agent called the tool twice: keep the one draft
  const slug = freeSlug(brief.business_name);
  const site = {
    slug, ref, to: to ?? null, brief, lang: cleanLang(lang), name: String(brief.business_name ?? '').slice(0, 80) || 'Your page',
    status: 'collecting', version: 1, html: null, partial: '', publishedHtml: null, content: null, sections: [], step: null,
    madeBy: null, createdAt: Date.now(), publishedAt: null, error: null, bus: new EventEmitter(),
    // Whoever holds this token may claim the admin panel (it is texted to the owner).
    claimToken: randomBytes(18).toString('base64url'), ownerEmail: null,
  };
  site.bus.setMaxListeners(100);
  sites.set(slug, site);
  byRef.set(ref, slug);
  // The link goes out the moment we know the name, so there is a page to look at straight away:
  // a simple one built from what is known, which grows as the conversation adds details.
  site.html = sketch(site);
  await persist(site).catch(() => {});
  // A new subdomain gets its HTTPS certificate on first request, which takes a few seconds.
  // Ask for the page ourselves now, so that wait is over before the owner opens the link.
  if (env.publicHost && env.publicUrl.startsWith('https://')) fetch(`${siteUrl(slug)}/preview`, { signal: AbortSignal.timeout(40_000) }).catch(() => {});
  return site;
};

/** The simple page shown while details are still being collected: the caller's own words, laid out. */
const sketch = (site) => {
  site.content = contentFromBrief(site.brief);
  return renderSite(site.content, { url: siteUrl(site.slug), builtAt: new Date() });
};

const DETAIL_FIELDS = ['what_they_do', 'audience', 'highlights', 'contact', 'style'];
const known = (v) => { const t = String(v ?? '').trim(); return t && !/^(not given|none|n\/a|unknown|skip)$/i.test(t) ? t : ''; };

/** Enough to design a real page: what they do, plus at least two of audience, highlights, contact, style. */
export const enoughToDesign = (brief) => Boolean(known(brief.what_they_do)) && ['audience', 'highlights', 'contact', 'style'].filter((k) => known(brief[k])).length >= 2;

const startDesign = (site) => {
  site.status = 'designing';
  site.step = null;
  emit(site, 'state', { step: null });
  site.work = design(site)
    .then(async () => {
      // Details that arrived while the page was being designed are worked in straight after.
      const late = site.lateDetails; site.lateDetails = null;
      if (late && site.html) await changeSite(site, `The owner gave these further details during the call. Work them into the page where they belong: ${late}`);
    })
    .catch((err) => setStatus(site, 'failed', { error: err.message }));
};

/**
 * Add what the caller has just said. While details are being collected the simple page updates
 * at once; when there is enough, the full design starts by itself; after that, new details are
 * worked into the designed page. Resolves to { stage, started, missing }.
 */
export const addDetails = async (site, details = {}) => {
  const fresh = [];
  for (const key of DETAIL_FIELDS) {
    const value = known(details[key]).slice(0, 600);
    if (value && value !== site.brief[key]) { site.brief[key] = value; fresh.push(`${key.replace(/_/g, ' ')}: ${value}`); }
  }
  const missing = DETAIL_FIELDS.filter((k) => !known(site.brief[k])).map((k) => k.replace(/_/g, ' '));
  if (site.status === 'collecting') {
    if (fresh.length) { site.html = sketch(site); site.version += 1; emit(site, 'reload'); }
    if (enoughToDesign(site.brief)) { startDesign(site); await persist(site).catch(() => {}); return { stage: 'designing', started: true, missing }; }
    await persist(site).catch(() => {});
    return { stage: 'collecting', started: false, missing };
  }
  if (!fresh.length) return { stage: site.status, started: false, missing };
  if (site.status === 'designing' || site.status === 'revising') {
    site.lateDetails = [site.lateDetails, fresh.join('; ')].filter(Boolean).join('; ');
    return { stage: site.status, started: false, missing, queued: true };
  }
  const out = await changeSite(site, `The owner gave these further details. Work them into the page where they belong: ${fresh.join('; ')}`);
  return { stage: site.status, started: false, missing, applied: out.ok };
};

/** Start the full design now, even if few details are known (the owner asked to see it). */
export const designNow = (site) => { if (site.status === 'collecting') { startDesign(site); return true; } return false; };

/** Resolve when the site leaves `designing` / `revising`, or after `ms`. */
export const settled = (site, ms) => new Promise((resolve) => {
  const busy = () => site.status === 'designing' || site.status === 'revising';
  if (!busy()) return resolve(site);
  const timer = setTimeout(() => { off(); resolve(site); }, ms);
  const off = follow(site, () => { if (!busy()) { clearTimeout(timer); off(); resolve(site); } });
  return undefined;
});

/** Apply a spoken change request. Resolves to { ok, summary }. */
export const changeSite = async (site, change) => {
  if (site.status === 'designing' || site.status === 'revising') await settled(site, 45_000);
  if (!site.html) return { ok: false, summary: 'The page is not ready yet.' };
  const request = String(change ?? '').trim().slice(0, 600);
  if (!request) return { ok: false, summary: 'No change was described.' };
  const before = site.status;
  site.step = request;
  setStatus(site, 'revising');
  emit(site, 'working', { label: request });
  try {
    const d = await loadDesigner();
    let summary;
    if (d && site.madeBy?.startsWith('Claude')) {
      const out = await d.reviseSite({ html: site.html, change: request, lang: site.lang, onStep: (label) => emit(site, 'step', { step: label }), signal: AbortSignal.timeout(120_000) });
      summary = out.summary;
      await finish(site, withKit(d.sanitiseHtml(out.html)), d.describeSite(out.html).sections);
    } else {
      const html = await withTemplate(site, { change: request });
      summary = 'The page has been updated.';
      await finish(site, html, (site.content.highlights ?? []).map((h) => h.title));
    }
    if (before === 'published') site.dirty = true; // the public copy is now behind the draft
    return { ok: true, summary: summary || 'The page has been updated.' };
  } catch (err) {
    console.warn(`site ${site.slug}: change failed: ${err.message}`);
    site.step = null;
    setStatus(site, 'ready');
    emit(site, 'failed', { label: request });
    return { ok: false, summary: 'That change could not be applied.' };
  }
};

/** Freeze the current draft as the public page. */
export const publishSite = async (site) => {
  if (site.status === 'designing' || site.status === 'revising') await settled(site, 45_000);
  if (!site.html) return { ok: false };
  site.publishedHtml = site.html;
  site.publishedAt = Date.now();
  site.dirty = false;
  setStatus(site, 'published');
  emit(site, 'published', { url: siteUrl(site.slug) });
  await persist(site);
  console.log(`site ${site.slug} published at ${siteUrl(site.slug)}`);
  return { ok: true, url: siteUrl(site.slug) };
};

export { renderPending };

export const saveSite = (site) => persist(site);
export const siteDir = (slug) => dirOf(slug);

/** Tie another conversation (a follow-up call) to an existing site so its tools act on it. */
export const attachRef = (ref, slug) => byRef.set(ref, slug);

/** Published sites, newest first, read from disk so the list survives restarts. */
export const publishedSites = async (limit = 6) => {
  let names = [];
  try { names = await readdir(env.sitesDir); } catch { return []; }
  const found = [];
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) continue;
    try {
      const meta = JSON.parse(await readFile(join(env.sitesDir, name, 'site.json'), 'utf8'));
      if (meta.publishedAt) found.push({ name: meta.name, url: siteUrl(meta.slug), at: meta.publishedAt });
    } catch { /* not a site folder */ }
  }
  return found.sort((a, b) => b.at - a.at).slice(0, limit).map(({ name, url }) => ({ name, url }));
};

// ------------------------------------------------------------ photo swap ----
// "That picture does not look good, change it" must be instant, so it is done here by
// replacing the image address directly instead of asking the designer to rework the page.

const photoId = (src) => (String(src).match(/photo-[0-9a-f-]+/) ?? String(src).match(/\/_lp\/photos\/[^?"]+/) ?? [''])[0];
const words = (text) => new Set(String(text ?? '').toLowerCase().match(/[a-z]{3,}/g) ?? []);

/** Every <img> in the page with the section it sits in. */
const imagesIn = (html) => {
  const markers = [...html.matchAll(/<!--\s*section:\s*(.*?)\s*-->/gi)].map((m) => ({ at: m.index, label: m[1] }));
  return [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => {
    const tag = m[0];
    const src = (tag.match(/\ssrc="([^"]*)"/i) ?? [])[1] ?? '';
    const alt = (tag.match(/\salt="([^"]*)"/i) ?? [])[1] ?? '';
    const section = markers.filter((k) => k.at < m.index).pop()?.label ?? '';
    return { at: m.index, tag, src, alt, section };
  }).filter((i) => i.src);
};

/**
 * Replace one photograph with a different one from the library.
 * `which` says which picture (a section name, what it shows, or "top"); `wish` what they would like.
 * Resolves to { ok, summary }.
 */
export const swapPhoto = async (site, { which, wish } = {}) => {
  if (site.status === 'designing' || site.status === 'revising') await settled(site, 45_000);
  if (!site.html) return { ok: false, summary: 'The page is not ready yet.' };
  const images = imagesIn(site.html);
  if (!images.length) return { ok: false, summary: 'There are no photographs on the page to change.' };

  // Which picture do they mean?
  const asked = String(which ?? '').toLowerCase();
  const askedWords = words(asked);
  const score = (img) => [...words(`${img.section} ${img.alt}`)].filter((w) => askedWords.has(w)).length;
  let target = images.map((img) => ({ img, n: score(img) })).sort((a, b) => b.n - a.n)[0];
  target = target.n > 0 ? target.img : (/last|bottom|end/.test(asked) ? images[images.length - 1] : images[0]);

  // What can replace it? Same kind of business first, never one already on the page.
  const library = photoLibrary();
  const used = new Set(images.map((i) => photoId(i.src)));
  const home = library.find((c) => c.photos.some((p) => photoId(p.src) === photoId(target.src)));
  const pool = [...(home ? home.photos : []), ...library.filter((c) => c !== home).flatMap((c) => c.photos)].filter((p) => !used.has(photoId(p.src)));
  const sameKind = home ? pool.filter((p) => home.photos.includes(p)) : [];
  const wishWords = words(wish);
  const fits = (list) => list.map((p) => ({ p, n: [...words(p.alt)].filter((w) => wishWords.has(w)).length })).sort((a, b) => b.n - a.n);
  const best = fits(pool)[0];
  const choice = (wishWords.size && best?.n > 0 ? best.p : null) ?? sameKind[0] ?? null;
  if (!choice) return { ok: false, summary: 'There is no other suitable photograph in the library for that spot.' };

  // Keep the crop of the picture being replaced, so the layout does not shift.
  let src = choice.src;
  const size = target.src.match(/[?&]w=(\d+)&h=(\d+)/);
  if (size && /images\.unsplash\.com/.test(src)) src = src.replace(/([?&])w=\d+&h=\d+/, `$1w=${size[1]}&h=${size[2]}`);
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  let tag = target.tag.replace(/\ssrc="[^"]*"/i, ` src="${esc(src)}"`);
  tag = /\salt="[^"]*"/i.test(tag) ? tag.replace(/\salt="[^"]*"/i, ` alt="${esc(choice.alt)}"`) : tag.replace(/<img/i, `<img alt="${esc(choice.alt)}"`);
  tag = tag.replace(/\ssrcset="[^"]*"/i, '');
  const html = site.html.slice(0, target.at) + tag + site.html.slice(target.at + target.tag.length);

  const wasPublished = site.status === 'published';
  site.html = html;
  site.version += 1;
  if (wasPublished || site.publishedAt) site.dirty = true;
  setStatus(site, 'ready');
  emit(site, 'reload');
  await persist(site).catch((err) => console.warn(`persist ${site.slug}: ${err.message}`));
  return { ok: true, summary: `The picture in the ${target.section || 'page'} section now shows: ${choice.alt}`, remaining: Math.max(0, sameKind.length - 1) };
};

/**
 * After a restart the in-memory link between a conversation and its site is gone.
 * Find the site that was started under this ref (it is stored with the site) and restore the link.
 */
export const recoverRef = async (ref) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(ref ?? ''))) return null;
  if (byRef.has(ref)) return sites.get(byRef.get(ref)) ?? null;
  let names = [];
  try { names = await readdir(env.sitesDir); } catch { return null; }
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) continue;
    try {
      const meta = JSON.parse(await readFile(join(env.sitesDir, name, 'site.json'), 'utf8'));
      if (meta.ref === ref) { const site = await getSite(meta.slug); if (site) byRef.set(ref, site.slug); return site; }
    } catch { /* not a site folder */ }
  }
  return null;
};

/**
 * Put a picture on the page: a new one made to the caller's description (or a library
 * photograph when one matches). Replaces the picture in the named section when there is one;
 * otherwise the designer adds it to that section.
 * Resolves to { ok, summary }.
 */
export const setImage = async (site, { which, wish } = {}) => {
  if (site.status === 'designing' || site.status === 'revising') await settled(site, 60_000);
  if (!site.html || site.status === 'collecting') return { ok: false, summary: 'The page has not been designed yet, so there is nowhere to put a picture.' };
  const where = String(which ?? '').trim() || 'top';
  const want = String(wish ?? '').trim();

  // 1. Make the picture they described (or one that fits the business when they did not say).
  //    The photo library is only the fallback for when no generator answers.
  const subject = want || `${site.brief.what_they_do || site.name}`;
  let picture = null;
  try {
    picture = await generateImage({ dir: dirOf(site.slug), subject });
  } catch (err) {
    console.warn(`site ${site.slug}: picture could not be made: ${err.message}`);
    const used = new Set(imagesIn(site.html).map((i) => photoId(i.src)));
    const STOP = new Set(['and', 'the', 'with', 'for', 'from', 'that', 'this', 'some', 'show', 'showing', 'picture', 'photo', 'image', 'machine', 'shop', 'store']);
    const wishWords = new Set([...words(subject)].filter((w) => !STOP.has(w)));
    const best = photoLibrary().flatMap((c) => c.photos).filter((p) => !used.has(photoId(p.src)))
      .map((p) => ({ p, n: [...words(p.alt)].filter((w) => wishWords.has(w)).length })).sort((x, y) => y.n - x.n)[0];
    if (best && best.n >= 2) picture = { src: best.p.src, alt: best.p.alt, by: 'photo library', width: 1200, height: 800 };
  }
  if (!picture) {
    // No photograph could be had: have the designer draw the subject instead, which always works.
    const out = await changeSite(site, `In the "${where}" section (if no section has that name, the one that best matches; "top" or "main" means the Hero), add a drawn illustration of: ${subject}. Draw it as one inline SVG made of simple shapes in the page's own colours, large enough to be the visual of that section (replace the section's existing picture or illustration if it has one), with aria-hidden="true" and data-reveal on its wrapper. Do not remove any text.`);
    return out.ok
      ? { ok: true, summary: `I drew an illustration of ${subject.toLowerCase()} in the ${where} section. A photograph could not be made at this moment.`, by: 'illustration' }
      : { ok: false, summary: 'A new picture could not be made just now.' };
  }

  // 2. Place it. A section that already has a picture gets it swapped in place, instantly.
  const images = imagesIn(site.html);
  const asked = words(where);
  const target = images.map((img) => ({ img, n: [...words(`${img.section} ${img.alt}`)].filter((w) => asked.has(w)).length })).sort((a, b) => b.n - a.n)[0];
  const direct = target && (target.n > 0 || (/^(top|first|main|hero)$/i.test(where) && images.length)) ? (target.n > 0 ? target.img : images[0]) : null;
  if (direct) {
    const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    let tag = direct.tag.replace(/\ssrc="[^"]*"/i, ` src="${esc(picture.src)}"`).replace(/\ssrcset="[^"]*"/i, '');
    tag = /\salt="[^"]*"/i.test(tag) ? tag.replace(/\salt="[^"]*"/i, ` alt="${esc(picture.alt)}"`) : tag.replace(/<img/i, `<img alt="${esc(picture.alt)}"`);
    site.html = site.html.slice(0, direct.at) + tag + site.html.slice(direct.at + direct.tag.length);
    site.version += 1;
    if (site.publishedAt) site.dirty = true;
    setStatus(site, 'ready');
    emit(site, 'reload');
    await persist(site).catch(() => {});
    return { ok: true, summary: `The picture in the ${direct.section || 'page'} section now shows ${picture.alt.toLowerCase()}.`, by: picture.by };
  }
  const out = await changeSite(site, `Add a photograph to the "${where}" section (if no section has that name, use the section that best matches, and "top" or "main" means the Hero). Use exactly this image address: ${picture.src} with this alt text: "${picture.alt}". Add it as an <img class="lp-photo" width="${picture.width}" height="${picture.height}" loading="lazy"> inside a rounded wrapper with a fitting aspect ratio, placed and sized so the section looks designed around it on a phone and on desktop, with data-reveal on the wrapper. Do not remove anything else.`);
  return out.ok ? { ok: true, summary: `I added a picture of ${picture.alt.toLowerCase()} to the ${where} section.`, by: picture.by } : { ok: false, summary: 'The picture was made but could not be placed on the page.' };
};
