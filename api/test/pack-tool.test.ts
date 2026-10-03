import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readPackage,verifySignature,sha256} from '../src/plugins/package.ts';
import {readBundled} from '../src/plugins/manager.ts';

const tool=fileURLToPath(new URL('../../plugins/tools/pack.mjs',import.meta.url));
const bundled=fileURLToPath(new URL('../../plugins/bundled',import.meta.url));
const run=(...a:string[])=>execFileSync(process.execPath,[tool,...a],{encoding:'utf8'});

test('the pack tool builds signed packages the panel accepts, and the index matches them',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fledge-pack-'));
 const keygen=run('keygen',dir);
 const pub=readFileSync(join(dir,'fledge-plugin-signing.pub'),'utf8').trim();
 assert.match(keygen,/Never commit it/);
 assert.throws(()=>run('keygen',dir),/refusing to overwrite/);
 const out=JSON.parse(run('pack',join(bundled,'modrinth-mods'),'--out',dir,'--sign',join(dir,'fledge-plugin-signing.key.pem')));
 const bytes=readFileSync(out.file);
 assert.equal(out.sha256,sha256(bytes));
 const pkg=readPackage(bytes);
 assert.equal(pkg.manifest.id,'modrinth-mods');
 assert.equal(pkg.icon?.startsWith('data:image/svg+xml;base64,'),true);
 assert.ok(pkg.code.includes('createProvider')&&pkg.code.includes('fledgePlugin'),'shared code and plugin code are bundled into index.js');
 assert.equal(pkg.code,readBundled(join(bundled,'modrinth-mods')).code,'the packed code equals what the panel loads for bundled plugins');
 assert.equal(verifySignature([pub],pkg.manifest.id,pkg.manifest.version,out.sha256,out.signature),true);
 assert.equal(verifySignature([pub],pkg.manifest.id,'9.9.9',out.sha256,out.signature),false,'a signature is bound to the version');
 assert.equal(verifySignature([pub],pkg.manifest.id,pkg.manifest.version,'0'.repeat(64),out.signature),false,'and to the exact bytes');
 // Reproducible: packing again gives the same checksum.
 const again=JSON.parse(run('pack',join(bundled,'modrinth-mods'),'--out',join(dir,'again')));
 assert.equal(again.sha256,out.sha256);
 // A second plugin and an index.
 run('pack',join(bundled,'modrinth-plugins'),'--out',dir,'--sign',join(dir,'fledge-plugin-signing.key.pem'));
 assert.throws(()=>run('index',dir,'--base-url','http://insecure.example'),/https/);
 run('index',dir,'--base-url','https://example.org/plugins','--sign',join(dir,'fledge-plugin-signing.key.pem'));
 const index=JSON.parse(readFileSync(join(dir,'index.json'),'utf8'));
 assert.equal(index.schema,1);assert.equal(index.plugins.length,2);
 for(const e of index.plugins){
  assert.match(e.downloadUrl,/^https:\/\/example\.org\/plugins\/.+\.fledgeplugin$/);
  const file=readFileSync(join(dir,e.downloadUrl.split('/').pop()));
  assert.equal(sha256(file),e.sha256);
  assert.equal(verifySignature([pub],e.id,e.version,e.sha256,e.signature),true);
 }
 assert.match(run('verify',out.file,'--key',pub,'--signature',out.signature),/OK:/);
 writeFileSync(out.file,Buffer.concat([bytes,Buffer.from('x')]));
 assert.throws(()=>run('verify',out.file,'--key',pub,'--signature',out.signature));
});

test('the pack tool refuses malformed plugin directories',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fledge-bad-'));
 writeFileSync(join(dir,'fledge-plugin.json'),JSON.stringify({id:'Bad Id',version:'1.0.0'}));
 assert.throws(()=>run('pack',dir,'--out',dir),/manifest id/);
 writeFileSync(join(dir,'fledge-plugin.json'),JSON.stringify({id:'good-id',version:'x'}));
 assert.throws(()=>run('pack',dir,'--out',dir),/version/);
 writeFileSync(join(dir,'fledge-plugin.json'),JSON.stringify({id:'good-id',version:'1.0.0'}));
 assert.throws(()=>run('pack',dir,'--out',dir),/plugin\.js nor index\.js/);
});
