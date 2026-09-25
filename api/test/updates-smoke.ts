import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerUpdates} from '../src/updates.js';

const app=Fastify();let calls=0;
app.addHook('preHandler',async(req)=>{if(req.headers.authorization==='smoke-admin')req.actor={id:'smoke',email:'smoke@example.test',role:'admin',has2fa:true};});
registerUpdates(app);
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 calls++;
 assert.equal(String(input),'https://api.github.com/repos/kavaliersdelikt/fledge/releases/latest');
 assert.equal((init?.headers as Record<string,string>).accept,'application/vnd.github+json');
 assert.equal((init?.headers as Record<string,string>).authorization,undefined,'GitHub credentials must not be present by default');
 return Response.json({tag_name:'v0.2.0',name:'Fledge 0.2.0',html_url:'https://github.com/kavaliersdelikt/fledge/releases/tag/v0.2.0',body:'Release notes',published_at:'2026-09-25T12:00:00Z'});
};
try{
 const denied=await app.inject({method:'GET',url:'/api/updates'});assert.equal(denied.statusCode,403,'release metadata requires an authenticated administrator');
 const first=await app.inject({method:'GET',url:'/api/updates',headers:{authorization:'smoke-admin'}});assert.equal(first.statusCode,200);const result=first.json();assert.equal(result.repository,'kavaliersdelikt/fledge');assert.equal(result.currentVersion,'0.1.1');assert.equal(result.latestVersion,'0.2.0');assert.equal(result.updateAvailable,true);assert.equal(result.body,'Release notes');assert.equal(result.error,null);
 const second=await app.inject({method:'GET',url:'/api/updates',headers:{authorization:'smoke-admin'}});assert.equal(second.statusCode,200);assert.equal(second.json().latestVersion,'0.2.0');assert.equal(calls,1,'successful GitHub release checks should use the five-minute cache');
 console.log('PASS updater API smoke: admin authorization, stable release response, update comparison and caching.');
}finally{globalThis.fetch=originalFetch;await app.close();}
