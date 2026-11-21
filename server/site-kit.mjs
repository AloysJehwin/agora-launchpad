// The pre-built part of every generated website: behaviour that is the same on all of them and
// must never go wrong. The designer (Claude) decides the look and writes the sections; this kit
// supplies the motion and header behaviour, added by the server after the page is written, so a
// page can never be left with hidden or half-revealed content.
//
// Contract with the designer:
//   [data-reveal]  on a block  -> rises in gently the first time it scrolls into view
//   [data-header]  on <header> -> gets class "is-scrolled" once the page has scrolled
//   .lp-photo      on an <img> -> fades in when loaded, with a tinted placeholder until then
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './env.mjs';

const MARK = 'data-lp-kit';

const KIT_CSS = `
/* Launchpad kit: safe reveal, header state, photos */
html { scroll-behavior: smooth; -webkit-text-size-adjust: 100%; }
body { overflow-x: clip; }
img { max-width: 100%; height: auto; }
.lp-js [data-reveal] { transition: opacity .55s ease, transform .55s cubic-bezier(.2,.7,.2,1); will-change: opacity, transform; }
.lp-js [data-reveal]:not(.lp-in) { opacity: 0; transform: translateY(14px); }
.lp-photo { background: rgb(0 0 0 / .06); object-fit: cover; display: block; width: 100%; }
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .lp-js [data-reveal], .lp-js [data-reveal]:not(.lp-in) { opacity: 1; transform: none; transition: none; }
}`;

const KIT_JS = `
(() => {
  const root = document.documentElement;
  const items = [...document.querySelectorAll('[data-reveal]')];
  const show = (el) => el.classList.add('lp-in');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still || !('IntersectionObserver' in window)) items.forEach(show);
  else {
    // Whatever is already on screen stays visible; only content further down waits for its turn.
    const vh = innerHeight;
    items.forEach((el) => { if (el.getBoundingClientRect().top < vh * 0.92) show(el); });
    root.classList.add('lp-js');
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { show(e.target); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.05 });
    items.forEach((el, i) => { if (!el.classList.contains('lp-in')) { el.style.transitionDelay = (i % 3) * 70 + 'ms'; io.observe(el); } });
    // Safety net: nothing may stay hidden, whatever the browser does with observers.
    setTimeout(() => items.forEach(show), 4000);
    addEventListener('pagehide', () => items.forEach(show));
  }
  // A photograph that fails to load must not leave a broken-image icon.
  document.querySelectorAll('img').forEach((img) => img.addEventListener('error', () => { img.style.visibility = 'hidden'; }, { once: true }));
  const header = document.querySelector('[data-header]');
  if (header) {
    const mark = () => header.classList.toggle('is-scrolled', scrollY > 12);
    mark(); addEventListener('scroll', mark, { passive: true });
  }
})();`;

/** Add the kit to a finished page (once). Safe to call on a page that already has it. */
export const withKit = (html) => {
  if (!html || html.includes(MARK)) return html;
  const css = `<style ${MARK}>${KIT_CSS}\n</style>`;
  const js = `<script ${MARK}>${KIT_JS}\n</script>`;
  let out = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${css}\n</head>`) : `${css}\n${html}`;
  out = /<\/body>(?![\s\S]*<\/body>)/i.test(out) ? out.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${js}\n</body>`) : `${out}\n${js}`;
  return out;
};

// ------------------------------------------------------------ photo library ----

const PHOTO_DIR = join(root, 'site-kit', 'photos');
let library = null;

/** The curated photographs pages may use, or [] when the library has not been built. */
export const photoLibrary = () => {
  if (library) return library;
  try {
    const manifest = JSON.parse(readFileSync(join(PHOTO_DIR, 'manifest.json'), 'utf8'));
    library = (manifest.categories ?? []).map((c) => ({
      key: c.key, label: c.label, keywords: c.keywords ?? [],
      photos: (c.photos ?? []).map((p) => {
        // A library photo is either a file in this folder or a free-licence photograph served
        // by Unsplash's image server, cropped to the stated ratio.
        if (p.url && /^https:\/\/images\.unsplash\.com\/photo-[0-9a-f-]+$/.test(p.url)) {
          const [w, h] = p.ratio === '3:2' ? [1600, 1067] : [1000, 750];
          return { src: `${p.url}?auto=format&fit=crop&w=${w}&h=${h}&q=72`, ratio: p.ratio, alt: p.alt };
        }
        return p.file && existsSync(join(PHOTO_DIR, c.key, p.file)) ? { src: `/_lp/photos/${c.key}/${p.file}`, ratio: p.ratio, alt: p.alt } : null;
      }).filter(Boolean),
    })).filter((c) => c.photos.length);
  } catch {
    library = [];
  }
  return library;
};

/** The library as text for the designer's brief. */
export const photoBrief = () => {
  const cats = photoLibrary();
  if (!cats.length) return '';
  return cats.map((c) => `${c.label}:\n${c.photos.map((p) => `  ${p.src}  (${p.ratio})  ${p.alt}`).join('\n')}`).join('\n');
};

export const photoFile = (category, file) => {
  if (!/^[a-z0-9-]+$/.test(category) || !/^[a-z0-9-]+\.jpg$/.test(file)) return null;
  const path = join(PHOTO_DIR, category, file);
  return existsSync(path) ? path : null;
};
