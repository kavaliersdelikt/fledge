// The Fledge theme engine (0.6.2.1 "Plumage"). Pure TypeScript with no DOM and no imports, so the same file is used by the panel
// (live preview, server-side rendering) and by the API (validation, the public branding document). It is copied into both
// container images; keep it free of relative imports.
//
// A palette is described by a few inputs (an accent colour and a neutral tint). Everything else is derived in OKLCH so steps
// look even, then adjusted until text passes the contrast floors. The Fledge dark default is a fixed set of values, so a panel
// nobody has customised renders exactly as before.

export type Mode = 'dark' | 'light';
export type ModeSetting = Mode | 'system';
export type FontId = 'geist' | 'inter' | 'atkinson' | 'system' | 'mono';
export type Density = 'compact' | 'comfortable' | 'spacious';
export type ContrastLevel = 'standard' | 'high';

/** Colour tokens the derivation produces. Each is a CSS custom property of the same name (without the dashes). */
export const COLOR_TOKENS = [
  'bg', 'surface', 'surface-2', 'surface-3', 'raised', 'border', 'border-strong', 'border-hover',
  'text', 'text-2', 'text-3',
  'primary', 'primary-hover', 'primary-text', 'accent', 'on-accent',
  'ok', 'warn', 'bad', 'busy', 'on-bad',
  'seg-alt', 'terminal-bg', 'terminal-text', 'shadow-ink', 'wash', 'gloss', 'scrim',
] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];
export type Tokens = Record<ColorToken, string> & { highlight?: string; 'shadow-pop'?: string };

export type PaletteInput = {
  accent: string;
  /** 0-360: the tint of backgrounds and borders. */
  neutralHue: number;
  /** 0-0.04: 0 is pure grey. */
  neutralChroma: number;
  /** Colour of the main button; neutral ink when absent. */
  primary?: string;
  /** Raise the contrast floors to AAA (7:1 text). */
  contrast?: ContrastLevel;
  /** Advanced: pin single tokens. Checked like everything else. */
  overrides?: Partial<Record<ColorToken, string>>;
};

export type ThemeSpec = {
  mode: ModeSetting;
  allowUserMode: boolean;
  preset: string;
  dark: PaletteInput;
  light: PaletteInput;
  font: FontId;
  radius: number;
  density: Density;
  textScale: number;
  motion: 'full' | 'reduced';
};

export const FONTS: Record<FontId, { label: string; stack: string; note: string }> = {
  geist: { label: 'Geist', stack: '"Geist Variable", ui-sans-serif, system-ui, sans-serif', note: 'The Fledge default' },
  inter: { label: 'Inter', stack: '"Inter Variable", ui-sans-serif, system-ui, sans-serif', note: 'Neutral and familiar' },
  atkinson: { label: 'Atkinson Hyperlegible', stack: '"Atkinson Hyperlegible Next Variable", ui-sans-serif, system-ui, sans-serif', note: 'Designed for low vision' },
  system: { label: 'System font', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif', note: 'Whatever the device uses' },
  mono: { label: 'Monospace', stack: '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', note: 'Terminal look' },
};
export const RADII = [0, 4, 8, 10, 14, 18] as const;
export const TEXT_SCALES = [0.9, 1, 1.1, 1.2] as const;
export const DENSITIES: Record<Density, number> = { compact: 0.88, comfortable: 1, spacious: 1.12 };

/* ------------------------------------------------------------------------------------------------------------- colour maths */

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLin = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function isHex(v: unknown): v is string {
  return typeof v === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
}
export function normalizeHex(v: string): string {
  const h = v.trim().toLowerCase();
  return h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h;
}
export function hexToRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex);
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}

export type Oklch = { L: number; C: number; h: number };

export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = hexToRgb(hex).map((v) => toLin(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

function oklchToLinear({ L, C, h }: Oklch): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
const inGamut = (rgb: number[]) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);

/** OKLCH to #rrggbb. Colours outside sRGB lose chroma (not lightness) until they fit. */
export function oklchToHex(c: Oklch): string {
  const L = clamp(c.L, 0, 1);
  let lo = 0, hi = Math.max(0, c.C);
  let rgb = oklchToLinear({ L, C: hi, h: c.h });
  if (!inGamut(rgb)) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ L, C: mid, h: c.h }))) lo = mid; else hi = mid;
    }
    rgb = oklchToLinear({ L, C: lo, h: c.h });
  }
  return rgbToHex(...(rgb.map((v) => fromLin(clamp(v, 0, 1)) * 255) as [number, number, number]));
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => toLin(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG 2.x contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** Mix two colours in sRGB; t is the share of b. */
export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a), y = hexToRgb(b);
  return rgbToHex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t);
}

/** Moves the lightness of `fg` away from `bg` until the contrast reaches `min` (keeps hue and chroma). */
export function ensureContrast(fg: string, bg: string, min: number): string {
  if (contrast(fg, bg) >= min) return normalizeHex(fg);
  const c = hexToOklch(fg);
  const lighter = luminance(bg) < 0.4; // on dark backgrounds text gets lighter
  let lo = c.L, hi = lighter ? 1 : 0;
  let best = oklchToHex({ ...c, L: hi });
  // The extreme may still fail (a very saturated colour on a mid grey); take it anyway, the checker will say so.
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    const hex = oklchToHex({ ...c, L: mid });
    if (contrast(hex, bg) >= min) { best = hex; hi = mid; } else lo = mid;
  }
  return best;
}

const ink = (L: number, p: { neutralHue: number; neutralChroma: number }, k: number) =>
  oklchToHex({ L, C: p.neutralChroma * k, h: p.neutralHue });

/* ------------------------------------------------------------------------------------------------------------- derivation */

// Lightness ramps and the chroma each step carries, relative to the neutral chroma the administrator chose.
// The dark ramp is measured from the Fledge dark theme, so the default tint reproduces it closely.
const DARK_RAMP: Record<string, [number, number]> = {
  bg: [0.1491, 0.2], surface: [0.1818, 0.2], 'surface-2': [0.2126, 0.38], 'surface-3': [0.2508, 0.55], raised: [0.1994, 0.39],
  border: [0.2547, 0.73], 'border-strong': [0.3085, 0.89], 'border-hover': [0.3551, 1.0],
  text: [0.9344, 1.0], 'text-2': [0.7092, 1.19], 'text-3': [0.5344, 1.1],
};
const LIGHT_RAMP: Record<string, [number, number]> = {
  bg: [0.972, 0.5], surface: [0.994, 0.3], 'surface-2': [0.953, 0.6], 'surface-3': [0.922, 0.8], raised: [1, 0],
  border: [0.912, 0.9], 'border-strong': [0.855, 1.0], 'border-hover': [0.79, 1.0],
  text: [0.2, 0.9], 'text-2': [0.42, 1.0], 'text-3': [0.55, 1.0],
};
// Status colours: the validated Fledge set for dark. For light, hue and chroma are kept and lightness is found per surface.
const STATUS_DARK = { ok: '#78c08a', warn: '#f0a832', bad: '#f26a5c', busy: '#86a4f0' } as const;
// Hand-tuned for light surfaces: at least 4.5:1 on the darkest panel colour and still apart with red-green colour blindness.
const STATUS_LIGHT = { ok: '#17703f', warn: '#80570a', bad: '#c1272d', busy: '#2a56d6' } as const;

export const FLEDGE_DARK_TOKENS: Tokens = {
  bg: '#0b0b0a', surface: '#121211', 'surface-2': '#191917', 'surface-3': '#22221f', raised: '#161614',
  border: '#23231f', 'border-strong': '#31302b', 'border-hover': '#3d3c36',
  text: '#ece9e2', 'text-2': '#a4a199', 'text-3': '#6f6d66',
  primary: '#ebe5d6', 'primary-hover': '#f6f1e5', 'primary-text': '#141310', accent: '#8fb596', 'on-accent': '#ffffff',
  ok: '#78c08a', warn: '#f0a832', bad: '#f26a5c', busy: '#86a4f0', 'on-bad': '#1d0b08',
  'seg-alt': '#6d8f74', 'terminal-bg': '#080807', 'terminal-text': '#d4d1c9', 'shadow-ink': '#000000', wash: '#ffffff', gloss: '#ffffff', scrim: '#050504',
};

export type Derived = { tokens: Tokens; notes: string[] };

export function derivePalette(input: PaletteInput, mode: Mode): Derived {
  const notes: string[] = [];
  const dark = mode === 'dark';
  const high = input.contrast === 'high';
  const ramp = dark ? DARK_RAMP : LIGHT_RAMP;
  const neutral = { neutralHue: input.neutralHue, neutralChroma: input.neutralChroma };
  // Chroma of each step is the neutral chroma times a measured factor (0.2 for the page background up to 1.2 for secondary text).
  const t: Partial<Tokens> = {};
  for (const [name, [L, f]] of Object.entries(ramp)) (t as any)[name] = ink(L, neutral, f);
  if (high) {
    // Higher separation between text, surfaces and borders.
    if (dark) { t.text = ink(0.985, neutral, 0); t['text-2'] = ink(0.88, neutral, 0.5); t['text-3'] = ink(0.76, neutral, 0.5); t.border = ink(0.42, neutral, 0.5); t['border-strong'] = ink(0.58, neutral, 0.5); t['border-hover'] = ink(0.72, neutral, 0.5); }
    else { t.text = ink(0.1, neutral, 0); t['text-2'] = ink(0.28, neutral, 0.5); t['text-3'] = ink(0.38, neutral, 0.5); t.border = ink(0.6, neutral, 0.5); t['border-strong'] = ink(0.45, neutral, 0.5); t['border-hover'] = ink(0.35, neutral, 0.5); }
  }
  const surfaces = [t.bg!, t.surface!, t['surface-2']!, t['surface-3']!, t.raised!];
  // Text ramps must pass on every surface they sit on.
  const floor = (fg: string, min: number) => {
    let out = fg;
    for (const s of surfaces) out = ensureContrast(out, s, min);
    return out;
  };
  t.text = floor(t.text!, 7);
  t['text-2'] = floor(t['text-2']!, high ? 7 : 4.5);
  // Hints and placeholders are small text too: calculated palettes keep them at 4.5:1 (Fledge's own dark palette predates this and sits at 3.6:1).
  t['text-3'] = floor(t['text-3']!, 4.5);

  // Accent: keep the chosen hue and chroma, make it readable as text and as a focus ring on every surface.
  const accentIn = isHex(input.accent) ? normalizeHex(input.accent) : FLEDGE_DARK_TOKENS.accent;
  const accentMin = high ? 7 : 4.5;
  t.accent = floor(accentIn, accentMin);
  if (t.accent !== accentIn) notes.push(`The accent ${accentIn} was ${dark ? 'lightened' : 'darkened'} to ${t.accent} so links and focus rings stay readable.`);

  // Main button: neutral ink unless the administrator picked a colour.
  if (input.primary && isHex(input.primary)) {
    t.primary = normalizeHex(input.primary);
    const pc = hexToOklch(t.primary);
    t['primary-hover'] = oklchToHex({ ...pc, L: clamp(pc.L + (pc.L > 0.5 ? -0.05 : 0.06), 0, 1) });
  } else {
    t.primary = dark ? ink(0.9225, neutral, 2.1) : ink(0.24, neutral, 0.9);
    t['primary-hover'] = dark ? ink(0.9588, neutral, 1.7) : ink(0.32, neutral, 0.9);
  }
  const lightText = ink(0.985, neutral, 0.4), darkText = ink(0.17, neutral, 0.6);
  const better = (bg: string) => (contrast(lightText, bg) >= contrast(darkText, bg) ? lightText : darkText);
  const pt = better(t.primary), pth = better(t['primary-hover']);
  t['primary-text'] = contrast(pt, t.primary) >= contrast(pth, t['primary-hover']) ? pt : pth;
  t['on-accent'] = better(t.accent) === lightText ? '#ffffff' : '#0d0c0a';

  // Status colours.
  for (const key of ['ok', 'warn', 'bad', 'busy'] as const) {
    const base = dark ? STATUS_DARK[key] : STATUS_LIGHT[key];
    t[key] = high ? floor(base, 7) : floor(base, 4.5);
  }
  t['on-bad'] = better(t.bad!) === lightText ? '#ffffff' : '#1d0b08';

  // Mixed and special-purpose tokens.
  t['seg-alt'] = mix(t.accent, t.bg!, dark ? 0.32 : 0.18);
  t['terminal-bg'] = oklchToHex({ L: dark ? 0.1339 : 0.17, C: input.neutralChroma * 0.26, h: input.neutralHue });
  t['terminal-text'] = ensureContrast(ink(0.8608, neutral, 1.1), t['terminal-bg'], 7);
  t['shadow-ink'] = dark ? '#000000' : ink(0.42, neutral, 1);
  t.wash = dark ? '#ffffff' : '#000000';
  t.gloss = '#ffffff';
  t.scrim = dark ? '#050504' : ink(0.16, neutral, 0.5);
  if (!dark) {
    t.highlight = 'inset 0 1px 0 color-mix(in srgb, #ffffff 80%, transparent)';
    t['shadow-pop'] = '0 24px 60px -12px color-mix(in srgb, var(--shadow-ink) 38%, transparent), 0 0 0 1px color-mix(in srgb, var(--shadow-ink) 14%, transparent)';
  }

  // Pinned tokens win over everything derived.
  if (input.overrides) for (const [name, value] of Object.entries(input.overrides)) {
    if ((COLOR_TOKENS as readonly string[]).includes(name) && isHex(value)) (t as any)[name] = normalizeHex(value);
  }
  return { tokens: t as Tokens, notes };
}

/* ------------------------------------------------------------------------------------------------------------- contrast report */

export type PairResult = { id: string; label: string; fg: ColorToken; bg: ColorToken; ratio: number; min: number; severity: 'error' | 'warning'; ok: boolean };
export type Report = { errors: string[]; warnings: string[]; pairs: PairResult[] };

// Simulation matrices for protanopia and deuteranopia (Machado et al., severity 1.0), applied in linear RGB.
const CVD = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
} as const;
function simulate(hex: string, m: readonly (readonly number[])[]): string {
  const lin = hexToRgb(hex).map((v) => toLin(v / 255));
  const out = m.map((row) => clamp(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2], 0, 1));
  return rgbToHex(...(out.map((v) => fromLin(v) * 255) as [number, number, number]));
}
function deltaOk(a: string, b: string): number {
  const x = hexToOklch(a), y = hexToOklch(b);
  const ax = x.C * Math.cos((x.h * Math.PI) / 180), bx = x.C * Math.sin((x.h * Math.PI) / 180);
  const ay = y.C * Math.cos((y.h * Math.PI) / 180), by = y.C * Math.sin((y.h * Math.PI) / 180);
  return Math.hypot(x.L - y.L, ax - ay, bx - by);
}

export function checkTokens(t: Tokens, level: ContrastLevel = 'standard'): Report {
  const high = level === 'high';
  const pairs: PairResult[] = [];
  const add = (id: string, label: string, fg: ColorToken, bg: ColorToken, min: number, severity: 'error' | 'warning') => {
    const ratio = contrast(t[fg], t[bg]);
    pairs.push({ id, label, fg, bg, ratio: Math.round(ratio * 100) / 100, min, severity, ok: ratio >= min });
  };
  const body = high ? 7 : 4.5;
  add('text-bg', 'Text on the page background', 'text', 'bg', body, 'error');
  add('text-surface', 'Text on cards', 'text', 'surface', body, 'error');
  add('text-surface-2', 'Text on raised areas', 'text', 'surface-2', body, 'error');
  add('text-raised', 'Text in menus and dialogs', 'text', 'raised', body, 'error');
  add('text2-surface', 'Secondary text on cards', 'text-2', 'surface', high ? 7 : 4.5, high ? 'error' : 'warning');
  add('text2-bg', 'Secondary text on the page background', 'text-2', 'bg', high ? 7 : 4.5, high ? 'error' : 'warning');
  add('text3-surface', 'Hints and placeholders on cards', 'text-3', 'surface', high ? 4.5 : 3, high ? 'error' : 'warning');
  add('accent-surface', 'Links and focus rings on cards', 'accent', 'surface', high ? 7 : 3, 'error');
  add('accent-bg', 'Links and focus rings on the page', 'accent', 'bg', high ? 7 : 3, 'error');
  add('accent-soft', 'Accent text under 4.5:1 is hard to read at small sizes', 'accent', 'surface', 4.5, 'warning');
  add('primary', 'Text on the main button', 'primary-text', 'primary', body, 'error');
  add('on-bad', 'Text on a delete button', 'on-bad', 'bad', body, 'error');
  for (const s of ['ok', 'warn', 'bad', 'busy'] as const) add(`status-${s}`, `${s === 'ok' ? 'Success' : s === 'warn' ? 'Warning' : s === 'bad' ? 'Error' : 'Busy'} colour on cards`, s, 'surface', high ? 4.5 : 3, 'error');
  add('terminal', 'Console text', 'terminal-text', 'terminal-bg', 7, 'error');
  if (high) add('border', 'Control borders', 'border-strong', 'surface', 3, 'error');
  const errors: string[] = [], warnings: string[] = [];
  for (const p of pairs) if (!p.ok) (p.severity === 'error' ? errors : warnings).push(`${p.label}: ${p.ratio}:1, needs ${p.min}:1`);
  // Colour-blind users must still tell the four status colours apart.
  const names = ['ok', 'warn', 'bad', 'busy'] as const;
  for (const [kind, m] of Object.entries(CVD)) {
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      const d = deltaOk(simulate(t[names[i]], m), simulate(t[names[j]], m));
      if (d < 0.04) warnings.push(`The ${names[i]} and ${names[j]} colours look alike with ${kind === 'protan' ? 'red-weak' : 'green-weak'} vision`);
    }
  }
  return { errors, warnings, pairs };
}

/* ------------------------------------------------------------------------------------------------------------- presets */

export type Preset = { id: string; name: string; description: string; dark: PaletteInput; light: PaletteInput; font?: FontId; radius?: number; density?: Density };

export const FLEDGE_DARK_INPUT: PaletteInput = { accent: '#8fb596', neutralHue: 96, neutralChroma: 0.01, overrides: { ...FLEDGE_DARK_TOKENS } };
export const FLEDGE_LIGHT_INPUT: PaletteInput = { accent: '#36724b', neutralHue: 96, neutralChroma: 0.01 };

export const PRESETS: Preset[] = [
  { id: 'fledge', name: 'Fledge', description: 'Warm black with sage accents. The default.', dark: FLEDGE_DARK_INPUT, light: FLEDGE_LIGHT_INPUT },
  { id: 'midnight', name: 'Midnight', description: 'Blue-black with a sky accent.', dark: { accent: '#7cb7ff', neutralHue: 262, neutralChroma: 0.022 }, light: { accent: '#1d62c9', neutralHue: 262, neutralChroma: 0.014 } },
  { id: 'ember', name: 'Ember', description: 'Warm dark with an orange glow.', dark: { accent: '#f0955a', neutralHue: 45, neutralChroma: 0.014 }, light: { accent: '#ab4900', neutralHue: 60, neutralChroma: 0.014 }, radius: 8 },
  { id: 'terminal', name: 'Terminal', description: 'Black, phosphor green, monospace, square corners.', dark: { accent: '#58e07b', neutralHue: 150, neutralChroma: 0.01 }, light: { accent: '#117638', neutralHue: 150, neutralChroma: 0.008 }, font: 'mono', radius: 0, density: 'compact' },
  { id: 'paper', name: 'Paper', description: 'Warm white with a deep green accent.', dark: { accent: '#8fb596', neutralHue: 96, neutralChroma: 0.01 }, light: { accent: '#2f6b46', neutralHue: 90, neutralChroma: 0.012 } },
  { id: 'snow', name: 'Snow', description: 'Cool, bright and quiet.', dark: { accent: '#7aa7ff', neutralHue: 250, neutralChroma: 0.012 }, light: { accent: '#2457d6', neutralHue: 250, neutralChroma: 0.008 } },
  { id: 'violet', name: 'Violet', description: 'Deep purple with a soft lilac accent.', dark: { accent: '#b69cff', neutralHue: 295, neutralChroma: 0.02 }, light: { accent: '#6a3fd1', neutralHue: 295, neutralChroma: 0.012 } },
  { id: 'contrast', name: 'High contrast', description: 'Maximum separation (AAA text) for low vision.', dark: { accent: '#ffd84d', neutralHue: 96, neutralChroma: 0, contrast: 'high' }, light: { accent: '#003eb8', neutralHue: 96, neutralChroma: 0, contrast: 'high' }, density: 'comfortable' },
];
export const presetById = (id: string) => PRESETS.find((p) => p.id === id);

export function defaultThemeSpec(): ThemeSpec {
  return { mode: 'dark', allowUserMode: true, preset: 'fledge', dark: structuredCloneSafe(FLEDGE_DARK_INPUT), light: structuredCloneSafe(FLEDGE_LIGHT_INPUT), font: 'geist', radius: 10, density: 'comfortable', textScale: 1, motion: 'full' };
}
function structuredCloneSafe<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }

export function applyPreset(spec: ThemeSpec, id: string): ThemeSpec {
  const p = presetById(id);
  if (!p) return spec;
  return { ...spec, preset: id, dark: structuredCloneSafe(p.dark), light: structuredCloneSafe(p.light), font: p.font ?? 'geist', radius: p.radius ?? 10, density: p.density ?? 'comfortable' };
}

/* ------------------------------------------------------------------------------------------------------------- validation */

const num = (v: unknown, name: string, lo: number, hi: number): number => {
  const x = Number(v);
  if (typeof v === 'boolean' || v === '' || v === null || !Number.isFinite(x) || x < lo || x > hi) throw new Error(`${name} must be a number from ${lo} to ${hi}`);
  return x;
};

/** Validates and normalises one palette. Throws an Error with a message fit for display. */
export function sanitizePalette(raw: unknown, label: string): PaletteInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} palette must be an object`);
  const r = raw as Record<string, unknown>;
  if (!isHex(r.accent)) throw new Error(`${label} accent must be a colour like #8fb596`);
  const out: PaletteInput = { accent: normalizeHex(r.accent), neutralHue: Math.round(num(r.neutralHue, `${label} tint hue`, 0, 360)), neutralChroma: Math.round(num(r.neutralChroma, `${label} tint strength`, 0, 0.04) * 10000) / 10000 };
  if (r.primary !== undefined && r.primary !== null && r.primary !== '') {
    if (!isHex(r.primary)) throw new Error(`${label} main button colour must be a colour like #ebe5d6`);
    out.primary = normalizeHex(r.primary);
  }
  if (r.contrast !== undefined) {
    if (r.contrast !== 'standard' && r.contrast !== 'high') throw new Error(`${label} contrast must be standard or high`);
    if (r.contrast === 'high') out.contrast = 'high';
  }
  if (r.overrides !== undefined && r.overrides !== null) {
    if (typeof r.overrides !== 'object' || Array.isArray(r.overrides)) throw new Error(`${label} overrides must be an object`);
    const o: Partial<Record<ColorToken, string>> = {};
    for (const [k, v] of Object.entries(r.overrides as Record<string, unknown>)) {
      if (!(COLOR_TOKENS as readonly string[]).includes(k)) throw new Error(`${label} overrides: “${k}” is not a colour setting`);
      if (!isHex(v)) throw new Error(`${label} overrides: ${k} must be a colour like #121211`);
      o[k as ColorToken] = normalizeHex(v);
    }
    if (Object.keys(o).length) out.overrides = o;
  }
  return out;
}

export function sanitizeThemeSpec(raw: unknown): ThemeSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Theme must be an object');
  const r = raw as Record<string, unknown>;
  const mode = r.mode;
  if (mode !== 'dark' && mode !== 'light' && mode !== 'system') throw new Error('Mode must be dark, light or system');
  if (typeof r.allowUserMode !== 'boolean') throw new Error('“People can switch themselves” must be on or off');
  const font = r.font;
  if (typeof font !== 'string' || !(font in FONTS)) throw new Error('Unknown font');
  const radius = Number(r.radius);
  if (!(RADII as readonly number[]).includes(radius)) throw new Error(`Corner radius must be one of ${RADII.join(', ')}`);
  const density = r.density;
  if (density !== 'compact' && density !== 'comfortable' && density !== 'spacious') throw new Error('Unknown density');
  const textScale = Number(r.textScale);
  if (!(TEXT_SCALES as readonly number[]).includes(textScale)) throw new Error(`Text size must be one of ${TEXT_SCALES.join(', ')}`);
  if (r.motion !== 'full' && r.motion !== 'reduced') throw new Error('Motion must be full or reduced');
  const preset = typeof r.preset === 'string' && (r.preset === 'custom' || presetById(r.preset)) ? r.preset : 'custom';
  return { mode, allowUserMode: r.allowUserMode, preset, dark: sanitizePalette(r.dark, 'Dark'), light: sanitizePalette(r.light, 'Light'), font: font as FontId, radius, density, textScale, motion: r.motion };
}

/** Full check of a theme: derivation plus the contrast report for each palette it can show. */
export function checkTheme(spec: ThemeSpec): { dark: Derived & Report; light: Derived & Report; errors: string[]; warnings: string[] } {
  const dark = derivePalette(spec.dark, 'dark'), light = derivePalette(spec.light, 'light');
  const rd = checkTokens(dark.tokens, spec.dark.contrast), rl = checkTokens(light.tokens, spec.light.contrast);
  const errors = [...rd.errors.map((e) => `Dark: ${e}`), ...rl.errors.map((e) => `Light: ${e}`)];
  const warnings = [...rd.warnings.map((e) => `Dark: ${e}`), ...rl.warnings.map((e) => `Light: ${e}`), ...dark.notes.map((n) => `Dark: ${n}`), ...light.notes.map((n) => `Light: ${n}`)];
  return { dark: { ...dark, ...rd }, light: { ...light, ...rl }, errors, warnings };
}

/* ------------------------------------------------------------------------------------------------------------- CSS output */

const declarations = (t: Partial<Tokens>) => Object.entries(t).map(([k, v]) => `--${k}:${v}`).join(';');

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/** True when the theme is exactly what the stylesheet already contains. */
export function isPristine(spec: ThemeSpec): boolean {
  return stable({ ...spec, preset: '' }) === stable({ ...defaultThemeSpec(), preset: '' });
}

/** Variables that are not colours, or an empty string when they are the stylesheet's own defaults. */
export function shapeDeclarations(spec: ThemeSpec): string {
  const parts: string[] = [];
  if (spec.radius !== 10) parts.push(`--radius-scale:${spec.radius / 10}`);
  if (spec.textScale !== 1) parts.push(`--text-scale:${spec.textScale}`);
  if (spec.density !== 'comfortable') parts.push(`--density:${DENSITIES[spec.density]}`);
  if (spec.font !== 'geist') parts.push(`--font-ui:${FONTS[spec.font].stack}`);
  return parts.join(';');
}

/**
 * The stylesheet for a theme. Colours are scoped by `data-mode` so a personal choice (cookie) can win over the administrator's
 * default; for the "system" setting a media query decides when no choice exists. The Fledge dark palette is already in the
 * stylesheet, so a default panel only receives the light palette (for people who switch to it). The base rules use `:root:root`
 * so they win over the stylesheet whatever order the browser loads the two in.
 */
export function themeCss(spec: ThemeSpec): string {
  const dark = derivePalette(spec.dark, 'dark').tokens, light = derivePalette(spec.light, 'light').tokens;
  const darkIsLegacy = stable(spec.dark) === stable(FLEDGE_DARK_INPUT);
  const out: string[] = [];
  const shape = shapeDeclarations(spec);
  if (shape) out.push(`:root:root{${shape}}`);
  const needBase = spec.mode === 'light' || !darkIsLegacy;
  if (needBase) out.push(`:root:root{color-scheme:${spec.mode === 'light' ? 'light' : 'dark'};${declarations(spec.mode === 'light' ? light : dark)}}`);
  if (spec.mode === 'system') out.push(`@media (prefers-color-scheme: light){:root:not([data-mode]){color-scheme:light;${declarations(light)}}}`);
  out.push(`:root[data-mode="light"]{color-scheme:light;${declarations(light)}}`);
  if (needBase) out.push(`:root[data-mode="dark"]{color-scheme:dark;${declarations(dark)}}`);
  if (spec.motion === 'reduced') out.push('@media (prefers-reduced-motion: no-preference){:root:root{--dur-1:0.01ms;--dur-2:0.01ms;--dur-3:0.01ms}}');
  return out.join('\n');
}

/** Edits a palette. Pinned tokens (from a preset or the advanced tab) are dropped unless the patch brings its own, so changing the accent has an effect. */
export function editPalette(p: PaletteInput, patch: Partial<PaletteInput>): PaletteInput {
  const next: PaletteInput = { ...p, ...patch };
  if (!('overrides' in patch)) delete next.overrides;
  if (next.primary === undefined || next.primary === '') delete next.primary;
  return next;
}

/** The mode a visitor sees: a personal choice if allowed, otherwise the administrator's setting. `system` resolves in the browser. */
export function effectiveMode(spec: Pick<ThemeSpec, 'mode' | 'allowUserMode'>, personal: string | undefined): Mode | 'system' {
  if (spec.allowUserMode && (personal === 'dark' || personal === 'light')) return personal;
  return spec.mode;
}
