import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPublicKey,generateKeyPairSync} from 'node:crypto';
import {sealUsageReport,openUsageReport,validateUsageReport,type UsageReport} from '../../shared/usage-envelope.js';
// @ts-ignore Node/tsx executes the collector's real TypeScript dependency.
import {updateUsageState,usageSummary,usageDashboard} from '../../scripts/usage-collector.mjs';
import {USAGE_DEFAULT_CLIENT_ID,USAGE_DEFAULT_PUBLIC_KEY,USAGE_DEFAULT_REPOSITORY} from '../src/usage-defaults.js';
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const report:UsageReport={schema:1,kind:'heartbeat',id:'a'.repeat(43),day:'2026-10-04',version:'0.9.1.2'};
test('the release includes valid public intake defaults without requiring environment values',()=>{const key=createPublicKey(Buffer.from(USAGE_DEFAULT_PUBLIC_KEY,'base64').toString());assert.equal(USAGE_DEFAULT_REPOSITORY,'kavaliersdelikt/fledge-usage-intake');assert.match(USAGE_DEFAULT_CLIENT_ID,/^[A-Za-z0-9_.]{10,128}$/);assert.equal(key.asymmetricKeyType,'rsa');assert.ok((key.asymmetricKeyDetails?.modulusLength||0)>=2048)});
test('usage reports are authenticated ciphertext, not public version or installation records',()=>{
 const a=sealUsageReport(report,publicKey),b=sealUsageReport(report,publicKey);assert.notEqual(a.data,b.data);assert.deepEqual(openUsageReport(a,privateKey),report);assert.ok(!JSON.stringify(a).includes(report.id));assert.ok(!JSON.stringify(a).includes(report.version));
 assert.throws(()=>openUsageReport({...a,tag:'a'.repeat(22)},privateKey));assert.throws(()=>openUsageReport({...a,unexpected:true},privateKey));
});
test('usage protocol rejects identity additions, invalid versions and invalid dates',()=>{
 assert.throws(()=>validateUsageReport({...report,email:'private@example.test'}));assert.throws(()=>validateUsageReport({...report,version:'<script>'}));assert.throws(()=>validateUsageReport({...report,day:'2026-02-30'}));
});
test('collector deduplicates daily retries, applies latest versions, expires records and honors withdrawal replays',()=>{
 const now=new Date('2026-10-04T12:00:00Z');let state=updateUsageState(null,report,now);state=updateUsageState(state,report,now);assert.equal(usageSummary(state,now).active.day,1);
 state=updateUsageState(state,{...report,version:'0.9.1.2'},now);assert.deepEqual(usageSummary(state,now).versions.week,{'0.9.1.2':1});state=updateUsageState(state,{...report,version:'0.9.1.3'},now,200);state=updateUsageState(state,report,now,100);assert.deepEqual(usageSummary(state,now).versions.week,{'0.9.1.3':1});
 state=updateUsageState(state,{...report,id:'b'.repeat(43),day:'2026-10-01'},now);assert.equal(usageSummary(state,now).active.week,2);
 state=updateUsageState(state,{schema:1,kind:'withdraw',id:report.id,day:report.day},now);state=updateUsageState(state,report,now);assert.equal(usageSummary(state,now).active.day,0);assert.ok(!state.reports[report.id]);
 state=updateUsageState(state,{...report,id:'c'.repeat(43),day:'2026-11-05'},new Date('2026-11-05T00:00:00Z'));assert.equal(usageSummary(state,new Date('2026-11-05')).active.month,1);assert.ok(!state.reports['b'.repeat(43)]);
 assert.ok(usageDashboard(usageSummary(state,new Date('2026-11-05'))).includes('does not count individual people'));
});
