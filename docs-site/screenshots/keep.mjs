// Starts the seeded demo stack (API on 4300, panel on 3100) and keeps it running, for looking at the panel by hand or with
// other scripts. It writes the signed-in session cookie to $KEEP_FILE (default demo-session.json next to this file).
//
//   NEXT_PUBLIC_API_URL=http://localhost:4300 npm run build   (in web/)
//   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres node screenshots/keep.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { bootDemo, seedDemo, ADMIN, API } from './demo.mjs';
import { sleep } from '../../api/test/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { authenticator } = createRequire(join(here, '..', '..', 'api', 'package.json'))('otplib');
const demo = await bootDemo();
const seeded = await seedDemo(demo);
await sleep(2500);
const step = await fetch(API + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password, stepwise: true }) }).then((r) => r.json());
const res = await fetch(API + '/api/auth/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challenge: step.challenge, code: authenticator.generate(seeded.totpSecret) }) });
const cookie = /fledge_session=([^;]+)/.exec(res.headers.get('set-cookie') || '')?.[1];
writeFileSync(process.env.KEEP_FILE || join(here, 'demo-session.json'), JSON.stringify({ cookie: decodeURIComponent(cookie), totpSecret: seeded.totpSecret, admin: ADMIN }));
console.log('demo ready');
process.on('SIGINT', async () => { await demo.stop(); process.exit(0); });
await new Promise(() => {});
