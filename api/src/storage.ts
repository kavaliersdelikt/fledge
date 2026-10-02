import {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {fail} from './core.js';
import {settings,type StorageSettings} from './settings.js';

// Object storage is configured in the panel (Settings → Storage). The client is
// rebuilt whenever the saved configuration changes.
let client:{key:string;s3:S3Client}|undefined;
const ready=(s:StorageSettings)=>s.enabled&&!!(s.bucket&&s.accessKey&&s.secretKey);
export function s3For(s:StorageSettings){
 const key=JSON.stringify([s.endpoint,s.region,s.bucket,s.accessKey,s.secretKey,s.forcePathStyle]);
 if(client?.key===key)return client.s3;
 client={key,s3:new S3Client({region:s.region||'us-east-1',endpoint:s.endpoint||undefined,forcePathStyle:s.forcePathStyle,credentials:{accessKeyId:s.accessKey,secretAccessKey:s.secretKey}})};
 return client.s3;
}
async function storage(){const s=(await settings()).storage;if(!ready(s))fail(503,'Object storage is turned off. Turn it on in Settings → Storage.');return {s3:s3For(s),bucket:s.bucket};}
export const backupEnabled=async()=>ready((await settings()).storage);
export async function putObjectStream(key:string,body:NodeJS.ReadableStream,contentLength:number){const {s3,bucket}=await storage();await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:body as any,ContentLength:contentLength}));}
export async function getObjectStream(key:string){const {s3,bucket}=await storage();const result=await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}));if(!result.Body)fail(404,'Stored object is missing');return {body:result.Body as any,contentLength:result.ContentLength,contentType:result.ContentType};}
export async function deleteObject(key:string){const {s3,bucket}=await storage();await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:key}));}

/** Writes, reads back and deletes a small probe object with the given settings. */
export async function testStorage(s:StorageSettings){
 if(!s.bucket||!s.accessKey||!s.secretKey)fail(400,'Bucket, access key and secret key are required');
 const s3=new S3Client({region:s.region||'us-east-1',endpoint:s.endpoint||undefined,forcePathStyle:s.forcePathStyle,credentials:{accessKeyId:s.accessKey,secretAccessKey:s.secretKey}});
 const key=`fledge-probe/${crypto.randomUUID()}`,body=`fledge ${new Date().toISOString()}`;
 const step=async<T>(name:string,run:()=>Promise<T>)=>{try{return await run();}catch(e:any){const reason=e?.name&&e.name!=='Error'?`${e.name}${e.message&&e.message!==e.name?`: ${e.message}`:''}`:e?.message||'failed';return fail(502,`${name} failed — ${reason}`.slice(0,300));}};
 const started=Date.now();
 await step('Upload',()=>s3.send(new PutObjectCommand({Bucket:s.bucket,Key:key,Body:body})));
 const read=await step('Download',async()=>{const r=await s3.send(new GetObjectCommand({Bucket:s.bucket,Key:key}));return await r.Body!.transformToString();});
 await step('Delete',()=>s3.send(new DeleteObjectCommand({Bucket:s.bucket,Key:key})));
 if(read!==body)fail(502,'The object read back did not match what was written');
 s3.destroy();
 return {ok:true,latencyMs:Date.now()-started};
}
