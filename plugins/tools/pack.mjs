#!/usr/bin/env node
// Build, sign and index Fledge plugin packages (.fledgeplugin).
//
//   node pack.mjs keygen <outdir>                      new Ed25519 signing key (PEM) + public key
//   node pack.mjs pack <plugin-dir> [--out dist] [--sign key.pem]
//   node pack.mjs index <dist-dir> --base-url <url> [--sign key.pem] [--out index.json]
//   node pack.mjs verify <file.fledgeplugin> --key <base64-spki> --signature <base64>
//
// A plugin directory holds fledge-plugin.json and either plugin.js (optionally with an
// "include" list of shared files, like the bundled plugins) or index.js, plus optional
// icon.svg/icon.png, README.md and CHANGELOG.md. See docs/plugins/README.md.

import {createHash,generateKeyPairSync,createPrivateKey,createPublicKey,sign,verify} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync} from 'node:fs';
import {join,resolve,basename,sep} from 'node:path';
import {zipSync,strToU8} from 'fflate';

const args=process.argv.slice(2);
const flag=(name,def)=>{const i=args.indexOf('--'+name);return i>=0?args[i+1]:def;};
const sha256=b=>createHash('sha256').update(b).digest('hex');
const signedMessage=(id,version,hash)=>`fledge-plugin:v1:${id}:${version}:${hash}`;
const die=m=>{console.error('Error: '+m);process.exit(1);};

function packDir(dir){
 const root=resolve(dir),manifestPath=join(root,'fledge-plugin.json');
 if(!existsSync(manifestPath))die(`${manifestPath} not found`);
 const raw=JSON.parse(readFileSync(manifestPath,'utf8'));
 if(!/^[a-z0-9][a-z0-9-]{1,48}$/.test(raw.id||''))die('manifest id must be 2-49 lowercase letters, digits or hyphens');
 if(!/^\d{1,4}\.\d{1,4}\.\d{1,4}(\.\d{1,4})?(-[0-9A-Za-z.-]{1,20})?$/.test(raw.version||''))die('manifest version must look like 1.2.3');
 const parts=[];
 for(const inc of Array.isArray(raw.include)?raw.include:[]){
  const file=resolve(root,inc);
  if(!existsSync(file))die(`included file ${inc} not found`);
  parts.push(readFileSync(file,'utf8'));
 }
 const entry=existsSync(join(root,'plugin.js'))?join(root,'plugin.js'):join(root,'index.js');
 if(!existsSync(entry))die('neither plugin.js nor index.js found');
 parts.push(readFileSync(entry,'utf8'));
 const {include,...manifest}=raw;void include;
 const files={'fledge-plugin.json':strToU8(JSON.stringify(manifest,null,1)),'index.js':strToU8(parts.join('\n;\n'))};
 for(const n of ['icon.svg','icon.png'])if(existsSync(join(root,n)))files[n]=new Uint8Array(readFileSync(join(root,n)));
 for(const n of ['README.md','CHANGELOG.md'])if(existsSync(join(root,n)))files[n]=strToU8(readFileSync(join(root,n),'utf8'));
 // A fixed timestamp makes the package reproducible: the same sources give the same checksum.
 const bytes=Buffer.from(zipSync(files,{level:9,mtime:new Date('2020-01-01')}));
 return {manifest,bytes};
}
const signWith=(keyPath,id,version,hash)=>sign(null,Buffer.from(signedMessage(id,version,hash)),createPrivateKey(readFileSync(keyPath))).toString('base64');

const [cmd,target]=args;
if(cmd==='keygen'){
 if(!target)die('usage: keygen <outdir>');
 mkdirSync(target,{recursive:true});
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const keyFile=join(target,'fledge-plugin-signing.key.pem');
 if(existsSync(keyFile))die(`${keyFile} already exists; refusing to overwrite a signing key`);
 writeFileSync(keyFile,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
 const pub=publicKey.export({type:'spki',format:'der'}).toString('base64');
 writeFileSync(join(target,'fledge-plugin-signing.pub'),pub+'\n');
 console.log(`Private key: ${keyFile}\nKeep it secret and offline-backed-up. Never commit it.\nPublic key (add under Settings → Plugins → Trusted keys):\n${pub}`);
}else if(cmd==='pack'){
 if(!target)die('usage: pack <plugin-dir> [--out dist] [--sign key.pem]');
 const out=flag('out','dist'),{manifest,bytes}=packDir(target);
 mkdirSync(out,{recursive:true});
 const file=join(out,`${manifest.id}-${manifest.version}.fledgeplugin`);
 writeFileSync(file,bytes);
 const hash=sha256(bytes),key=flag('sign');
 const result={file,id:manifest.id,version:manifest.version,size:bytes.length,sha256:hash};
 if(key){result.signature=signWith(key,manifest.id,manifest.version,hash);writeFileSync(file+'.sig',result.signature+'\n');}
 console.log(JSON.stringify(result,null,2));
}else if(cmd==='index'){
 if(!target)die('usage: index <dist-dir> --base-url <url> [--sign key.pem]');
 const base=(flag('base-url')||'').replace(/\/$/,''),key=flag('sign');
 if(!/^https:\/\//.test(base))die('--base-url must be an https URL where the packages will be hosted');
 const plugins=[];
 for(const name of readdirSync(target).filter(n=>n.endsWith('.fledgeplugin')).sort()){
  const bytes=readFileSync(join(target,name)),hash=sha256(bytes);
  // Read the manifest back out of the package so the index can never disagree with it.
  const {unzipSync,strFromU8}=await import('fflate');
  const m=JSON.parse(strFromU8(unzipSync(new Uint8Array(bytes))['fledge-plugin.json']));
  plugins.push({id:m.id,name:m.name,version:m.version,description:m.description,author:m.author,license:m.license,homepage:m.homepage,permissions:m.permissions||[],minPanelVersion:m.minPanelVersion,downloadUrl:`${base}/${name}`,sha256:hash,size:bytes.length,...(key?{signature:signWith(key,m.id,m.version,hash)}:{})});
 }
 const outFile=flag('out',join(target,'index.json'));
 writeFileSync(outFile,JSON.stringify({schema:1,generatedAt:new Date().toISOString(),plugins},null,1)+'\n');
 console.log(`Wrote ${outFile} with ${plugins.length} plugin(s)${key?' (signed)':''}.`);
}else if(cmd==='verify'){
 if(!target)die('usage: verify <file> --key <base64-spki> --signature <base64>');
 const bytes=readFileSync(target),hash=sha256(bytes);
 const {unzipSync,strFromU8}=await import('fflate');
 const m=JSON.parse(strFromU8(unzipSync(new Uint8Array(bytes))['fledge-plugin.json']));
 const ok=verify(null,Buffer.from(signedMessage(m.id,m.version,hash)),createPublicKey({key:Buffer.from(flag('key',''),'base64'),format:'der',type:'spki'}),Buffer.from(flag('signature',''),'base64'));
 console.log(ok?`OK: ${m.id} ${m.version} (${hash}) is signed by that key`:'INVALID signature');process.exit(ok?0:2);
}else{
 console.log(readFileSync(new URL(import.meta.url),'utf8').split('\n').slice(1,14).join('\n').replace(/^\/\/ ?/gm,''));
 process.exit(cmd?1:0);
}
void basename;void sep;
