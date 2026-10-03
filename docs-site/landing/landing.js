import { startBlackHole } from './blackhole.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- Black hole ----------
const canvas = $('#bh');
const state = { scroll: 0, mx: 0, my: 0 };
const bh = startBlackHole(canvas, state, { still: reduced });
if (!bh) document.documentElement.classList.add('no-webgl');
canvas.addEventListener('blackhole-lost', () => document.documentElement.classList.add('no-webgl'));

let paused = reduced;
const toggle = $('#bh-toggle');
if (!bh) toggle.hidden = true;
if (reduced) toggle.textContent = 'Animate it';
toggle.addEventListener('click', () => {
  if (!bh) return;
  paused = !paused;
  toggle.textContent = paused ? 'Animate it' : 'Pause it';
  if (paused) bh.pause(); else bh.resume();
});

addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  state.mx = (e.clientX / innerWidth) * 2 - 1;
  state.my = (e.clientY / innerHeight) * 2 - 1;
}, { passive: true });

// Scroll: tilt the camera over the first screen, then let the hole fade into the background.
const nav = $('#nav');
let ticking = false;
function onScroll() {
  ticking = false;
  const h = innerHeight;
  const y = scrollY;
  state.scroll = Math.min(1, y / h);
  nav.classList.toggle('scrolled', y > 24);
  const fade = Math.min(1, Math.max(0, (y - h * 0.35) / (h * 0.9)));
  canvas.style.opacity = String(1 - fade * 0.84);
  if (!bh) return;
  // Once the hole has faded behind the content a still frame is enough; stop spending GPU time on it.
  if (paused) { if (reduced) bh.redraw(); }
  else if (fade >= 1) bh.pause();
  else bh.resume();
}
addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
onScroll();

// ---------- Tabs (shared keyboard behaviour) ----------
function tabs(list, onSelect) {
  const buttons = $$('[role=tab]', list);
  const select = (b, focus) => {
    buttons.forEach((x) => { const on = x === b; x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1; });
    if (focus) b.focus();
    onSelect(b);
  };
  buttons.forEach((b, i) => {
    b.addEventListener('click', () => select(b, false));
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      select(buttons[(i + d + buttons.length) % buttons.length], true);
    });
  });
}

// ---------- Install command ----------
const commands = {
  sh: 'git clone --depth 1 --branch main https://github.com/kavaliersdelikt/fledge.git fledge && cd fledge && sh ./install.sh',
  ps: "git clone --depth 1 --branch main https://github.com/kavaliersdelikt/fledge.git fledge; if ($LASTEXITCODE -ne 0) { throw 'Download failed.' }; Set-Location fledge; if (-not $?) { throw 'Could not enter the install folder.' }; powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\install.ps1; if ($LASTEXITCODE -ne 0) { throw 'Install failed.' }",
};
const cmd = $('#cmd');
const panel = cmd.closest('[role=tabpanel]');
if (/Win/.test(navigator.platform || navigator.userAgent)) {
  cmd.textContent = commands.ps;
  $('#tab-sh').setAttribute('aria-selected', 'false'); $('#tab-sh').tabIndex = -1;
  $('#tab-ps').setAttribute('aria-selected', 'true'); $('#tab-ps').tabIndex = 0;
  panel.setAttribute('aria-labelledby', 'tab-ps');
}
tabs($('.install-tabs'), (b) => { cmd.textContent = commands[b.dataset.os]; cmd.scrollLeft = 0; panel.setAttribute('aria-labelledby', b.id); });

const copy = $('#copy');
copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(cmd.textContent);
    copy.textContent = 'Copied'; copy.classList.add('done');
  } catch {
    const r = document.createRange(); r.selectNodeContents(cmd);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    copy.textContent = 'Selected';
  }
  setTimeout(() => { copy.textContent = 'Copy'; copy.classList.remove('done'); }, 1800);
});

// ---------- Product tour ----------
const shots = [
  { src: 'server-console', url: 'servers/survival', alt: 'Server page with a live console and CPU, memory and disk gauges', cap: 'A live console that keeps its history, next to CPU, memory and disk for the server.' },
  { src: 'addons-browse', url: 'servers/fabric-smp/mods', alt: 'Browsing Fabric mods from Modrinth on a server page', cap: 'Browse Modrinth from the server page. Dependencies are worked out before anything is installed.' },
  { src: 'schedule-editor', url: 'servers/survival/schedules', alt: 'Schedule editor with chained steps', cap: 'Chain steps into a schedule: warn players, wait, back up, restart. Missed runs are skipped or run once.' },
  { src: 'usage-history', url: 'servers/survival/usage', alt: 'CPU and memory history charts', cap: 'CPU and memory history from the last hour to the last 30 days.' },
  { src: 'nodes', url: 'nodes', alt: 'Nodes with reserved capacity and disk limits', cap: 'Every node with what it has reserved, its agent version and its last heartbeat.' },
  { src: 'plugins-store', url: 'plugins', alt: 'The plugin store', cap: 'The plugin store, with trust tiers and a permission review before anything runs.' },
];
const img = $('#tour-img'), cap = $('#tour-caption'), url = $('#frame-url');
shots.forEach((s) => { const i = new Image(); i.src = `screenshots/${s.src}.webp`; });
tabs($('.tour-tabs'), (b) => {
  const s = shots[Number(b.dataset.i)];
  img.classList.add('swap');
  setTimeout(() => {
    img.src = `screenshots/${s.src}.webp`; img.alt = s.alt;
    url.textContent = `panel.example.org/${s.url}`; cap.textContent = s.cap;
    img.classList.remove('swap');
  }, reduced ? 0 : 180);
});

// ---------- Example themes ----------
const themes = [
  { src: 'theme-lumen', url: 'panel.lumen.example/servers', alt: 'The server list in the Lumen Hosting theme: dark with a teal accent, the page renamed to Worlds, extra sidebar links and an announcement', cap: 'Lumen Hosting: its own logo, a teal accent, “Servers” renamed to “Worlds”, a status link and a maintenance banner.' },
  { src: 'theme-paper', url: 'panel.paperplane.example/servers', alt: 'The server list in the Paperplane theme: light, warm white with a deep green accent', cap: 'Paperplane: the Paper preset in its light version. Every person can still switch to dark for themselves.' },
  { src: 'theme-ember', url: 'panel.ember.example/instances', alt: 'The server list in the Ember Servers theme: warm dark with an orange accent, Inter as the font, and the page renamed to Instances', cap: 'Ember Servers: warm dark, an orange accent, Inter, slightly tighter corners and “Instances” instead of “Servers”.' },
  { src: 'theme-terminal', url: 'node.garden/machines', alt: 'The server list in the node.garden theme: black with phosphor green, a monospace font, square corners and compact rows', cap: 'node.garden: the Terminal preset. Monospace, square corners and compact rows, with the page renamed to “Machines”.' },
];
const bimg = $('#brand-img'), bcap = $('#brand-caption'), burl = $('#brand-url');
themes.forEach((s) => { const i = new Image(); i.src = `screenshots/${s.src}.webp`; });
tabs($('.brand-tabs'), (b) => {
  const s = themes[Number(b.dataset.i)];
  bimg.classList.add('swap');
  setTimeout(() => {
    bimg.src = `screenshots/${s.src}.webp`; bimg.alt = s.alt;
    burl.textContent = s.url; bcap.textContent = s.cap;
    bimg.classList.remove('swap');
  }, reduced ? 0 : 180);
});

// A small tilt that follows the pointer while it is over a screenshot.
if (!reduced) {
  for (const frame of $$('.frame')) {
    frame.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const r = frame.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      frame.style.setProperty('--ry', `${x * 5}deg`);
      frame.style.setProperty('--rx', `${-y * 4}deg`);
    });
    frame.addEventListener('pointerleave', () => { frame.style.setProperty('--rx', '0deg'); frame.style.setProperty('--ry', '0deg'); });
  }
}

// ---------- Orbit diagram ----------
const NS = 'http://www.w3.org/2000/svg';
const el = (n, a = {}, parent) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); parent?.appendChild(e); return e; };
const nodes = [
  { name: 'frankfurt-01', meta: '3 servers', r: 150, a: 0.4, w: 0.05 },
  { name: 'helsinki-01', meta: '2 servers', r: 215, a: 2.6, w: 0.032 },
  { name: 'ashburn-01', meta: '1 server', r: 275, a: 4.5, w: 0.022 },
];
const gLinks = $('#links'), gNodes = $('#nodes');
for (const n of nodes) {
  n.line = el('line', { class: 'link-line' }, gLinks);
  n.pulses = [0, 0.5].map(() => el('circle', { class: 'pulse', r: 2.6 }, gLinks));
  n.g = el('g', {}, gNodes);
  el('circle', { class: 'node-dot', r: 9 }, n.g);
  el('circle', { r: 3, fill: '#8fd8ff' }, n.g);
  n.t1 = el('text', { class: 'node-name', x: 16, y: -2 }, n.g); n.t1.textContent = n.name;
  n.t2 = el('text', { class: 'node-meta', x: 16, y: 14 }, n.g); n.t2.textContent = n.meta;
}
let orbitVisible = false, orbitRaf = 0, orbitLast = performance.now(), orbitT = 0;
function drawOrbit(now) {
  const dt = Math.min(0.05, (now - orbitLast) / 1000); orbitLast = now;
  if (!reduced) orbitT += dt;
  for (const n of nodes) {
    const a = n.a + orbitT * n.w;
    const x = Math.cos(a) * n.r, y = Math.sin(a) * n.r;
    n.g.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
    // Keep the label outside the diagram on the left half.
    const left = x < -40;
    n.t1.setAttribute('x', left ? -16 : 16); n.t2.setAttribute('x', left ? -16 : 16);
    n.t1.setAttribute('text-anchor', left ? 'end' : 'start'); n.t2.setAttribute('text-anchor', left ? 'end' : 'start');
    const k = 84 / n.r; // stop the line at the edge of the panel's glow
    n.line.setAttribute('x1', x); n.line.setAttribute('y1', y);
    n.line.setAttribute('x2', x * k); n.line.setAttribute('y2', y * k);
    // Pulses travel from the agent toward the panel: the connection is opened by the node.
    n.pulses.forEach((p, i) => {
      const f = reduced ? 0.5 : ((orbitT * 0.45 + i * 0.5 + n.w * 10) % 1);
      p.setAttribute('cx', (x * (1 - f) + x * k * f).toFixed(1));
      p.setAttribute('cy', (y * (1 - f) + y * k * f).toFixed(1));
      p.setAttribute('opacity', (Math.sin(f * Math.PI) * 0.95).toFixed(2));
    });
  }
  if (orbitVisible && !reduced) orbitRaf = requestAnimationFrame(drawOrbit);
}
drawOrbit(performance.now());
new IntersectionObserver(([e]) => {
  orbitVisible = e.isIntersecting;
  cancelAnimationFrame(orbitRaf);
  if (orbitVisible && !reduced) { orbitLast = performance.now(); orbitRaf = requestAnimationFrame(drawOrbit); }
}).observe($('#orbit'));
