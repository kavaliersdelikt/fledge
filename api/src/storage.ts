import {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {fail} from './core.js';
let client:S3Client|undefined;
function storage(){if(!backupEnabled())fail(503,'S3 backup storage is not configured');if(!client)client=new S3Client({region:process.env.S3_REGION||'us-east-1',endpoint:process.env.S3_ENDPOINT,forcePathStyle:true,credentials:{accessKeyId:process.env.S3_ACCESS_KEY!,secretAccessKey:process.env.S3_SECRET_KEY!}});return client;}
export const backupEnabled=()=>Boolean(process.env.S3_BUCKET&&process.env.S3_ACCESS_KEY&&process.env.S3_SECRET_KEY);
export async function backupURL(method:'put'|'get',key:string){return getSignedUrl(storage(),method==='put'?new PutObjectCommand({Bucket:process.env.S3_BUCKET,Key:key}):new GetObjectCommand({Bucket:process.env.S3_BUCKET,Key:key}),{expiresIn:3600});}
export async function putObjectStream(key:string,body:NodeJS.ReadableStream,contentLength:number){await storage().send(new PutObjectCommand({Bucket:process.env.S3_BUCKET,Key:key,Body:body as any,ContentLength:contentLength}));}
export async function getObjectStream(key:string){const result=await storage().send(new GetObjectCommand({Bucket:process.env.S3_BUCKET,Key:key}));if(!result.Body)fail(404,'Backup object is missing');return {body:result.Body as any,contentLength:result.ContentLength,contentType:result.ContentType};}
export async function deleteObject(key:string){await storage().send(new DeleteObjectCommand({Bucket:process.env.S3_BUCKET,Key:key}));}
