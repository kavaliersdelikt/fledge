// Schedules (cron, chains, runs), crash policy, and the notification center.
import {createServer} from 'node:http';
import {bootStack,client,bootstrapAdmin,makeNode,heartbeat,nextJob,finishJob,dbQuery,sleep} from './harness.mjs';
import {randomBytes} from 'node:crypto';

const received=[];let hookStatus=200;
const hook=createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{received.push({url:req.url,body:JSON.parse(raw||'{}')});res.statusCode=hookStatus;res.end('ok');});});
await new Promise(r=>hook.listen(0,'127.0.0.1',r));
const hookUrl=`http://127.0.0.1:${hook.address().port}`;

const stack=await bootStack({db:'fledge_autopilot_smoke',apiPort:4177,hostPort:4525,mock:null,apiEnv:{SWEEP_INTERVAL_MS:'1000',SLOW_SWEEP_MS:'2000'}});
const admin=client(stack.base);const {call,ok,status,check}=admin;
let failed=null;
const until=async(fn,label,ms=20000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('timed out waiting for '+label);await sleep(250);}};
const takeJob=async(node,kind,ms=20000)=>until(async()=>{const j=await nextJob(admin,node);if(!j)return null;if(kind&&j.kind!==kind){await finishJob(admin,node,j);return null;}return j;},`a ${kind||'any'} job`,ms);
try{
 await bootstrapAdmin(admin);
 const node=await makeNode(admin,'auto','test',{memoryMb:32768,cpuPercent:3200,diskMb:500000});await heartbeat(admin,node);
 const owner=ok(await call('POST','/api/customers',{email:'owner-'+randomBytes(3).toString('hex')+'@example.test'}),'owner');
 const stranger=ok(await call('POST','/api/customers',{email:'stranger-'+randomBytes(3).toString('hex')+'@example.test'}),'stranger');
 const server=ok(await call('POST','/api/servers',{name:'Auto',ownerId:owner.id,templateId:'minecraft-paper',nodeId:node.id,memoryMb:1024,cpuPercent:100,diskMb:2048,port:25565}),'server');
 const cj=await takeJob(node,'create');await finishJob(admin,node,cj);
 const S=`/api/servers/${server.id}`;
 const ownerC=client(stack.base);ok(await ownerC.call('POST','/api/auth/login',{email:owner.email,password:owner.temporaryPassword}),'owner login');
 const strangerC=client(stack.base);ok(await strangerC.call('POST','/api/auth/login',{email:stranger.email,password:stranger.temporaryPassword}),'stranger login');

 // --- Cron ------------------------------------------------------------------------------------------------
 const prev=ok(await call('GET','/api/cron/preview?expr='+encodeURIComponent('30 4 * * 1-5')+'&tz=Europe/Berlin'),'cron preview');
 check(prev.next.length===5&&prev.next.every(t=>new Date(t).getUTCMinutes()===30),'a valid expression previews its next five runs');
 status(await call('GET','/api/cron/preview?expr='+encodeURIComponent('* * * * *')),400,'every minute is too frequent');
 status(await call('GET','/api/cron/preview?expr='+encodeURIComponent('*/4 * * * *')),400,'every four minutes is too frequent');
 status(await call('GET','/api/cron/preview?expr='+encodeURIComponent('not cron')),400,'garbage is rejected');
 status(await call('GET','/api/cron/preview?expr='+encodeURIComponent('0 0 * * *')+'&tz=Mars/Base'),400,'unknown time zone');
 status(await call('GET','/api/cron/preview?expr='+encodeURIComponent('0 0 * * * *')),400,'six fields are not accepted');

 // --- Creating schedules ------------------------------------------------------------------------------------------
 const bad=async(label,body)=>status(await call('POST',`${S}/schedules`,body),400,label);
 await bad('no trigger',{tasks:[{action:'backup'}]});
 await bad('no steps',{cron:'0 4 * * *',tasks:[]});
 await bad('unknown step',{cron:'0 4 * * *',tasks:[{action:'format'}]});
 await bad('bad power',{cron:'0 4 * * *',tasks:[{action:'power',power:'explode'}]});
 await bad('zero wait',{cron:'0 4 * * *',tasks:[{action:'wait',seconds:0}]});
 await bad('multi-line command',{cron:'0 4 * * *',tasks:[{action:'command',command:'a\nb'}]});
 await bad('too many steps',{cron:'0 4 * * *',tasks:Array.from({length:21},()=>({action:'wait',seconds:1}))});
 await bad('waits over six hours',{cron:'0 4 * * *',tasks:[{action:'wait',seconds:3600},{action:'wait',seconds:3600},{action:'wait',seconds:3600},{action:'wait',seconds:3600},{action:'wait',seconds:3600},{action:'wait',seconds:3600},{action:'wait',seconds:1}]});
 await bad('interval too short',{intervalMinutes:2,tasks:[{action:'command',command:'save-all'}]});
 await bad('too frequent cron',{cron:'*/2 * * * *',tasks:[{action:'command',command:'save-all'}]});
 ownerC.status(await ownerC.call('GET',`${S}/schedules`),200,'owners manage schedules');
 strangerC.status(await strangerC.call('GET',`${S}/schedules`),404,'strangers cannot see schedules');
 status(await call('POST',`${S}/schedules`,{cron:'0 4 * * *',tasks:[{action:'backup'}]}),503,'a backup step needs object storage');

 const chain=ok(await call('POST',`${S}/schedules`,{name:'Nightly restart',cron:'0 4 * * *',timezone:'Europe/Berlin',tasks:[{action:'command',command:'say Restarting in 2 seconds'},{action:'wait',seconds:2},{action:'power',power:'restart'}]}),'create chain');
 check(chain.kind==='chain'&&chain.tasks.length===3&&chain.cron==='0 4 * * *'&&chain.timezone==='Europe/Berlin'&&new Date(chain.nextRunAt)>new Date(),'a chain is stored with its next run in the future');
 const legacy=ok(await call('POST',`${S}/schedules`,{kind:'command',command:'save-all',intervalMinutes:5}),'legacy-style command schedule');
 check(legacy.kind==='command'&&legacy.intervalMinutes===5&&legacy.tasks.length===1&&legacy.tasks[0].action==='command','the older single-command form still works');
 const renamed=ok(await call('PATCH',`${S}/schedules/${chain.id}`,{name:'Renamed'}),'rename');check(renamed.name==='Renamed'&&renamed.tasks.length===3,'editing keeps the steps');
 status(await call('PATCH',`${S}/schedules/${chain.id}`,{cron:'x y'}),400,'invalid edit');

 // --- Running a chain ---------------------------------------------------------------------------------------------------
 ok(await call('POST',`${S}/schedules/${chain.id}/run`,{}),'run now');
 status(await call('POST',`${S}/schedules/${chain.id}/run`,{}),409,'a schedule cannot run twice at once');
 let twice=false;try{await dbQuery(stack.databaseUrl,"INSERT INTO schedule_runs(schedule_id,server_id,state) VALUES($1,$2,'running')",[chain.id,server.id]);}catch(e){twice=/schedule_runs_one_running/.test(String(e.message));}
 check(twice,'the database itself refuses two runs of one schedule at once');
 const j1=await takeJob(node,'command');check(j1.payload.command==='say Restarting in 2 seconds','the first step runs');await finishJob(admin,node,j1);
 const t0=Date.now();
 const j2=await takeJob(node,'restart');await finishJob(admin,node,j2);
 check(Date.now()-t0>=1200,'the wait step delays the restart ('+(Date.now()-t0)+' ms)');
 const run=await until(async()=>{const r=ok(await call('GET',`${S}/schedules/${chain.id}/runs`),'runs');return r[0]&&r[0].state==='succeeded'?r[0]:null;},'the run to finish');
 check(run.results.length===3&&run.results.every(r=>r.ok)&&run.trigger==='manual','the run records every step');
 const afterRun=ok(await call('GET',`${S}/schedules`),'schedules').find(s=>s.id===chain.id);check(afterRun.lastStatus==='succeeded'&&afterRun.lastRunAt,'the schedule shows its last result');

 // Due schedules start by themselves.
 await dbQuery(stack.databaseUrl,"UPDATE schedules SET next_run_at=now() WHERE id=$1",[legacy.id]);
 const j3=await takeJob(node,'command');check(j3.payload.command==='save-all','a due schedule runs on its own');await finishJob(admin,node,j3);
 const moved=ok(await call('GET',`${S}/schedules`),'schedules').find(s=>s.id===legacy.id);check(new Date(moved.nextRunAt)>new Date(Date.now()+4*60_000),'and is scheduled again');
 // Missed runs.
 await dbQuery(stack.databaseUrl,"UPDATE schedules SET next_run_at=now()-interval '1 hour',missed='skip' WHERE id=$1",[legacy.id]);
 const skipped=await until(async()=>{const r=ok(await call('GET',`${S}/schedules/${legacy.id}/runs`),'runs');return r.find(x=>x.state==='skipped');},'a skipped run');
 check(/Missed/.test(skipped.error),'a missed run is skipped by default and says so');
 await dbQuery(stack.databaseUrl,"UPDATE schedules SET next_run_at=now()-interval '1 hour',missed='run' WHERE id=$1",[legacy.id]);
 const j4=await takeJob(node,'command');await finishJob(admin,node,j4);check(true,'a schedule set to run missed work runs once');
 // Failures are recorded and announced.
 await dbQuery(stack.databaseUrl,"UPDATE servers SET suspended=true WHERE id=$1",[server.id]);
 ok(await call('POST',`${S}/schedules/${legacy.id}/run`,{}),'run while suspended');
 const failedRun=await until(async()=>{const r=ok(await call('GET',`${S}/schedules/${legacy.id}/runs`),'runs');return r.find(x=>x.state==='failed');},'a failed run');
 check(/suspended/.test(failedRun.error),'a failing step fails the run with its reason');
 await dbQuery(stack.databaseUrl,"UPDATE servers SET suspended=false WHERE id=$1",[server.id]);
 ok(await call('DELETE',`${S}/schedules/${chain.id}`),'delete schedule');status(await call('DELETE',`${S}/schedules/${chain.id}`),404,'delete twice');
 for(const x of (await dbQuery(stack.databaseUrl,"SELECT id FROM schedules WHERE server_id=$1",[server.id])))await call('DELETE',`${S}/schedules/${x.id}`);

 // --- Notification center -----------------------------------------------------------------------------------------------------
 const inbox=ok(await ownerC.call('GET','/api/notifications'),'owner inbox');
 check(inbox.items.some(n=>n.kind==='schedule.failed'&&n.serverId===server.id),'the owner is told about the failed schedule');
 const adminInbox=ok(await call('GET','/api/notifications'),'admin inbox');check(adminInbox.items.some(n=>n.kind==='schedule.failed'),'administrators see it too');
 check(ok(await strangerC.call('GET','/api/notifications'),'stranger inbox').items.length===0,'other customers see nothing about this server');
 check(inbox.unread>=1&&ok(await ownerC.call('GET','/api/notifications/summary'),'summary').unread===inbox.unread,'unread counts match');
 ok(await ownerC.call('POST','/api/notifications/read',{}),'mark read');check(ok(await ownerC.call('GET','/api/notifications/summary'),'summary').unread===0,'marking read clears the count');
 const events=ok(await ownerC.call('GET','/api/notification-events'),'events');check(events.every(e=>e.scope==='server')&&events.some(e=>e.id==='server.crashed'),'customers can subscribe to server events only');
 const aEvents=ok(await call('GET','/api/notification-events'),'events');check(aEvents.some(e=>e.id==='node.offline'),'administrators also get panel events');

 // Channels
 status(await call('POST','/api/notification-channels',{name:'x',kind:'carrier-pigeon',events:['server.crashed'],url:hookUrl}),400,'unknown channel kind');
 status(await call('POST','/api/notification-channels',{name:'x',kind:'webhook',events:[],url:hookUrl}),400,'at least one event');
 status(await call('POST','/api/notification-channels',{name:'x',kind:'webhook',events:['nope'],url:hookUrl}),400,'unknown event');
 status(await call('POST','/api/notification-channels',{name:'x',kind:'webhook',events:['server.crashed'],url:'ftp://x'}),400,'webhook URL must be http(s)');
 ownerC.status(await ownerC.call('POST','/api/notification-channels',{name:'Mine',kind:'webhook',events:['server.crashed'],url:'http://example.org/hook'}),400,'customers need HTTPS webhooks');
 ownerC.status(await ownerC.call('POST','/api/notification-channels',{name:'Mine',kind:'webhook',events:['node.offline'],url:'https://example.org/hook'}),400,'customers cannot subscribe to panel events');
 ownerC.status(await ownerC.call('POST','/api/notification-channels',{name:'Mine',kind:'email',events:['server.crashed'],to:owner.email}),409,'email channels need email to be set up');
 const chan=ok(await call('POST','/api/notification-channels',{name:'Ops hook',kind:'slack',events:['server.crashed','server.crashloop','server.recovered','server.disk_high','schedule.failed'],url:hookUrl+'/ops'}),'admin webhook channel');
 check(chan.scope==='panel'&&chan.urlHost.startsWith('127.0.0.1')&&!JSON.stringify(chan).includes('/ops'),'the webhook URL is stored but never shown, only its host');
 const rawSecret=(await dbQuery(stack.databaseUrl,'SELECT secret FROM notification_channels WHERE id=$1',[chan.id]))[0].secret;check(rawSecret&&!rawSecret.includes('127.0.0.1'),'the URL is encrypted at rest');
 ok(await call('POST',`/api/notification-channels/${chan.id}/test`,{}),'send a test message');
 check(received.some(r=>r.url==='/ops'&&/Test notification/.test(r.body.text)),'the webhook received the test message in Slack format');
 hookStatus=500;status(await call('POST',`/api/notification-channels/${chan.id}/test`,{}),502,'a failing endpoint is reported');hookStatus=200;
 check(ok(await call('GET','/api/notification-channels'),'channels').find(c=>c.id===chan.id).lastStatus==='failed','the channel remembers its last delivery failed');
 ownerC.status(await ownerC.call('PATCH',`/api/notification-channels/${chan.id}`,{enabled:false}),404,'customers cannot touch panel channels');
 check(ok(await ownerC.call('GET','/api/notification-channels'),'owner channels').length===0,'customers only see their own channels');
 const discord=ok(await call('POST','/api/notification-channels',{name:'Discord',kind:'discord',events:['server.crashed'],url:hookUrl+'/discord',serverIds:[server.id]}),'discord channel limited to one server');
 ok(await call('PATCH',`/api/notification-channels/${discord.id}`,{enabled:false}),'disable a channel');
 ok(await call('DELETE',`/api/notification-channels/${discord.id}`),'delete a channel');

 // --- Crash policy -----------------------------------------------------------------------------------------------------------------
 for(const badPolicy of [{mode:'sometimes'},{mode:'on-failure',maxRestarts:0},{mode:'on-failure',maxRestarts:50},{mode:'on-failure',backoffSeconds:[1]},{mode:'on-failure',backoffSeconds:[]}])status(await call('PUT',`${S}/crash-policy`,badPolicy),400,'invalid policy '+JSON.stringify(badPolicy));
 const pol0=ok(await ownerC.call('GET',`${S}/crash-policy`),'policy');check(pol0.policy.mode==='off','automatic restarts are off by default for existing servers');
 ownerC.status(await ownerC.call('PUT',`${S}/crash-policy`,{mode:'on-failure',maxRestarts:2,windowMinutes:10,backoffSeconds:[5]}),200,'owners can set the policy');
 strangerC.status(await strangerC.call('PUT',`${S}/crash-policy`,{mode:'always'}),404,'strangers cannot');
 const crash=(code=137)=>heartbeat(admin,node,'0.6.1.1',[{id:server.id,status:'failed',exit:{code,oomKilled:code===137,finishedAt:new Date().toISOString(),logTail:'java.lang.OutOfMemoryError: Java heap space'}}]);
 const running=()=>heartbeat(admin,node,'0.6.1.1',[{id:server.id,status:'running'}]);
 await running();
 await crash();
 const s1=await takeJob(node,'start',20000);check(s1.server.id===server.id,'a crashed server is started again');await finishJob(admin,node,s1);
 const ev1=ok(await ownerC.call('GET',`${S}/events`),'events');
 check(ev1.some(e=>e.kind==='crash'&&/exit code 137, out of memory/.test(e.message))&&ev1.some(e=>e.kind==='restart'),'the exit reason and the restart are recorded');
 const crashNote=await until(async()=>ok(await ownerC.call('GET','/api/notifications'),'inbox').items.find(n=>n.kind==='server.crashed'),'a crash notification');
 check(/OutOfMemoryError/.test(crashNote.body)&&/137/.test(crashNote.body),'the notification carries the exit code and the end of the log');
 await until(()=>received.some(r=>r.body.text&&/crashed/.test(r.body.text)),'the webhook to hear about the crash');
 await crash(1);
 const s2=await takeJob(node,'start',20000);await finishJob(admin,node,s2);
 await crash(1);
 await until(async()=>ok(await ownerC.call('GET',`${S}/crash-policy`),'policy').loop,'the crash loop to be detected');
 check(ok(await ownerC.call('GET','/api/notifications'),'inbox').items.some(n=>n.kind==='server.crashloop'),'a crash loop is announced');
 await sleep(7000);
 check(!(await nextJob(admin,node)),'after the limit no more automatic restarts are attempted');
 // A manual start clears the loop.
 ok(await call('POST',`${S}/actions`,{action:'start'}),'manual start');
 const ms=await takeJob(node,'start');await finishJob(admin,node,ms);
 check(!ok(await ownerC.call('GET',`${S}/crash-policy`),'policy').loop,'starting by hand clears the loop');
 // Recovery is reported after a stable run.
 await dbQuery(stack.databaseUrl,"UPDATE servers SET crash_state=$2 WHERE id=$1",[server.id,JSON.stringify({restarts:[new Date().toISOString()],runningSince:new Date(Date.now()-3*60_000).toISOString()})]);
 await running();
 await until(async()=>ok(await ownerC.call('GET',`${S}/events`),'events').some(e=>e.kind==='recovered'),'the recovery event');
 check(ok(await ownerC.call('GET','/api/notifications'),'inbox').items.some(n=>n.kind==='server.recovered'),'recovery is announced');
 // A server stopped on purpose is left alone.
 ok(await call('POST',`${S}/actions`,{action:'stop'}),'stop on purpose');const st=await takeJob(node,'stop');await finishJob(admin,node,st);
 await heartbeat(admin,node,'0.6.1.1',[{id:server.id,status:'stopped'}]);await sleep(3500);
 check(!(await nextJob(admin,node)),'a server stopped from the panel is not restarted');
 ok(await call('PUT',`${S}/crash-policy`,{mode:'off'}),'policy off');

 // --- Disk alerts ------------------------------------------------------------------------------------------------------------------------
 ok(await call('POST',`${S}/actions`,{action:'start'}),'start again');const st2=await takeJob(node,'start');await finishJob(admin,node,st2);
 await heartbeat(admin,node,'0.6.1.1',[{id:server.id,status:'running',diskBytes:Math.round(2048*1048576*0.95),usage:{cpuPercent:5,memoryBytes:300000000,memoryLimitBytes:1073741824}}]);
 const disk=await until(async()=>ok(await ownerC.call('GET','/api/notifications'),'inbox').items.find(n=>n.kind==='server.disk_high'),'a disk alert',15000);
 check(/95%/.test(disk.body),'the disk warning says how full it is');
 await heartbeat(admin,node,'0.6.1.1',[{id:server.id,status:'running',diskBytes:Math.round(2048*1048576*0.95)}]);await sleep(4500);
 check(ok(await ownerC.call('GET','/api/notifications?limit=100'),'inbox').items.filter(n=>n.kind==='server.disk_high').length===1,'the same warning is not repeated');

 // --- Resource history ---------------------------------------------------------------------------------------------------------------------
 for(let i=0;i<3;i++){await heartbeat(admin,node,'0.6.1.1',[{id:server.id,status:'running',diskBytes:1000000,usage:{cpuPercent:10+i*10,memoryBytes:400000000,memoryLimitBytes:1073741824}}]);}
 const hist=ok(await ownerC.call('GET',`${S}/metrics?range=1h`),'metrics');
 check(hist.points.length>=1&&hist.points.reduce((a,p)=>a+p.samples,0)>=3&&hist.resolutionSeconds===60&&hist.memoryLimitBytes===1024*1048576,'heartbeat samples build a history: '+JSON.stringify(hist.points.slice(-1)));
 const last=hist.points[hist.points.length-1];check(last.cpuMax>=30&&last.memory>0,'with averages and peaks');
 check(ok(await ownerC.call('GET',`${S}/metrics?range=30d`),'month').resolutionSeconds===3600,'longer ranges use coarser buckets');
 ownerC.status(await ownerC.call('GET',`${S}/metrics?range=1y`),400,'unknown range');
 strangerC.status(await strangerC.call('GET',`${S}/metrics?range=1h`),404,'strangers cannot read metrics');
 const prom=await fetch(stack.base+'/api/metrics',{headers:{cookie:admin.cookie}}).then(r=>r.text());
 check(/fledge_servers_crash_looping/.test(prom)&&/fledge_schedule_runs/.test(prom)&&/fledge_plugins/.test(prom),'Prometheus has the new series');
 console.log(`PASS ${admin.state.count+ownerC.state.count+strangerC.state.count} assertions: cron, schedule validation, chains with waits, due/missed/failed runs, notification inbox and channels, crash policy and loops, recovery, disk alerts, metrics history`);
}catch(e){failed=e;}
finally{
 hook.close();
 if(failed){console.error('FAIL',failed.message);console.error('--- api log tail ---\n'+stack.api.logs().split('\n').slice(-20).join('\n'));}
 await stack.stop();process.exit(failed?1:0);
}
