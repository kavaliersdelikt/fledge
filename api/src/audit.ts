import type {FastifyInstance} from 'fastify';
import {pool,admin,scope,fail,page,asId} from './core.js';
import {settings} from './settings.js';

// The audit log: filtering, export and retention.

function filters(q:any){
 const where:string[]=[],args:any[]=[];
 const add=(sql:string,v:any)=>{args.push(v);where.push(sql.replace('?',`$${args.length}`));};
 if(typeof q?.action==='string'&&q.action)add("a.action LIKE ?",q.action.replace(/[%_]/g,'').slice(0,60)+'%');
 if(typeof q?.actor==='string'&&q.actor)add("a.actor_id=?",asId(q.actor));
 if(typeof q?.targetType==='string'&&q.targetType)add("a.target_type=?",q.targetType.slice(0,40));
 if(typeof q?.targetId==='string'&&q.targetId)add("a.target_id=?",q.targetId.slice(0,80));
 for(const [key,op] of [['from','>='],['to','<=']] as const){
  if(typeof q?.[key]==='string'&&q[key]){const t=new Date(q[key]);if(Number.isNaN(t.getTime()))fail(400,`${key} must be a date`);add(`a.created_at ${op} ?`,t.toISOString());}
 }
 if(typeof q?.q==='string'&&q.q.trim()){const like='%'+q.q.trim().replace(/[%_\\]/g,'').slice(0,80)+'%';args.push(like);where.push(`(a.action ILIKE $${args.length} OR a.target_id ILIKE $${args.length} OR u.email ILIKE $${args.length} OR a.detail::text ILIKE $${args.length})`);}
 return {sql:where.length?'WHERE '+where.join(' AND '):'',args};
}
const csvCell=(v:unknown)=>{
 let s=v===null||v===undefined?'':typeof v==='object'?JSON.stringify(v):String(v);
 // Spreadsheet formula injection: values that start like a formula are prefixed.
 if(/^[=+\-@\t\r]/.test(s))s="'"+s;
 return /[",\n\r]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;
};

export function auditRoutes(app:FastifyInstance){
 app.get('/api/activity',async(req)=>{
  admin(req);scope(req,'read');
  const p=page(req.query),f=filters(req.query);
  return (await pool.query(`SELECT a.*,u.email AS actor_email FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id ${f.sql} ORDER BY a.created_at DESC,a.id DESC LIMIT $${f.args.length+1} OFFSET $${f.args.length+2}`,[...f.args,p.limit,p.offset])).rows;
 });
 app.get('/api/activity/export',async(req,reply)=>{
  admin(req);scope(req,'read');
  const q=req.query as any,format=q?.format==='json'?'json':'csv',f=filters(q);
  const rows=(await pool.query(`SELECT a.id,a.created_at,a.action,a.target_type,a.target_id,a.actor_id,u.email AS actor_email,a.detail FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id ${f.sql} ORDER BY a.created_at DESC,a.id DESC LIMIT 50000`,f.args)).rows;
  const stamp=new Date().toISOString().slice(0,10);
  reply.header('content-disposition',`attachment; filename="fledge-audit-${stamp}.${format}"`).header('cache-control','no-store');
  if(format==='json'){reply.type('application/json');return JSON.stringify(rows);}
  reply.type('text/csv; charset=utf-8');
  const head=['id','time','action','target_type','target_id','actor_id','actor_email','detail'];
  return head.join(',')+'\n'+rows.map((r:any)=>[r.id,r.created_at instanceof Date?r.created_at.toISOString():r.created_at,r.action,r.target_type,r.target_id,r.actor_id,r.actor_email,r.detail].map(csvCell).join(',')).join('\n')+'\n';
 });
}

export async function sweepAudit(){
 const days=(await settings()).security.auditRetentionDays;
 if(days>0)await pool.query("DELETE FROM audit_events WHERE created_at<now()-make_interval(days=>$1::int)",[days]);
}
