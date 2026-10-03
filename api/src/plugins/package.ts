import {createHash,createPublicKey,verify} from 'node:crypto';
import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
import {validateManifest,ManifestError,type Manifest} from './manifest.js';

// A .fledgeplugin file is a zip with fledge-plugin.json and index.js (plus optional icon,
// README.md and CHANGELOG.md). Packages are parsed in memory and never written to disk.

export const MAX_PACKAGE_BYTES=2<<20;
const MAX_UNPACKED=4<<20,MAX_ENTRIES=40,MAX_CODE=1<<20;
export type PluginPackage={manifest:Manifest;code:string;codeSha256:string;packageSha256:string;icon:string|null;readme:string|null;changelog:string|null};
export const sha256=(data:Uint8Array|string)=>createHash('sha256').update(data).digest('hex');

const safeName=(n:string)=>!n.startsWith('/')&&!n.includes('..')&&!n.includes('\\')&&!n.includes('\0');
function iconUri(name:string,data:Uint8Array):string|null{
 if(data.length>100_000)return null;
 if(name.endsWith('.png')&&data[0]===0x89&&data[1]===0x50&&data[2]===0x4e&&data[3]===0x47)return `data:image/png;base64,${Buffer.from(data).toString('base64')}`;
 // SVG is only ever shown through <img>, where scripts do not run.
 if(name.endsWith('.svg')&&/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(strFromU8(data.subarray(0,200))))return `data:image/svg+xml;base64,${Buffer.from(data).toString('base64')}`;
 return null;
}

export function readPackage(bytes:Uint8Array):PluginPackage{
 if(bytes.length>MAX_PACKAGE_BYTES)throw new ManifestError([`The package is larger than ${MAX_PACKAGE_BYTES>>20} MB`]);
 let files:Record<string,Uint8Array>;
 try{
  let total=0,count=0;
  files=unzipSync(bytes,{filter:f=>{count++;total+=f.originalSize;if(count>MAX_ENTRIES)throw new Error('too many files');if(total>MAX_UNPACKED)throw new Error('too large when unpacked');return safeName(f.name);}});
 }catch(e:any){throw new ManifestError([`This is not a valid plugin package (${e?.message||'unreadable zip'})`]);}
 const manifestFile=files['fledge-plugin.json'];
 if(!manifestFile)throw new ManifestError(['The package has no fledge-plugin.json']);
 let raw:unknown;
 try{raw=JSON.parse(strFromU8(manifestFile));}catch{throw new ManifestError(['fledge-plugin.json is not valid JSON']);}
 const manifest=validateManifest(raw);
 const entry=files['index.js'];
 if(!entry)throw new ManifestError(['The package has no index.js']);
 if(entry.length>MAX_CODE)throw new ManifestError(['index.js is larger than 1 MB']);
 const code=strFromU8(entry);
 const iconName=Object.keys(files).find(n=>/^icon\.(svg|png)$/.test(n));
 return {manifest,code,codeSha256:sha256(code),packageSha256:sha256(bytes),icon:iconName?iconUri(iconName,files[iconName]):null,
  readme:files['README.md']?strFromU8(files['README.md']).slice(0,40_000):null,changelog:files['CHANGELOG.md']?strFromU8(files['CHANGELOG.md']).slice(0,20_000):null};
}

/** Builds a package (used by the pack tool and tests). */
export function buildPackage(parts:{manifest:unknown;code:string;icon?:{name:string;data:Uint8Array};readme?:string;changelog?:string}):Uint8Array{
 const files:Record<string,Uint8Array>={'fledge-plugin.json':strToU8(JSON.stringify(parts.manifest,null,1)),'index.js':strToU8(parts.code)};
 if(parts.icon)files[parts.icon.name]=parts.icon.data;
 if(parts.readme)files['README.md']=strToU8(parts.readme);
 if(parts.changelog)files['CHANGELOG.md']=strToU8(parts.changelog);
 return zipSync(files,{level:9,mtime:new Date('2020-01-01')});
}

// --- Signatures -----------------------------------------------------------------------
// The registry signs `fledge-plugin:v1:<id>:<version>:<package sha256>` with Ed25519.
// Keys are base64 SPKI DER. A valid signature from a trusted key makes the tier "verified".
export const signedMessage=(id:string,version:string,packageSha256:string)=>`fledge-plugin:v1:${id}:${version}:${packageSha256}`;
export function verifySignature(keys:string[],id:string,version:string,packageSha256:string,signature:string|undefined):boolean{
 if(!signature||!/^[A-Za-z0-9+/=]{80,100}$/.test(signature))return false;
 const message=Buffer.from(signedMessage(id,version,packageSha256)),sig=Buffer.from(signature,'base64');
 for(const key of keys){
  try{if(verify(null,message,createPublicKey({key:Buffer.from(key,'base64'),format:'der',type:'spki'}),sig))return true;}catch{/* malformed key: try the next */}
 }
 return false;
}
