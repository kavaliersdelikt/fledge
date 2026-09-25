import type {FastifyInstance} from 'fastify';
import {pool,hash,admin,fail} from './core.js';

// Shared, atomic fixed windows: limits remain effective across API replicas.
export function registerOperations(app:FastifyInstance){
 app.addHook('onRequest',async(req,reply)=>{
  if(req.url.split('?')[0]==='/api/health'||req.method==='OPTIONS')return;
  const agent=req.url.startsWith('/api/agent/'),auth=req.url.startsWith('/api/auth/'),write=!['GET','HEAD'].includes(req.method);
  const identity=agent?`${req.ip}:${req.headers['x-node-id']||''}`:req.ip;
  const limit=agent?1200:auth&&write?40:write?180:600;
  const key=hash(`${identity}:${agent?'agent':auth?'auth':write?'write':'read'}:${Math.floor(Date.now()/60000)}`);
  const r=await pool.query("INSERT INTO request_limits(bucket_hash,expires_at) VALUES($1,now()+interval '2 minutes') ON CONFLICT(bucket_hash) DO UPDATE SET attempts=request_limits.attempts+1 RETURNING attempts",[key]);
  reply.header('X-RateLimit-Limit',limit);
  if(r.rows[0].attempts>limit){reply.header('Retry-After',60);fail(429,'Too many requests. Please try again in a minute.');}
 });
 app.get('/api/metrics',async(req,reply)=>{
  admin(req);
  const [nodes,jobs,servers]=await Promise.all([pool.query("SELECT status,count(*)::int AS n FROM nodes WHERE deleted_at IS NULL GROUP BY status"),pool.query('SELECT state,count(*)::int AS n FROM jobs GROUP BY state'),pool.query("SELECT observed_status AS status,count(*)::int AS n FROM servers WHERE deleted_at IS NULL GROUP BY observed_status")]);
  const label=(s:string)=>JSON.stringify(s).replace(/\\r/g,'');
  reply.type('text/plain; version=0.0.4');
  return '# HELP navrylo_nodes Registered nodes by connection state\n# TYPE navrylo_nodes gauge\n'+nodes.rows.map(r=>`navrylo_nodes{status=${label(r.status)}} ${r.n}`).join('\n')+'\n# TYPE navrylo_jobs gauge\n'+jobs.rows.map(r=>`navrylo_jobs{state=${label(r.state)}} ${r.n}`).join('\n')+'\n# TYPE navrylo_servers gauge\n'+servers.rows.map(r=>`navrylo_servers{status=${label(r.status)}} ${r.n}`).join('\n')+'\n';
 });
}
