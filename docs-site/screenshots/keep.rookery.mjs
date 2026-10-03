// Like keep.mjs, but with the 0.7.1.1 features seeded (plans, store, subscriptions, sign-ups). Writes demo-session.json.
//   NEXT_PUBLIC_API_URL=http://localhost:4300 npm run build   (in web/)
//   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres node screenshots/keep.rookery.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { bootRookery, seedRookery, seedDemo, ADMIN, API, CUSTOMER } from './rookery-demo.mjs';
import { sleep } from '../../api/test/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { authenticator } = createRequire(join(here, '..', '..', 'api', 'package.json'))('otplib');
const demo = await bootRookery();
const seeded = await seedDemo(demo);
await seedRookery(demo, seeded);
await sleep(2500);
const step = await fetch(API + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password, stepwise: true }) }).then((r) => r.json());
const res = await fetch(API + '/api/auth/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challenge: step.challenge, code: authenticator.generate(seeded.totpSecret) }) });
const cookie = /fledge_session=([^;]+)/.exec(res.headers.get('set-cookie') || '')?.[1];
const cres = await fetch(API + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: CUSTOMER.email, password: CUSTOMER.password }) });
const ccookie = /fledge_session=([^;]+)/.exec(cres.headers.get('set-cookie') || '')?.[1];
writeFileSync(process.env.KEEP_FILE || join(here, 'demo-session.json'), JSON.stringify({ cookie: decodeURIComponent(cookie), customerCookie: decodeURIComponent(ccookie || ''), totpSecret: seeded.totpSecret, admin: ADMIN, customer: CUSTOMER }));
console.log('demo ready');
process.on('SIGINT', async () => { await demo.stop(); process.exit(0); });
await new Promise(() => {});
