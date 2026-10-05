import {readdirSync,readFileSync,existsSync,statSync} from 'node:fs';
import {dirname,join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../docs/.vitepress/dist'),base=process.env.DOCS_BASE||'/fledge/';
if(!existsSync(root))throw Error('Build the documentation before checking its links');
const decode=s=>s.replace(/&amp;/g,'&').replace(/&#(?:x([\da-f]+)|(\d+));/gi,(_,hex,n)=>String.fromCodePoint(parseInt(hex||n,hex?16:10)));
const pages=new Map();
function walk(dir){for(const f of readdirSync(dir,{withFileTypes:true})){const path=join(dir,f.name);if(f.isDirectory())walk(path);else if(f.name.endsWith('.html')){const html=readFileSync(path,'utf8');pages.set(path,{ids:new Set([...html.matchAll(/\bid="([^"]*)"/g)].map(m=>decode(m[1]))),links:[...html.matchAll(/\b(?:href|src)="([^"]*)"/g)].map(m=>decode(m[1]))})}}}
walk(root);const failures=[];let checked=0;
for(const [file,page] of pages)for(const href of page.links){
 if(/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href))continue;
 const url=new URL(href,'https://docs.invalid/'+relative(root,file).replaceAll('\\','/'));
 let path=decodeURIComponent(url.pathname);if(base!=='/'&&path.startsWith(base))path='/'+path.slice(base.length);
 const target=resolve(root,'.'+path),candidates=[target,target+'.html',join(target,'index.html')],found=candidates.find(p=>existsSync(p)&&statSync(p).isFile());checked++;
 if(!found){failures.push(`${relative(root,file)}: ${href} (missing target)`);continue;}
 if(url.hash&&pages.has(found)&&!pages.get(found).ids.has(decodeURIComponent(url.hash.slice(1))))failures.push(`${relative(root,file)}: ${href} (missing anchor)`);
}
if(failures.length){console.error(failures.join('\n'));throw Error(`${failures.length} broken built-site links`)}
console.log(`Built-site link checks passed: ${pages.size} pages, ${checked} local links and assets.`);
