import {chromium} from 'playwright-core';
import {spawn} from 'node:child_process';
import {writeFileSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {bootDemo} from './demo.mjs';
import {seedMews} from './mews-demo.mjs';
import {captureVM} from './capture.vm.mjs';
const apiPort=Number(process.env.VM_SCREENSHOT_API_PORT||4307);if(!Number.isInteger(apiPort)||apiPort<1024||apiPort>65535)throw Error('Invalid VM screenshot API port');
const repo=join(dirname(fileURLToPath(import.meta.url)),'../..'),out=join(repo,'docs-site/docs/public/screenshots');mkdirSync(out,{recursive:true});
if(process.env.VM_SCREENSHOT_SKIP_BUILD!=='1')await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[join(repo,'web/node_modules/next/dist/bin/next'),'build'],{cwd:join(repo,'web'),env:{...process.env,NEXT_PUBLIC_API_URL:`http://localhost:${apiPort}`},stdio:'inherit'});p.on('error',reject);p.on('exit',c=>c?reject(Error('VM screenshot build failed')):resolve())});
const demo=await bootDemo({db:'fledge_vm_docs_demo',apiPort,hostPort:4597,webPort:3107});let seeded,browser;
try{
 seeded=await seedMews(demo);browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:1360,height:960},colorScheme:'dark',reducedMotion:'reduce'}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const session=async c=>{await context.clearCookies();await context.addCookies([{name:'fledge_session',value:decodeURIComponent(c.cookie.split('=')[1]),domain:'localhost',path:'/'}])};
 const save=async name=>{
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1))throw Error(name+': horizontal overflow');const png=await page.screenshot({animations:'disabled'});writeFileSync(join(out,name+'.png'),png);
  const converter=await context.newPage();const b64=await converter.evaluate(async input=>{const bmp=await createImageBitmap(await(await fetch('data:image/png;base64,'+input)).blob()),canvas=new OffscreenCanvas(bmp.width,bmp.height);canvas.getContext('2d').drawImage(bmp,0,0);const blob=await canvas.convertToBlob({type:'image/webp',quality:.86}),bytes=new Uint8Array(await blob.arrayBuffer());let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s)},png.toString('base64'));await converter.close();writeFileSync(join(out,name+'.webp'),Buffer.from(b64,'base64'));console.log('Captured '+name);
 };
 await captureVM({demo,seeded,page,session,save});if(errors.length)throw Error(errors.join('; '));
}finally{seeded?.stop();await browser?.close();await demo.stop()}
process.exit(0);
