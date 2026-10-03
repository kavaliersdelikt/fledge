// Boots a throw-away API (real code, empty database) and saves its OpenAPI description to generated/openapi.json.
// Needs PostgreSQL: set TEST_DATABASE_URL to a superuser connection such as postgres://user:pass@localhost:5432/postgres.
//
//   cd api && npm ci && cd ../plugins/host && npm ci && cd ../../docs-site && npm run snapshot
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootStack, client, bootstrapAdmin } from '../../api/test/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const stack = await bootStack({ db: 'fledge_docs_openapi', apiPort: 4291, hostPort: 4592 });
try {
  const c = client(stack.base);
  await bootstrapAdmin(c, 'docs');
  const spec = c.ok(await c.call('GET', '/api/openapi.json'), 'openapi');
  mkdirSync(join(here, '..', 'generated'), { recursive: true });
  writeFileSync(join(here, '..', 'generated', 'openapi.json'), JSON.stringify(spec, null, 1));
  console.log(`Saved the OpenAPI description (${Object.keys(spec.paths).length} paths, version ${spec.info.version}).`);
} finally {
  await stack.stop();
}
process.exit(0);
