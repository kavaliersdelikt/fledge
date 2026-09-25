import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {registerPanelCors} from '../src/cors.js';

test('browser preflights permit server deletion and other API mutations',async()=>{
 const app=Fastify();
 await registerPanelCors(app,'http://localhost:3000');
 await app.delete('/api/servers/:id',async()=>({ok:true}));
 await app.put('/api/servers/:id/files',async()=>({ok:true}));
 await app.patch('/api/servers/:id',async()=>({ok:true}));
 await app.ready();
 try{
  for(const method of ['DELETE','PUT','PATCH','POST']){
   const response=await app.inject({method:'OPTIONS',url:'/api/servers/test?confirm=true',headers:{origin:'http://localhost:3000','access-control-request-method':method,'access-control-request-headers':'content-type'}});
   assert.equal(response.statusCode,204,`${method} preflight should succeed`);
   assert.equal(response.headers['access-control-allow-origin'],'http://localhost:3000');
   assert.equal(response.headers['access-control-allow-credentials'],'true');
   assert.ok(response.headers['access-control-allow-methods']?.split(/\s*,\s*/).includes(method),`${method} must be listed in CORS methods`);
  }
  const hostile=await app.inject({method:'OPTIONS',url:'/api/servers/test?confirm=true',headers:{origin:'https://attacker.example','access-control-request-method':'DELETE'}});
  assert.equal(hostile.statusCode,204);
  assert.equal(hostile.headers['access-control-allow-origin'],'http://localhost:3000','CORS must return only the configured origin, never reflect an attacker origin');
  assert.equal(hostile.headers['access-control-allow-credentials'],'true','credentialed requests remain limited to the configured origin by the exact ACAO value');
 }finally{await app.close()}
});

test('panel CORS refuses wildcard, null, and non-origin configuration',async()=>{
 const app=Fastify();
 try{
  for(const origin of ['*','null','http://localhost:3000/','http://localhost:3000/path','ftp://panel.example']){
   await assert.rejects(()=>registerPanelCors(app,origin),/WEB_ORIGIN must be one exact HTTP or HTTPS origin/);
  }
 }finally{await app.close()}
});

