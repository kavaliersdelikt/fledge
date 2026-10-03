// Run with: npx tsx --test shared/theme.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COLOR_TOKENS, FLEDGE_DARK_TOKENS, PRESETS, applyPreset, checkTheme, checkTokens, contrast, defaultThemeSpec, derivePalette, editPalette, effectiveMode,
  ensureContrast, hexToOklch, isHex, isPristine, normalizeHex, oklchToHex, sanitizePalette, sanitizeThemeSpec, themeCss,
} from './theme.ts';

test('contrast matches known WCAG values', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
  assert.ok(Math.abs(contrast('#767676', '#ffffff') - 4.54) < 0.02);
  assert.equal(contrast('#123456', '#123456'), 1);
});

test('hex and OKLCH round trip within one step per channel', () => {
  for (const hex of ['#8fb596', '#ebe5d6', '#0b0b0a', '#f26a5c', '#3558d6', '#ffffff', '#000000']) {
    const back = oklchToHex(hexToOklch(hex));
    const d = [1, 3, 5].map((i) => Math.abs(parseInt(hex.slice(i, i + 2), 16) - parseInt(back.slice(i, i + 2), 16)));
    assert.ok(Math.max(...d) <= 1, `${hex} -> ${back}`);
  }
});

test('hex helpers', () => {
  assert.equal(normalizeHex('#ABC'), '#aabbcc');
  assert.ok(isHex('#a1b2c3') && isHex('#abc'));
  for (const bad of ['red', '#12', '#12345', '#gggggg', 12, null, 'rgb(1,2,3)', '#1234567']) assert.equal(isHex(bad), false, String(bad));
});

test('ensureContrast reaches the target in the right direction', () => {
  const lighter = ensureContrast('#303030', '#0b0b0a', 4.5);
  assert.ok(contrast(lighter, '#0b0b0a') >= 4.5 && hexToOklch(lighter).L > hexToOklch('#303030').L);
  const darker = ensureContrast('#cccccc', '#ffffff', 4.5);
  assert.ok(contrast(darker, '#ffffff') >= 4.5 && hexToOklch(darker).L < hexToOklch('#cccccc').L);
  assert.equal(ensureContrast('#000000', '#ffffff', 4.5), '#000000');
});

test('the Fledge dark tokens are exactly what the stylesheet contains', () => {
  assert.equal(FLEDGE_DARK_TOKENS.bg, '#0b0b0a');
  assert.equal(FLEDGE_DARK_TOKENS.accent, '#8fb596');
  const r = checkTokens(FLEDGE_DARK_TOKENS);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('every preset passes the contrast floors in both modes, with no adjusted accents', () => {
  for (const p of PRESETS) for (const mode of ['dark', 'light'] as const) {
    const input = mode === 'dark' ? p.dark : p.light;
    const d = derivePalette(input, mode);
    const r = checkTokens(d.tokens, input.contrast);
    assert.deepEqual(r.errors, [], `${p.id} ${mode}`);
    assert.deepEqual(d.notes, [], `${p.id} ${mode} accent was adjusted`);
    for (const t of COLOR_TOKENS) assert.match(d.tokens[t], /^#[0-9a-f]{6}$/, `${p.id} ${mode} ${t}`);
  }
});

test('calculated palettes keep even hints and placeholders at 4.5:1 on every surface', () => {
  for (const p of PRESETS.filter((x) => x.id !== 'fledge')) for (const mode of ['dark', 'light'] as const) {
    const t = derivePalette(mode === 'dark' ? p.dark : p.light, mode).tokens;
    for (const surface of ['bg', 'surface', 'surface-2', 'surface-3', 'raised'] as const) assert.ok(contrast(t['text-3'], t[surface]) >= 4.5, `${p.id} ${mode} ${surface}`);
  }
  const light = derivePalette(PRESETS[0].light, 'light').tokens;
  assert.ok(contrast(light['text-3'], light['surface-3']) >= 4.5);
});

test('a hostile accent is adjusted until it is readable instead of failing', () => {
  const d = derivePalette({ accent: '#1a1a1a', neutralHue: 96, neutralChroma: 0.01 }, 'dark');
  assert.ok(contrast(d.tokens.accent, d.tokens.surface) >= 4.5);
  assert.equal(d.notes.length, 1);
  const l = derivePalette({ accent: '#f5f5a0', neutralHue: 96, neutralChroma: 0.01 }, 'light');
  assert.ok(contrast(l.tokens.accent, l.tokens['surface-3']) >= 4.5);
});

test('every derived palette keeps body text readable for any tint', () => {
  for (const hue of [0, 45, 96, 150, 210, 262, 300, 340]) for (const chroma of [0, 0.01, 0.04]) for (const mode of ['dark', 'light'] as const) {
    const d = derivePalette({ accent: '#7a5cff', neutralHue: hue, neutralChroma: chroma }, mode);
    const r = checkTokens(d.tokens);
    assert.deepEqual(r.errors, [], `${mode} hue ${hue} chroma ${chroma}`);
  }
});

test('pinned tokens that fail are reported as errors', () => {
  const d = derivePalette({ accent: '#8fb596', neutralHue: 96, neutralChroma: 0.01, overrides: { text: '#3a3a36' } }, 'dark');
  const r = checkTokens(d.tokens);
  assert.ok(r.errors.some((e) => e.startsWith('Text on the page background')), r.errors.join('|'));
});

test('high contrast raises the floors', () => {
  const p = PRESETS.find((x) => x.id === 'contrast')!;
  const d = derivePalette(p.dark, 'dark');
  assert.ok(contrast(d.tokens.text, d.tokens.bg) >= 7);
  assert.ok(contrast(d.tokens['text-2'], d.tokens.surface) >= 7);
  assert.ok(contrast(d.tokens['border-strong'], d.tokens.surface) >= 3);
});

test('editing a palette drops pinned tokens so the change takes effect', () => {
  const fledge = PRESETS[0].dark;
  assert.ok(fledge.overrides);
  const edited = editPalette(fledge, { accent: '#ff8800' });
  assert.equal(edited.overrides, undefined);
  assert.notEqual(derivePalette(edited, 'dark').tokens.accent, FLEDGE_DARK_TOKENS.accent);
  const kept = editPalette(fledge, { overrides: { bg: '#000000' } });
  assert.equal(kept.overrides?.bg, '#000000');
});

test('the default spec is pristine and only ships the light palette', () => {
  const spec = defaultThemeSpec();
  assert.ok(isPristine(spec));
  const css = themeCss(spec);
  assert.match(css, /^:root\[data-mode="light"\]\{/);
  assert.doesNotMatch(css, /data-mode="dark"/);
  assert.doesNotMatch(css, /--radius-scale|--text-scale|--font-ui/);
});

test('a changed spec is not pristine and emits shape and colour', () => {
  let spec = applyPreset(defaultThemeSpec(), 'terminal');
  spec = { ...spec, mode: 'system' };
  assert.equal(isPristine(spec), false);
  const css = themeCss(spec);
  assert.match(css, /--radius-scale:0/);
  assert.match(css, /--font-ui:"Geist Mono Variable"/);
  assert.match(css, /@media \(prefers-color-scheme: light\)\{:root:not\(\[data-mode\]\)/);
  assert.match(css, /:root\[data-mode="dark"\]/);
});

test('light as default mode emits a base block', () => {
  const css = themeCss({ ...defaultThemeSpec(), mode: 'light' });
  assert.match(css, /^:root:root\{color-scheme:light;/m);
  assert.match(css, /:root\[data-mode="dark"\]/);
});

test('effective mode honours the personal choice only when allowed', () => {
  assert.equal(effectiveMode({ mode: 'dark', allowUserMode: true }, 'light'), 'light');
  assert.equal(effectiveMode({ mode: 'dark', allowUserMode: false }, 'light'), 'dark');
  assert.equal(effectiveMode({ mode: 'system', allowUserMode: true }, undefined), 'system');
  assert.equal(effectiveMode({ mode: 'system', allowUserMode: true }, 'nonsense'), 'system');
});

test('palette validation rejects bad input with readable messages', () => {
  assert.throws(() => sanitizePalette({ accent: 'green', neutralHue: 1, neutralChroma: 0 }, 'Dark'), /accent must be a colour/);
  assert.throws(() => sanitizePalette({ accent: '#112233', neutralHue: 400, neutralChroma: 0 }, 'Dark'), /tint hue must be a number from 0 to 360/);
  assert.throws(() => sanitizePalette({ accent: '#112233', neutralHue: 1, neutralChroma: 0.5 }, 'Dark'), /tint strength/);
  assert.throws(() => sanitizePalette({ accent: '#112233', neutralHue: 1, neutralChroma: 0, overrides: { evil: '#000000' } }, 'Dark'), /not a colour setting/);
  assert.throws(() => sanitizePalette({ accent: '#112233', neutralHue: 1, neutralChroma: 0, overrides: { bg: 'url(x)' } }, 'Dark'), /must be a colour/);
  assert.throws(() => sanitizePalette({ accent: '#112233', neutralHue: 1, neutralChroma: 0, primary: 'javascript:1' }, 'Dark'), /main button colour/);
  assert.throws(() => sanitizePalette(null, 'Dark'), /must be an object/);
  const ok = sanitizePalette({ accent: '#ABC', neutralHue: 96.4, neutralChroma: 0.01, primary: '' }, 'Dark');
  assert.deepEqual(ok, { accent: '#aabbcc', neutralHue: 96, neutralChroma: 0.01 });
});

test('theme validation covers every field', () => {
  const good = defaultThemeSpec();
  assert.deepEqual(sanitizeThemeSpec(JSON.parse(JSON.stringify(good))), good);
  for (const [patch, message] of [
    [{ mode: 'auto' }, /Mode must be/], [{ font: 'comic' }, /Unknown font/], [{ radius: 11 }, /Corner radius/], [{ density: 'tight' }, /Unknown density/],
    [{ textScale: 3 }, /Text size/], [{ motion: 'some' }, /Motion/], [{ allowUserMode: 'yes' }, /switch themselves/],
  ] as [Record<string, unknown>, RegExp][]) assert.throws(() => sanitizeThemeSpec({ ...good, ...patch }), message);
});

test('checkTheme reports derived tokens for both modes', () => {
  const r = checkTheme(defaultThemeSpec());
  assert.deepEqual(r.errors, []);
  assert.equal(r.dark.tokens.bg, '#0b0b0a');
  assert.ok(r.light.tokens.bg.startsWith('#f'));
});
