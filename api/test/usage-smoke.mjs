import {generateKeyPairSync} from 'node:crypto';
import {bootStack,client,bootstrapAdmin,dbQuery,sleep} from './harness.mjs';
const {publicKey}=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const stack=await bootStack({db:'fledge_usage_smoke',apiPort:4192,hostPort:4542,mock:null,apiEnv:{USAGE_INTAKE_REPOSITORY:'example/fledge-intake',USAGE_GITHUB_CLIENT_ID:'Iv1.example1234',USAGE_INTAKE_PUBLIC_KEY:Buffer.from(publicKey).toString('base64'),SWEEP_INTERVAL_MS:'500'}}),admin=client(stack.base);
try{
 await bootstrapAdmin(admin);let state=admin.ok(await admin.call('GET','/api/usage'),'default reporting');admin.check(!state.consent&&!state.connected&&state.configured&&state.repository==='example/fledge-intake','reporting is disabled and intake settings are available');
 admin.status(await admin.call('PUT','/api/usage/config',{repository:'bad repo',clientId:'short',publicKeyBase64:'invalid'}),400,'invalid intake settings refused');
 state=admin.ok(await admin.call('PUT','/api/usage/config',{repository:'example/alternate-intake',clientId:'Iv1.example1234',publicKeyBase64:Buffer.from(publicKey).toString('base64')}),'panel intake configuration');admin.check(state.configured&&state.repository==='example/alternate-intake','panel settings replace environment coordinates');
 admin.status(await admin.call('POST','/api/usage/consent',{consent:true,noticeVersion:0}),400,'stale notice refused');
 admin.ok(await admin.call('POST','/api/usage/consent',{consent:true,noticeVersion:1}),'explicit consent');state=admin.ok(await admin.call('GET','/api/usage'),'consent state');admin.check(state.consent&&!state.connected&&!('installation_id' in state)&&!('secret' in state),'consent alone sends no data and returns no identifier or credentials');
 const customer=admin.ok(await admin.call('POST','/api/customers',{email:'usage-owner@example.test'}),'customer'),owner=client(stack.base);owner.ok(await owner.call('POST','/api/auth/login',{email:customer.email,password:customer.temporaryPassword}),'login');owner.status(await owner.call('GET','/api/usage'),403,'customer cannot manage reporting');
 admin.ok(await admin.call('POST','/api/usage/consent',{consent:false,noticeVersion:1}),'withdraw');await sleep(1500);const row=(await dbQuery(stack.databaseUrl,'SELECT * FROM usage_reporting WHERE singleton'))[0];admin.check(!row.consent&&!row.secret&&!row.installation_id,'withdrawal clears a disconnected installation');
 console.log('Usage reporting consent smoke passed');
}finally{await stack.stop()}
