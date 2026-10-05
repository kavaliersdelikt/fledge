import {constants,createCipheriv,createDecipheriv,createPublicKey,privateDecrypt,publicEncrypt,randomBytes} from 'node:crypto';
export type UsageReport={schema:1;kind:'heartbeat'|'withdraw';id:string;day:string;version?:string};
export type UsageEnvelope={schema:1;key:string;iv:string;tag:string;data:string};
export function validateUsageReport(value:unknown):UsageReport {
 const r=value as UsageReport;
 if(!r||r.schema!==1||!['heartbeat','withdraw'].includes(r.kind)||!/^[A-Za-z0-9_-]{43}$/.test(r.id)||!/^\d{4}-\d{2}-\d{2}$/.test(r.day)||!Number.isFinite(Date.parse(r.day+'T00:00:00Z'))||new Date(r.day).toISOString().slice(0,10)!==r.day||r.kind==='heartbeat'&&!/^\d+\.\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.]+)?$/.test(r.version||''))throw Error('Invalid usage report');
 if(Object.keys(r).some(k=>!['schema','kind','id','day','version'].includes(k)))throw Error('Unexpected usage report field');
 return r;
}
export function sealUsageReport(report:UsageReport,pem:string):UsageEnvelope {
 validateUsageReport(report);const publicKey=createPublicKey(pem);
 if(publicKey.asymmetricKeyType!=='rsa'||(publicKey.asymmetricKeyDetails?.modulusLength||0)<2048)throw Error('Usage intake requires an RSA key of at least 2048 bits');
 const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('fledge-usage-v1'));
 const data=Buffer.concat([cipher.update(JSON.stringify(report)),cipher.final()]);
 return {schema:1,key:publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key).toString('base64url'),iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),data:data.toString('base64url')};
}
export function openUsageReport(envelope:unknown,pem:string):UsageReport {
 const e=envelope as UsageEnvelope;
 if(!e||e.schema!==1||Object.keys(e).some(k=>!['schema','key','iv','tag','data'].includes(k))||[e.key,e.iv,e.tag,e.data].some(v=>typeof v!=='string'||v.length>2048||!/^[A-Za-z0-9_-]+$/.test(v)))throw Error('Invalid encrypted usage envelope');
 const key=privateDecrypt({key:pem,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(e.key,'base64url'));
 if(key.length!==32||Buffer.from(e.iv,'base64url').length!==12||Buffer.from(e.tag,'base64url').length!==16)throw Error('Invalid envelope lengths');
 const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(e.iv,'base64url'));decipher.setAAD(Buffer.from('fledge-usage-v1'));decipher.setAuthTag(Buffer.from(e.tag,'base64url'));
 return validateUsageReport(JSON.parse(Buffer.concat([decipher.update(Buffer.from(e.data,'base64url')),decipher.final()]).toString()));
}
