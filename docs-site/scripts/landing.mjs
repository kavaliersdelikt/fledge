// The landing page is hand-written HTML outside VitePress (landing/). This script either copies it into the built site
// (`node scripts/landing.mjs build`, run after `vitepress build`) or serves it for development (`node scripts/landing.mjs`),
// with docs/public behind it for the screenshots and the logo.
import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const landing = join(root, 'landing');
const pub = join(root, 'docs', 'public');
const dist = join(root, 'docs', '.vitepress', 'dist');

if (process.argv[2] === 'build') {
  if (!existsSync(dist)) { console.error('Run `vitepress build docs` first.'); process.exit(1); }
  cpSync(landing, dist, { recursive: true });
  console.log('landing page copied into', dist);
} else {
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain' };
  const port = Number(process.env.PORT || 4173);
  createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const rel = normalize(path).replace(/^([\\/])+/, '');
    for (const base of [landing, pub]) {
      const file = join(base, rel);
      if (file.startsWith(base) && existsSync(file) && statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(readFileSync(file));
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not here in landing dev; documentation pages need `npm run dev`.');
  }).listen(port, () => console.log(`landing page on http://localhost:${port}/`));
}
