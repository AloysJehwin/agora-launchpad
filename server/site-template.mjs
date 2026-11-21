// site-template.mjs
// Turns the small JSON object a language model extracts from a phone call into
// a finished, self-contained one-page website. Pure string templating, no deps.
//
// Trust model: every field of `site` is untrusted caller text. It is only ever
// emitted through esc() into element content or double-quoted attributes. It is
// never placed in <style>, never in a URL, and links (tel:, mailto:, wa.me) are
// rebuilt from validated characters only. All CSS comes from constants below.

// ---------------------------------------------------------------------------
// Themes: colour only. Each has its own page colours plus a "hero" pairing for
// the poster block at the top and a "pop" pairing for the button on that block.
// ---------------------------------------------------------------------------

export const PALETTES = {
  garden: {
    bg: '#EAF0DF', surface: '#F8FBF1', text: '#1F2A1C', muted: '#525F4C',
    accent: '#2F5D3A', accentContrast: '#FFFFFF',
    hero: '#234A2E', heroText: '#F2F6E8', pop: '#F2C14E', popText: '#1F2A1C',
  },
  terracotta: {
    bg: '#F7E6D2', surface: '#FFF7EC', text: '#2B1A12', muted: '#644B3D',
    accent: '#A63D17', accentContrast: '#FFFFFF',
    hero: '#963510', heroText: '#FFF6EA', pop: '#FFE2B0', popText: '#3A1D0E',
  },
  harbour: {
    bg: '#EEF3F7', surface: '#FFFFFF', text: '#10202E', muted: '#4C5F70',
    accent: '#0F5C8C', accentContrast: '#FFFFFF',
    hero: '#0E2A44', heroText: '#EAF2F8', pop: '#7FD6C2', popText: '#0B2233',
  },
  blossom: {
    bg: '#FBF0EF', surface: '#FFFAF9', text: '#2E1420', muted: '#70525E',
    accent: '#A3264F', accentContrast: '#FFFFFF',
    hero: '#F5C6CE', heroText: '#3B0F22', pop: '#8E1F45', popText: '#FFFFFF',
  },
  sunshine: {
    bg: '#FFF1BF', surface: '#FFFAE6', text: '#1C1A12', muted: '#5A5338',
    accent: '#B93A0A', accentContrast: '#FFFFFF',
    hero: '#FFD23F', heroText: '#1C1A12', pop: '#1C1A12', popText: '#FFD23F',
  },
  paper: {
    bg: '#F1F1EE', surface: '#FFFFFF', text: '#161616', muted: '#595957',
    accent: '#C3311A', accentContrast: '#FFFFFF',
    hero: '#161616', heroText: '#F1F1EE', pop: '#F2664F', popText: '#161616',
  },
  midnight: {
    dark: true,
    bg: '#0E1220', surface: '#182036', text: '#EEF1F7', muted: '#A7B0C4',
    accent: '#C6F35E', accentContrast: '#131A06',
    hero: '#1B2440', heroText: '#EEF1F7', pop: '#C6F35E', popText: '#131A06',
  },
  espresso: {
    dark: true,
    bg: '#1C1410', surface: '#2A1F19', text: '#F5EBDD', muted: '#C4B2A0',
    accent: '#E0A46A', accentContrast: '#1C1410',
    hero: '#3A2418', heroText: '#F5EBDD', pop: '#E0A46A', popText: '#1C1410',
  },
};

export const THEMES = {
  garden: {
    label: 'Garden',
    description: 'Warm earthy greens on pale sage with a marigold button; good for food, cafes, plants, wellness, anything fresh or natural.',
  },
  terracotta: {
    label: 'Terracotta',
    description: 'Sun-baked clay orange on warm sand; good for bakeries, home cooking, pottery, crafts, handmade and homely businesses.',
  },
  harbour: {
    label: 'Harbour',
    description: 'Deep navy and sea blue on pale mist with a seafoam button; calm and trustworthy, good for tutors, consultants, clinics, repairs, professional services.',
  },
  blossom: {
    label: 'Blossom',
    description: 'Soft blush pink with deep berry; good for beauty, salons, florists, cakes, gifts, weddings, anything gentle or romantic.',
  },
  sunshine: {
    label: 'Sunshine',
    description: 'Bright yellow with ink black and a hot orange accent; loud and cheerful, good for kids, street food, events, classes, anything energetic.',
  },
  paper: {
    label: 'Paper',
    description: 'Black and off-white like a printed page with one red accent; good for tailors, studios, photographers, writers, designers, anything craft-led or minimal.',
  },
  midnight: {
    label: 'Midnight',
    description: 'Dark navy night with an electric lime accent; good for tech freelancers, music, gaming, nightlife, anything modern that should feel bold after dark.',
  },
  espresso: {
    label: 'Espresso',
    description: 'Dark roasted brown with cream text and caramel accents; good for coffee, barbers, bars, leather, woodwork, anything rich and moody.',
  },
};

// ---------------------------------------------------------------------------
// Moods: typography and shape language only.
// ---------------------------------------------------------------------------

export const MOODS = {
  warm: {
    label: 'Warm',
    description: 'Soft, friendly serif headings with a clean rounded-feeling body, gentle curves and pill buttons; feels like a neighbourhood place you already like.',
  },
  modern: {
    label: 'Modern',
    description: 'Heavy tight grotesque headings, square corners, strong rules and a grid; feels sharp, confident and current.',
  },
  classic: {
    label: 'Classic',
    description: 'Elegant high-contrast serif set like a title page, centred heading, fine double rules and small caps; feels established, careful and traditional.',
  },
  playful: {
    label: 'Playful',
    description: 'Chunky rounded headings, big soft corners, tilted stickers and a wavy edge; feels fun, informal and approachable.',
  },
};

const DEFAULT_THEME = 'garden';
const DEFAULT_MOOD = 'warm';

// Length caps, in characters (graphemes). Exported for tests and prompts.
export const CAPS = {
  name: 60, kind: 30, tagline: 110, intro: 420, audience: 200, cta: 28,
  highlights: 4, highlightTitle: 50, highlightText: 220,
  phone: 32, whatsapp: 32, email: 120, address: 160, hours: 120, note: 200,
};

// ---------------------------------------------------------------------------
// Text hygiene
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

function esc(value) {
  return String(value ?? '').replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]);
}

function graphemes(str) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(str), (s) => s.segment);
  }
  return Array.from(str);
}

function clean(value, cap) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  let s = String(value);
  try { s = s.normalize('NFC'); } catch { /* keep as is */ }
  s = s
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ') // control chars and line breaks
    .replace(/[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '') // zero-width and bidi overrides
    .replace(/\s+/g, ' ')
    .trim();
  if (!cap) return s;
  const parts = graphemes(s);
  if (parts.length <= cap) return s;
  let cut = parts.slice(0, cap - 1).join('');
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > cut.length * 0.6) cut = cut.slice(0, lastSpace);
  return cut.replace(/[\s,;:.\-–—]+$/u, '') + '…';
}

function pickKey(value, table, fallback) {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return Object.hasOwn(table, key) ? key : fallback;
}

export function normaliseSite(input) {
  const src = input && typeof input === 'object' ? input : {};
  const c = src.contact && typeof src.contact === 'object' ? src.contact : {};

  const highlights = [];
  if (Array.isArray(src.highlights)) {
    for (const item of src.highlights) {
      if (highlights.length >= CAPS.highlights) break;
      let title = '';
      let text = '';
      if (typeof item === 'string') {
        text = clean(item, CAPS.highlightText);
      } else if (item && typeof item === 'object') {
        title = clean(item.title, CAPS.highlightTitle);
        text = clean(item.text, CAPS.highlightText);
      }
      if (title || text) highlights.push({ title, text });
    }
  }

  const kind = clean(src.kind, CAPS.kind);
  const name = clean(src.name, CAPS.name) || kind || 'Open for business';

  return {
    name,
    kind: kind === name ? '' : kind,
    tagline: clean(src.tagline, CAPS.tagline),
    intro: clean(src.intro, CAPS.intro),
    highlights,
    audience: clean(src.audience, CAPS.audience),
    contact: {
      phone: clean(c.phone, CAPS.phone),
      whatsapp: clean(c.whatsapp, CAPS.whatsapp),
      email: clean(c.email, CAPS.email),
      address: clean(c.address, CAPS.address),
      hours: clean(c.hours, CAPS.hours),
      note: clean(c.note, CAPS.note),
    },
    cta: clean(src.cta, CAPS.cta),
    theme: pickKey(src.theme, THEMES, DEFAULT_THEME),
    mood: pickKey(src.mood, MOODS, DEFAULT_MOOD),
  };
}

// ---------------------------------------------------------------------------
// Link validation. Hrefs are rebuilt from validated characters, never copied.
// ---------------------------------------------------------------------------

function phoneDigits(raw) {
  // Allow only digits, one leading +, and common separators. Anything else
  // (letters, colons, slashes) means we do not trust it enough to link.
  if (!/^\+?[\d\s().\-]+$/.test(raw)) return '';
  const plus = raw.startsWith('+') ? '+' : '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 15) return '';
  return plus + digits;
}

function telHref(raw) {
  const d = phoneDigits(raw);
  return d ? `tel:${d}` : '';
}

function whatsappHref(raw) {
  const d = phoneDigits(raw).replace('+', '');
  return d.length >= 8 ? `https://wa.me/${d}` : '';
}

function mailHref(raw) {
  if (raw.length > 120) return '';
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9._%+\-]{0,62}[A-Za-z0-9_%+\-])?)@((?:[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24})$/.exec(raw);
  if (!m || m[1].includes('..')) return '';
  return `mailto:${encodeURIComponent(m[1])}@${m[2].toLowerCase()}`;
}

function safeHttpUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2000) return '';
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Colour helpers (also used by the contrast check while developing)
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mixHex(a, b, t) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const ch = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${ch(r1, r2)}${ch(g1, g2)}${ch(b1, b2)}`.toUpperCase();
}

export function contrastRatio(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = hexToRgb(hex).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Opacity of the decorative hero drawing. Text may sit on top of it, so the
// contrast check tests hero text against the hero colour blended at this alpha.
export const DECOR_ALPHA = 0.16;

// ---------------------------------------------------------------------------
// Mood definitions: font stylesheet, tokens, extra CSS, hero drawing
// ---------------------------------------------------------------------------

const SANS_FALLBACK = 'ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';
const SERIF_FALLBACK = '"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif';
const ROUND_FALLBACK = 'ui-rounded,"SF Pro Rounded","Arial Rounded MT Bold","Varela Round",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';

const MOOD_STYLE = {
  warm: {
    fonts: 'https://fonts.googleapis.com/css2?family=Figtree:wght@400;600;700&family=Vollkorn:ital,wght@0,400..800;1,400..800&display=swap',
    tokens: `--font-display:"Vollkorn",${SERIF_FALLBACK};--font-body:"Figtree",${SANS_FALLBACK};--display-weight:650;--display-tracking:-.018em;--display-leading:1;--cw:.54;--h1-scale:1;--hero-pad:2.5rem;--btn-radius:999px;--rule:1px solid var(--line)`,
    css: `
.hero{border-radius:0 0 2rem 2rem}
.mono{border-radius:999px 999px .625rem .625rem;height:3.375rem}
.tagline{font-family:var(--font-display);font-style:italic;font-weight:400;font-size:clamp(1.3125rem,5.2vw,1.75rem)}
.items h3::before{border-radius:0 100% 0 100%;width:.8rem;height:.8rem}
.label{font-family:var(--font-display);font-style:italic;font-weight:500;font-size:1.25rem;color:var(--accent)}
@media(min-width:48rem){.hero{border-radius:0 0 3rem 3rem}}`,
    decor: `<svg class="decor" viewBox="0 0 400 400" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="400" cy="150" r="110"/><circle cx="400" cy="150" r="170"/><circle cx="400" cy="150" r="230"/><circle cx="400" cy="150" r="290"/></g><circle cx="400" cy="150" r="56" fill="currentColor"/></svg>`,
  },
  modern: {
    fonts: 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Hanken+Grotesk:wght@400..700&display=swap',
    tokens: `--font-display:"Bricolage Grotesque",${SANS_FALLBACK};--font-body:"Hanken Grotesk",${SANS_FALLBACK};--display-weight:800;--display-tracking:-.04em;--display-leading:.94;--cw:.56;--h1-scale:1;--hero-pad:2.5rem;--btn-radius:.25rem;--rule:2px solid var(--text)`,
    css: `
.mono{border-radius:0}
.kind,.details dt,.label{text-transform:uppercase;letter-spacing:.09em;font-size:.875rem;font-weight:600}
.kind::first-letter{text-transform:uppercase}
.hero-main{border-top:2px solid var(--hero-text);padding-top:1.25rem}
.tagline{font-weight:500}
.btn{font-weight:700;letter-spacing:-.01em}
h2{font-size:clamp(2rem,8vw,3.25rem)}
.items h3{font-weight:700;letter-spacing:-.02em}
.facts{border-bottom:2px solid var(--text)}
.foot{border-top:2px solid var(--text)}`,
    decor: `<svg class="decor" viewBox="0 0 400 400" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2" d="M0 100H400M0 200H400M0 300H400M100 0V400M200 0V400M300 0V400"/><circle cx="300" cy="200" r="100" fill="none" stroke="currentColor" stroke-width="2"/><rect x="300" y="0" width="100" height="100" fill="currentColor"/><path fill="currentColor" d="M100 200a100 100 0 0 1 100 100H100Z"/></svg>`,
  },
  classic: {
    fonts: 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;0,700;1,500&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap',
    tokens: `--font-display:"Cormorant Garamond",${SERIF_FALLBACK};--font-body:"Source Serif 4",${SERIF_FALLBACK};--display-weight:600;--display-tracking:0em;--display-leading:1;--cw:.5;--h1-scale:1.12;--hero-pad:5.5rem;--btn-radius:2px;--rule:3px double var(--line)`,
    css: `
.hero .wrap{text-align:center;align-items:center;padding:2.5rem 2.75rem 3rem}
.hero .wrap::before{content:"";position:absolute;inset:.75rem;border:1px solid var(--hero-line);outline:1px solid var(--hero-line);outline-offset:-.3125rem;pointer-events:none}
.masthead{flex-direction:column;gap:.875rem}
.mono{border-radius:50%;width:3.75rem;height:3.75rem;background:transparent;color:var(--hero-text);border:1px solid var(--hero-text);box-shadow:inset 0 0 0 .1875rem var(--hero),inset 0 0 0 .25rem var(--hero-text);font-size:1.875rem;font-weight:500}
.kind{font-variant-caps:all-small-caps;letter-spacing:.16em;font-size:1.0625rem}
.hero-main{display:flex;flex-direction:column;align-items:center}
.tagline{font-family:var(--font-display);font-style:italic;font-weight:500;font-size:clamp(1.4375rem,5.6vw,1.875rem);margin-top:0}
.tagline::before{content:"";display:block;width:4.5rem;height:.4375rem;margin:1.125rem auto 1rem;border-block:1px solid currentColor}
.hero .actions{justify-content:center;flex-direction:column}
.btn{text-transform:uppercase;letter-spacing:.12em;font-size:.875rem;font-weight:600;padding-inline:1.75rem}
h2{font-weight:600;font-size:clamp(2.125rem,8vw,3rem)}
h2::before{content:"";display:block;width:3rem;height:1px;background:var(--accent);margin-bottom:1rem}
.items h3{font-size:clamp(1.5rem,5.6vw,1.875rem)}
.items h3::before{width:.5rem;height:.5rem;transform:rotate(45deg) translateY(-.2em)}
.details dt,.label{font-variant-caps:all-small-caps;letter-spacing:.14em;font-size:1rem}
.lead{font-family:var(--font-display);font-weight:500;font-size:clamp(1.5rem,5.8vw,2rem);line-height:1.3}
@media(min-width:48rem){.hero .wrap{padding:3rem 4rem 4rem}.hero .wrap::before{inset:1.25rem}}`,
    decor: '',
  },
  playful: {
    fonts: 'https://fonts.googleapis.com/css2?family=Fredoka:wght@400..700&family=Nunito:wght@400..800&display=swap',
    tokens: `--font-display:"Fredoka",${ROUND_FALLBACK};--font-body:"Nunito",${ROUND_FALLBACK};--display-weight:600;--display-tracking:-.012em;--display-leading:1.02;--cw:.6;--h1-scale:1;--hero-pad:2.5rem;--btn-radius:999px;--rule:0 solid transparent`,
    css: `
.hero .wrap{padding-bottom:4.25rem}
.mono{border-radius:44% 56% 52% 48%/54% 44% 56% 46%;transform:rotate(-7deg);background:var(--hero-text);color:var(--hero);width:3.375rem;height:3.375rem;font-size:1.75rem}
.kind{background:var(--pop);color:var(--pop-text);padding:.375rem .9375rem;border-radius:999px;transform:rotate(3deg);font-weight:700}
.tagline{font-weight:600}
.btn{font-family:var(--font-display);font-weight:600;font-size:1.1875rem;min-height:3.5rem;padding-inline:1.75rem;box-shadow:0 .375rem 1rem -.25rem var(--btn-shadow)}
h2::after{content:"";display:block;width:5rem;height:.75rem;margin-top:.625rem;background:var(--accent);-webkit-mask:var(--squiggle) left center/contain no-repeat;mask:var(--squiggle) left center/contain no-repeat}
.offer{border-radius:2rem 2rem 0 0}
.items{display:grid;gap:.875rem}
.items li{background:var(--bg);border-radius:1.5rem;padding:1.25rem 1.375rem}
.items li:nth-child(odd){transform:rotate(-.6deg)}
.items li:nth-child(even){transform:rotate(.5deg)}
.items li:last-child{border-bottom:0}
.items h3::before{border-radius:50%;width:.85rem;height:.85rem}
.details>div{border-top:2px dashed var(--line)}
.details>div:last-child{border-bottom:2px dashed var(--line)}
.facts{border-bottom:2px dashed var(--line)}
.foot{border-top:2px dashed var(--line)}
.label{font-family:var(--font-display);font-weight:600;font-size:1.1875rem;color:var(--accent)}
@media(min-width:48rem){.hero .wrap{padding-bottom:6rem}.items{grid-template-columns:1fr 1fr;gap:1.25rem}.items li{grid-template-columns:1fr}}`,
    decor: `<svg class="decor" viewBox="0 0 400 400" aria-hidden="true" focusable="false"><circle cx="318" cy="150" r="58" fill="currentColor"/><circle cx="196" cy="62" r="24" fill="none" stroke="currentColor" stroke-width="9"/><path fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" d="M150 236q22-30 44 0t44 0 44 0"/><path fill="currentColor" d="M352 268l11 27 27 11-27 11-11 27-11-27-27-11 27-11z"/><path fill="currentColor" d="M88 118a34 34 0 0 1 68 0z" transform="rotate(-18 122 118)"/></svg>`,
    wave: `<svg class="wave" viewBox="0 0 1200 60" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="M0 60V32C120 4 250 0 400 26s300 34 450 8 250-30 350-6v30z"/></svg>`,
  },
};

const SQUIGGLE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 12'%3E%3Cpath d='M3 6q9-8 18 0t18 0 18 0 18 0' fill='none' stroke='%23000' stroke-width='4' stroke-linecap='round'/%3E%3C/svg%3E")`;

// ---------------------------------------------------------------------------
// Base stylesheet (static; the only variable parts are our own tokens)
// ---------------------------------------------------------------------------

const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%;background:var(--bg);scrollbar-color:var(--line) var(--bg)}
body{margin:0;min-height:100vh;min-height:100svh;display:flex;flex-direction:column;background:var(--bg);color:var(--text);font-family:var(--font-body);font-size:1.0625rem;line-height:1.6;-webkit-font-smoothing:antialiased;overflow-wrap:break-word}
::selection{background:var(--accent);color:var(--accent-contrast)}
h1,h2,h3,p,dl,dd,ul{margin:0}
ul{padding:0;list-style:none}
p{text-wrap:pretty}
a{color:var(--accent);text-decoration-thickness:.08em;text-underline-offset:.2em}
a:hover{text-decoration-thickness:.15em}
:focus-visible{outline:3px solid var(--accent);outline-offset:3px;border-radius:2px}
.wrap{width:100%;max-width:68rem;margin-inline:auto;padding-inline:1.25rem}
.skip{position:absolute;left:1rem;top:-5rem;z-index:10;background:var(--text);color:var(--bg);padding:.75rem 1rem;border-radius:.25rem;font-weight:600}
.skip:focus{top:1rem}
svg{display:block}

.hero{position:relative;overflow:hidden;display:flex;flex:none;min-height:32rem;min-height:min(84svh,44rem);background:var(--hero);color:var(--hero-text)}
.only-hero .hero{flex:1 0 auto}
.hero ::selection{background:var(--pop);color:var(--pop-text)}
.hero .wrap{position:relative;display:flex;flex-direction:column;justify-content:space-between;gap:3.5rem;padding-block:1.25rem 2.5rem}
.decor{position:absolute;top:0;right:0;width:min(86vw,30rem);height:auto;color:var(--hero-text);opacity:${DECOR_ALPHA};pointer-events:none}
.wave{position:absolute;left:0;bottom:-1px;width:100%;height:2.25rem;pointer-events:none}
.wave path{fill:var(--bg)}
.masthead{display:flex;align-items:center;justify-content:space-between;gap:1rem}
.mono{display:grid;place-items:center;flex:none;width:3rem;height:3rem;background:var(--pop);color:var(--pop-text);font-family:var(--font-display);font-weight:var(--display-weight);font-size:1.5rem;line-height:1}
.kind{font-weight:600;font-size:1rem;line-height:1.3;text-align:right}
.kind::first-letter{text-transform:uppercase}
h1{font-family:var(--font-display);font-weight:var(--display-weight);letter-spacing:var(--display-tracking);line-height:var(--display-leading);font-size:2.5rem;font-size:max(1.75rem,min(calc(var(--h1-cap)*var(--h1-scale)),calc(var(--h1-vw)*var(--h1-scale)),calc((100vw - var(--hero-pad))/(var(--w)*var(--cw)))));text-wrap:balance;overflow-wrap:anywhere}
.tagline{margin-top:1rem;font-size:clamp(1.1875rem,4.8vw,1.5rem);line-height:1.32;max-width:30ch;text-wrap:balance}
.actions{margin-top:1.75rem;display:flex;flex-wrap:wrap;align-items:center;gap:.75rem 1.25rem}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.625rem;min-height:3.25rem;padding:.75rem 1.5rem;border-radius:var(--btn-radius);background:var(--accent);color:var(--accent-contrast);font-weight:700;font-size:1.0625rem;line-height:1.2;text-decoration:none;transition:transform .18s cubic-bezier(.16,1,.3,1)}
.btn svg{flex:none}
.btn:hover{transform:translateY(-2px)}
.btn:active{transform:translateY(1px)}
.hero .btn{background:var(--pop);color:var(--pop-text)}
.hero :focus-visible{outline-color:var(--hero-text)}
.caption{font-size:1rem;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}

.facts{border-bottom:1px solid var(--line)}
.facts ul{display:flex;flex-direction:column;gap:.5rem;padding-block:1.125rem}
.facts li{display:flex;gap:.625rem;align-items:flex-start;font-size:1rem;line-height:1.45}
.facts svg{flex:none;margin-top:.15em;color:var(--accent)}

main{flex:1 0 auto}
.section{padding-block:clamp(3rem,10vw,5.5rem)}
h2{font-family:var(--font-display);font-weight:var(--display-weight);letter-spacing:var(--display-tracking);font-size:clamp(1.875rem,7vw,2.75rem);line-height:1.08;text-wrap:balance}
.lead{font-size:clamp(1.25rem,5vw,1.625rem);line-height:1.42;max-width:36ch}
.for{margin-top:2.25rem;max-width:34rem}
.about>.wrap>.for:first-child{margin-top:0}
.label{font-size:1rem;font-weight:700;letter-spacing:0;line-height:1.3;color:var(--muted)}
.label::before,.label::after{content:none}
.for p{margin-top:.375rem}

.offer{background:var(--surface)}
.items{margin-top:1.75rem}
.items li{display:grid;gap:.375rem;padding-block:1.375rem;border-top:var(--rule)}
.items li:last-child{border-bottom:var(--rule)}
.items h3{display:flex;align-items:baseline;gap:.75rem;font-family:var(--font-display);font-weight:var(--display-weight);letter-spacing:var(--display-tracking);font-size:clamp(1.375rem,5.2vw,1.625rem);line-height:1.15}
.items h3::before{content:"";flex:none;width:.6875rem;height:.6875rem;background:var(--accent);transform:translateY(-.08em)}
.items p{color:var(--muted);max-width:60ch}

.contact .note{margin-top:.875rem;max-width:44ch}
.contact .actions{margin-top:1.5rem}
.details{margin-top:2.25rem}
.details>div{display:grid;grid-template-columns:minmax(0,1fr);align-items:center;gap:0 1rem;padding-block:.875rem .5rem;border-top:var(--rule)}
.details>div:last-child{border-bottom:var(--rule)}
.details dt{color:var(--muted);font-size:.9375rem;line-height:1.3}
.details dd{font-variant-numeric:tabular-nums;overflow-wrap:anywhere;padding-bottom:.375rem}
.details a{display:inline-block;padding-block:.625rem;margin-block:-.125rem -.5rem;font-weight:600}
@media(min-width:30rem){.details>div{grid-template-columns:6.5rem minmax(0,1fr);min-height:3.75rem;padding-block:.5rem}.details dd{padding-bottom:0}.details a{margin-block:0}}

.foot{flex:none;border-top:1px solid var(--line);color:var(--muted);font-size:.875rem;line-height:1.5}
.foot .wrap{padding-block:1.5rem 2rem}
.foot p{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.125rem 1.5rem}
.foot time{white-space:nowrap}
.only-hero .foot{border-top:0}

@media(min-width:48rem){
.wrap{padding-inline:2.5rem}
.hero .wrap{padding-block:2rem 4rem}
.decor{width:min(46vw,38rem)}
.wave{height:3.5rem}
.tagline{max-width:34ch}
.facts ul{flex-direction:row;gap:2.75rem;padding-block:1.25rem}
.about>.wrap{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,4fr);gap:2rem 4rem;align-items:start}
.about>.wrap>:only-child{grid-column:1/-1}
.for{margin-top:.5rem}
.items li{grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:2rem;align-items:baseline;padding-block:1.75rem}
.items li>:only-child{grid-column:1/-1}
.contact>.wrap{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:2rem 4rem;align-items:start}
.contact>.wrap>:only-child{grid-column:1/-1}
.details{margin-top:.5rem}
.details>div{grid-template-columns:8rem minmax(0,1fr)}
}
@media(prefers-reduced-motion:no-preference){
.hero-main>*{animation:rise .9s cubic-bezier(.16,1,.3,1) backwards}
.hero-main>:nth-child(2){animation-delay:.09s}
.hero-main>:nth-child(3){animation-delay:.18s}
.decor{animation:settle 1.4s cubic-bezier(.16,1,.3,1) backwards}
@keyframes rise{from{opacity:0;transform:translateY(1rem)}}
@keyframes settle{from{opacity:0;transform:translate(1.5rem,-1rem) scale(1.06)}}
}
@media print{.hero{min-height:0}.btn{border:1px solid currentColor}}
`;

// ---------------------------------------------------------------------------
// Small drawn icons (static markup, one stroke weight)
// ---------------------------------------------------------------------------

const icon = (paths) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

const ICONS = {
  phone: icon('<path d="M5.5 3.5h3l1.6 4.2-2 1.4a12 12 0 0 0 6.8 6.8l1.4-2 4.2 1.6v3a2 2 0 0 1-2.2 2A17 17 0 0 1 3.5 5.7a2 2 0 0 1 2-2.2z"/>'),
  chat: icon('<path d="M20.5 11.5a8.5 8.5 0 0 1-12.4 7.6L3.5 20.5l1.4-4.4A8.5 8.5 0 1 1 20.5 11.5z"/>'),
  mail: icon('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6.5L20.5 7"/>'),
  clock: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  pin: icon('<path d="M12 21s-6.5-5.6-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.25"/>'),
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function headingSize(name) {
  const total = graphemes(name).length;
  const longest = name.split(/[\s\-–—/]+/u).reduce((m, w) => Math.max(m, graphemes(w).length), 1);
  let cap = 6;
  let vw = 16;
  if (total > 44) { cap = 3; vw = 8.5; } else if (total > 28) { cap = 3.75; vw = 10.5; } else if (total > 16) { cap = 4.75; vw = 13; }
  if (longest > 20) cap = Math.min(cap, 2.5);
  else if (longest > 14) cap = Math.min(cap, 3.25);
  else if (longest > 10) cap = Math.min(cap, 4.5);
  return { cap, vw, w: Math.min(Math.max(longest, 4), 26) };
}

function themeTokens(p) {
  const line = mixHex(p.bg, p.text, 0.18);
  const heroLine = mixHex(p.hero, p.heroText, 0.38);
  const btnShadow = mixHex(p.hero, '#000000', 0.55);
  return `--bg:${p.bg};--surface:${p.surface};--text:${p.text};--muted:${p.muted};--accent:${p.accent};--accent-contrast:${p.accentContrast};--hero:${p.hero};--hero-text:${p.heroText};--pop:${p.pop};--pop-text:${p.popText};--line:${line};--hero-line:${heroLine};--btn-shadow:${btnShadow}`;
}

function primaryAction(site) {
  const { phone, whatsapp, email } = site.contact;
  const tel = telHref(phone);
  const wa = whatsappHref(whatsapp);
  const mail = mailHref(email);
  let action = null;
  if (tel) action = { type: 'phone', href: tel, icon: ICONS.phone, fallback: 'Call now', caption: phone };
  else if (wa) action = { type: 'whatsapp', href: wa, icon: ICONS.chat, fallback: 'Message on WhatsApp', caption: whatsapp };
  else if (mail) action = { type: 'email', href: mail, icon: ICONS.mail, fallback: 'Send an email', caption: email };
  if (!action) return { action: null, tel, wa, mail };

  // Keep the caller's wording unless it promises a channel the button does not use.
  let label = site.cta;
  const says = {
    phone: /\b(call|ring|phone|dial)\b/i.test(label),
    whatsapp: /whats\s?app/i.test(label),
    email: /\be-?mail\b/i.test(label),
  };
  const mismatch = Object.keys(says).some((k) => says[k] && k !== action.type) && !says[action.type];
  if (!label || mismatch) label = action.fallback;
  action.label = label;
  return { action, tel, wa, mail };
}

function buttonHtml(action) {
  const rel = action.type === 'whatsapp' ? ' rel="noopener noreferrer"' : '';
  return `<a class="btn" href="${esc(action.href)}"${rel}>${action.icon}<span>${esc(action.label)}</span></a>`;
}

function formatDate(builtAt) {
  if (builtAt == null || builtAt === '') return null;
  const d = builtAt instanceof Date ? builtAt : new Date(builtAt);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return {
    iso: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    text: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(d),
  };
}

function footerHtml(builtAt) {
  const date = formatDate(builtAt);
  const when = date ? ` <time datetime="${esc(date.iso)}">${esc(date.text)}</time>` : '';
  return `<footer class="foot"><div class="wrap"><p><span>Made on a phone call with Launchpad</span>${when}</p></div></footer>`;
}

function faviconHref(color) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='9' fill='${color}'/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const CSP = "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; base-uri 'none'; form-action 'none'";

export function renderSite(siteInput, options = {}) {
  const { url, builtAt } = options && typeof options === 'object' ? options : {};
  const site = normaliseSite(siteInput);
  const palette = PALETTES[site.theme];
  const mood = MOOD_STYLE[site.mood];
  const { contact } = site;
  const { action, tel, wa, mail } = primaryAction(site);

  // ---- head ----
  const titleBase = site.tagline ? `${site.name} · ${site.tagline}` : site.kind ? `${site.name} · ${site.kind}` : site.name;
  const title = clean(titleBase, 70);
  const description = clean([site.tagline, site.intro].filter(Boolean).join('. ').replace(/([.!?…])\. /g, '$1 '), 160)
    || clean(site.kind ? `${site.name}, ${site.kind}.` : site.name, 160);
  const ogDescription = site.tagline || description;
  const pageUrl = safeHttpUrl(url);
  const size = headingSize(site.name);

  const head = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${esc(CSP)}">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="${palette.dark ? 'dark' : 'light'}">
<meta name="theme-color" content="${palette.hero}">
<meta name="format-detection" content="telephone=no">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(site.name)}">
<meta property="og:description" content="${esc(ogDescription)}">
<meta property="og:site_name" content="${esc(site.name)}">
${pageUrl ? `<meta property="og:url" content="${esc(pageUrl)}">\n<link rel="canonical" href="${esc(pageUrl)}">\n` : ''}<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(site.name)}">
<meta name="twitter:description" content="${esc(ogDescription)}">
<link rel="icon" href="${esc(faviconHref(palette.pop))}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${esc(mood.fonts)}">
<style>
:root{${themeTokens(palette)};${mood.tokens};--squiggle:${SQUIGGLE};--h1-cap:${size.cap}rem;--h1-vw:${size.vw}vw;--w:${size.w}}${BASE_CSS}${mood.css}
</style>`;

  // ---- hero ----
  const initialMatch = /[\p{L}\p{N}]/u.exec(site.name);
  const initial = initialMatch ? initialMatch[0].toLocaleUpperCase() : '';
  const masthead = initial || site.kind
    ? `<div class="masthead">${initial ? `<span class="mono" aria-hidden="true">${esc(initial)}</span>` : ''}${site.kind ? `<p class="kind">${esc(site.kind)}</p>` : ''}</div>`
    : '<div class="masthead"></div>';
  const heroActions = action
    ? `<div class="actions">${buttonHtml(action)}<span class="caption">${esc(action.caption)}</span></div>`
    : '';
  const heroInner = `${mood.decor || ''}<div class="wrap">${masthead}<div class="hero-main"><h1>${esc(site.name)}</h1>${site.tagline ? `<p class="tagline">${esc(site.tagline)}</p>` : ''}${heroActions}</div></div>${mood.wave || ''}`;

  // ---- facts strip ----
  const facts = [
    contact.hours ? `<li>${ICONS.clock}<span>${esc(contact.hours)}</span></li>` : '',
    contact.address ? `<li>${ICONS.pin}<span>${esc(contact.address)}</span></li>` : '',
  ].join('');
  const factsHtml = facts ? `<div class="facts"><div class="wrap"><ul aria-label="At a glance">${facts}</ul></div></div>` : '';

  // ---- about ----
  let aboutHtml = '';
  if (site.intro || site.audience) {
    const lead = site.intro ? `<p class="lead">${esc(site.intro)}</p>` : '';
    const who = site.audience ? `<div class="for"><h2 class="label">Who it’s for</h2><p>${esc(site.audience)}</p></div>` : '';
    aboutHtml = `<section class="section about" aria-label="About ${esc(site.name)}"><div class="wrap">${lead}${who}</div></section>`;
  }

  // ---- highlights ----
  let offerHtml = '';
  if (site.highlights.length) {
    const items = site.highlights
      .map((h) => `<li>${h.title ? `<h3>${esc(h.title)}</h3>` : ''}${h.text ? `<p>${esc(h.text)}</p>` : ''}</li>`)
      .join('');
    offerHtml = `<section class="section offer" aria-labelledby="offer-h"><div class="wrap"><h2 id="offer-h">What’s on offer</h2><ul class="items">${items}</ul></div></section>`;
  }

  // ---- contact ----
  let contactHtml = '';
  const hasReach = contact.phone || contact.whatsapp || contact.email;
  if (hasReach || contact.address || contact.hours || contact.note) {
    const heading = hasReach ? 'Get in touch' : contact.address ? 'Find us' : contact.hours ? 'Opening hours' : 'Good to know';
    const row = (label, value, href, rel = '') => {
      if (!value) return '';
      const body = href ? `<a href="${esc(href)}"${rel}>${esc(value)}</a>` : esc(value);
      return `<div><dt>${label}</dt><dd>${body}</dd></div>`;
    };
    const rows = [
      row('Phone', contact.phone, tel),
      row('WhatsApp', contact.whatsapp, wa, ' rel="noopener noreferrer"'),
      row('Email', contact.email, mail),
      row('Address', contact.address, ''),
      row('Hours', contact.hours, ''),
    ].join('');
    const headBlock = `<div><h2 id="contact-h">${heading}</h2>${contact.note ? `<p class="note">${esc(contact.note)}</p>` : ''}${action ? `<div class="actions">${buttonHtml(action)}</div>` : ''}</div>`;
    contactHtml = `<section class="section contact" aria-labelledby="contact-h"><div class="wrap">${headBlock}${rows ? `<dl class="details">${rows}</dl>` : ''}</div></section>`;
  }

  const mainInner = `${factsHtml}${aboutHtml}${offerHtml}${contactHtml}`;
  const body = mainInner
    ? `<a class="skip" href="#main">Skip to content</a>
<header class="hero">${heroInner}</header>
<main id="main">${mainInner}</main>`
    : `<main class="hero">${heroInner}</main>`;

  return `<!doctype html>
<html lang="en">
<head>
${head}
</head>
<body class="theme-${site.theme} mood-${site.mood}${mainInner ? '' : ' only-hero'}">
${body}
${footerHtml(builtAt)}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Pending screen: shown at the same URL until the real page is written.
// System fonts only so it paints instantly; reloads itself every 3 seconds and
// the animation loop is exactly 3s so each reload lands on the same frame.
// ---------------------------------------------------------------------------

export function renderPending(options = {}) {
  const name = options && typeof options === 'object' ? options.name : undefined;
  const who = clean(name, CAPS.name);
  const line = who
    ? `The page for <strong>${esc(who)}</strong> is on its way.`
    : 'It is on its way.';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="refresh" content="3">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#EAF0DF">
<title>Your page is being put together</title>
<link rel="icon" href="${esc(faviconHref('#234A2E'))}">
<style>
*,*::before,*::after{box-sizing:border-box}
html{background:#EAF0DF;-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;min-height:100vh;min-height:100svh;display:flex;flex-direction:column;background:#EAF0DF;color:#1F2A1C;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:1.0625rem;line-height:1.55;-webkit-font-smoothing:antialiased;overflow-wrap:break-word}
::selection{background:#234A2E;color:#EAF0DF}
main{flex:1;display:flex;flex-direction:column;justify-content:center;width:100%;max-width:34rem;margin-inline:auto;padding:2.5rem 1.5rem}
.sheet{width:8.5rem;padding:1rem;margin-bottom:2.25rem;background:#F8FBF1;border:1px solid #C9D2BC;border-radius:.75rem;box-shadow:0 1rem 2rem -1rem rgba(31,42,28,.35)}
.sheet i{display:block;height:.5rem;margin-top:.5rem;border-radius:999px;background:#D3DCC6;transform-origin:left center}
.sheet i:first-child{height:1.75rem;margin-top:0;border-radius:.375rem;background:#234A2E}
.sheet i:nth-child(3){width:78%}
.sheet i:nth-child(4){width:52%}
.sheet i:last-child{width:44%;height:1rem;margin-top:.875rem;background:#F2C14E}
h1{margin:0;font-family:ui-serif,"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;font-weight:600;font-size:clamp(2rem,9vw,2.75rem);line-height:1.08;letter-spacing:-.015em;text-wrap:balance}
p{margin:1rem 0 0;max-width:30rem;text-wrap:pretty}
.quiet{color:#525F4C}
footer{padding:1.5rem;color:#525F4C;font-size:.875rem;width:100%;max-width:34rem;margin-inline:auto}
@media(prefers-reduced-motion:no-preference){
.sheet i{animation:draw 3s cubic-bezier(.16,1,.3,1) infinite}
.sheet i:nth-child(2){animation-delay:.12s}
.sheet i:nth-child(3){animation-delay:.24s}
.sheet i:nth-child(4){animation-delay:.36s}
.sheet i:last-child{animation-delay:.5s}
@keyframes draw{0%{transform:scaleX(0);opacity:0}28%,86%{transform:scaleX(1);opacity:1}100%{transform:scaleX(1);opacity:0}}
}
</style>
</head>
<body>
<main>
<div class="sheet" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
<h1>Your page is being put together</h1>
<p>${line} It will appear right here in a few moments.</p>
<p class="quiet">Nothing to tap. This screen checks again every three seconds.</p>
</main>
<footer>Made on a phone call with Launchpad</footer>
</body>
</html>
`;
}
