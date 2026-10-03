// Runs the example plugins from the docs for real: the manifest must validate against the panel's own rules, the package must
// build with the pack tool, and every catalog method must work inside the actual plugin sandbox. If the plugin API changes in
// a way that breaks the tutorial, this fails before the docs ship.
//
//   api/node_modules/.bin/tsx docs-site/scripts/check-examples.ts
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../../api/src/plugins/manifest.ts';
import { runPlugin } from '../../plugins/host/src/sandbox.ts';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', 'examples');
const pack = join(here, '..', '..', 'plugins', 'tools', 'pack.mjs');

const catalog = {
  items: [
    { id: 'hello-mod', title: 'Hello Mod', summary: 'Says hello.', version: '1.2.0', gameVersions: ['1.21.4'], loaders: ['fabric'], file: { url: 'https://downloads.example.org/hello-mod-1.2.0.jar', sha512: 'a'.repeat(128), size: 1234 } },
    { id: 'forge-only', title: 'Forge Only', summary: 'Needs Forge.', version: '2.0.0', gameVersions: ['1.21.4'], loaders: ['forge'], file: { url: 'https://downloads.example.org/forge-only-2.0.0.jar', sha512: 'b'.repeat(128), size: 99 } },
  ],
};

const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(catalog)); });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;

let checked = 0;
try {
  for (const name of readdirSync(examples)) {
    const dir = join(examples, name);
    if (!existsSync(join(dir, 'fledge-plugin.json'))) continue;
    const manifest = validateManifest(JSON.parse(readFileSync(join(dir, 'fledge-plugin.json'), 'utf8')));
    const out = mkdtempSync(join(tmpdir(), 'fledge-example-'));
    execFileSync(process.execPath, [pack, 'pack', dir, '--out', out], { stdio: 'pipe' });
    assert.ok(readdirSync(out).some((f) => f === `${manifest.id}-${manifest.version}.fledgeplugin`), `${name}: package was not built`);

    const code = readFileSync(join(dir, 'index.js'), 'utf8');
    const call = (method: string, args: unknown[]) => runPlugin({
      code, method, args, plugin: { id: manifest.id, version: manifest.version },
      settings: { indexUrl: `http://127.0.0.1:${port}/catalog.json` }, storage: {}, network: ['127.0.0.1'], guard: { allowPrivate: true, allowHttp: true },
    });
    const target = { kind: 'mod', loaders: ['fabric'], gameVersion: '1.21.4', type: 'FABRIC' };

    assert.equal(((await call('healthCheck', [])).result as any).ok, true);
    const found: any = (await call('search', [{ query: '', offset: 0, limit: 24 }, target])).result;
    assert.deepEqual(found.items.map((i: any) => i.id), ['hello-mod'], 'search is filtered for the server loader');
    assert.equal(((await call('search', [{ query: 'zzz', offset: 0, limit: 24 }, target])).result as any).total, 0);
    const versions: any = (await call('versions', ['hello-mod', target])).result;
    assert.equal(versions[0].files[0].filename, 'hello-mod-1.2.0.jar');
    const resolved: any = (await call('resolve', [{ projectId: 'hello-mod' }, target])).result;
    assert.match(resolved.files[0].sha512, /^[a-f0-9]{128}$/);
    assert.equal(resolved.files[0].url, 'https://downloads.example.org/hello-mod-1.2.0.jar');
    const updates: any = (await call('updates', [{ items: [{ projectId: 'hello-mod', versionId: '1.0.0', sha512: 'x' }] }, target])).result;
    assert.equal(updates[0].latest.id, '1.2.0');
    checked++;
  }
} finally {
  server.close();
}
console.log(`PASS ${checked} example plugin(s): manifest, package and every catalog method`);
