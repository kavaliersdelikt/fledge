// Template v2: typed variables, versions, export/import, applying a new version to servers, startup view.
import {bootStack,client,bootstrapAdmin,makeNode,heartbeat,nextJob,finishJob,dbQuery} from './harness.mjs';
import {randomBytes} from 'node:crypto';

const stack=await bootStack({db:'fledge_templates_smoke',apiPort:4175,hostPort:4523,mock:null});
const admin=client(stack.base);const {call,ok,status,check}=admin;
let failed=null;
try{
 await bootstrapAdmin(admin);
 const list=ok(await call('GET','/api/templates'),'templates');
 const mc=list.find(t=>t.id==='minecraft-java');
 check(mc.version===1&&mc.variables.find(v=>v.key==='TYPE').type==='select'&&mc.variables.find(v=>v.key==='MAX_PLAYERS').max===1000,'preinstalled templates ship typed variables');
 check(mc.quickCommands.length>0&&mc.addons&&mc.addons.types.PAPER,'quick commands and add-on rules are part of the template');
 check(list.find(t=>t.id==='valheim').variables.find(v=>v.key==='SERVER_PASS').secret===true,'secret variables are marked');

 // --- Definitions are validated --------------------------------------------------------------------
 const base={id:'t-test',name:'Typed',image:'node:22-slim',startup:'exec node app.js',internalPorts:[{container:3000,offset:0,protocol:'tcp'}],env:{MODE:'prod',API_TOKEN:'hunter2'},memoryMb:256,cpuPercent:100,diskMb:1024};
 const bad=async(label,variables)=>{const r=await call('POST','/api/templates',{...base,variables});status(r,400,label);return r.data.message;};
 await bad('bad key',[{key:'lower',type:'string'}]);
 await bad('duplicate key',[{key:'A',type:'string'},{key:'A',type:'string'}]);
 await bad('unknown type',[{key:'A',type:'color'}]);
 await bad('select without options',[{key:'A',type:'select'}]);
 await bad('non-numeric min',[{key:'A',type:'number',min:'x'}]);
 await bad('broken regular expression',[{key:'A',type:'string',pattern:'([unclosed'}]);
 await bad('not a list','nope');
 const vars=[
  {key:'LEVEL',label:'Level',type:'select',options:[{value:'low',label:'Low'},{value:'high',label:'High'}],userEditable:true},
  {key:'SLOTS',label:'Slots',type:'number',min:1,max:50,userEditable:true},
  {key:'CODE',label:'Code',type:'string',pattern:'^[A-Z]{3}-\\d{2}$',userEditable:true},
  {key:'API_TOKEN',label:'Token',type:'string',secret:true,min:6,userEditable:true},
  {key:'FIXED',label:'Fixed',type:'string',userEditable:false},
 ];
 const t1=ok(await call('POST','/api/templates',{...base,variables:vars,quickCommands:[{label:'Ping',command:'ping'}],description:'A test'}),'create typed template');
 check(t1.version===1&&t1.variables.length===5&&t1.description==='A test','typed template created at version 1');
 status(await call('POST','/api/templates',{...base,variables:vars}),409,'duplicate id');
 status(await call('POST','/api/templates',{...base,id:'t-test2',quickCommands:[{label:'x',command:'a\nb'}]}),400,'quick commands cannot contain line breaks');
 status(await call('POST','/api/templates',{...base,id:'t-test3',image:'evil/image:1'}),403,'images must be allow-listed');

 // --- Servers use the definitions ---------------------------------------------------------------------------
 const customer=ok(await call('POST','/api/customers',{email:'c-'+randomBytes(3).toString('hex')+'@example.test'}),'customer');
 const node=await makeNode(admin,'tpl');await heartbeat(admin,node);
 const server=ok(await call('POST','/api/servers',{name:'Typed',ownerId:customer.id,templateId:'t-test',nodeId:node.id,memoryMb:256,cpuPercent:100,diskMb:1024,port:26000}),'server');
 const create=await nextJob(admin,node);await finishJob(admin,node,create);
 const owner=client(stack.base);ok(await owner.call('POST','/api/auth/login',{email:customer.email,password:customer.temporaryPassword}),'owner login');
 const S=`/api/servers/${server.id}`;
 const set=async(variables)=>owner.call('PATCH',`${S}/settings`,{variables});
 ok(await set({LEVEL:'high',SLOTS:'12',CODE:'ABC-12',API_TOKEN:'abcdef'}),'valid values');
 const cj=await nextJob(admin,node);check(cj.kind==='configure'&&cj.payload.recreate===true,'saving variables recreates the server');await finishJob(admin,node,cj);
 check(ok(await call('GET',S),'server').variables.SLOTS==='12','values are stored as text');
 owner.status(await set({LEVEL:'medium'}),400,'select value outside its options');
 owner.status(await set({SLOTS:'0'}),400,'number below minimum');
 owner.status(await set({SLOTS:'51'}),400,'number above maximum');
 owner.status(await set({SLOTS:'twelve'}),400,'not a number');
 owner.status(await set({CODE:'abc-12'}),400,'pattern mismatch');
 owner.status(await set({API_TOKEN:'abc'}),400,'string shorter than its minimum');
 owner.status(await set({FIXED:'x'}),400,'variables not marked editable cannot be changed');
 owner.status(await set({MODE:'dev'}),400,'variables without a definition cannot be changed');
 owner.status(await set({}),400,'empty change');

 // --- Startup panel -------------------------------------------------------------------------------------------------
 const st=ok(await owner.call('GET',`${S}/startup`),'startup as owner');
 check(st.image==='node:22-slim'&&st.startup===null&&st.templateVersion===1&&!st.outdated,'startup shows the image but not the command to the owner');
 const tok=st.env.find(e=>e.key==='API_TOKEN');check(tok.hidden===true&&tok.value===null&&tok.editable===true,'secret values are hidden from owners');
 const slots=st.env.find(e=>e.key==='SLOTS');check(slots.value==='12'&&slots.source==='server'&&slots.editable,'server values override the template and are editable');
 check(!st.env.some(e=>e.key==='MODE'||e.key==='API_TOKEN'&&e.source==='template'),'template-level environment that no declared variable surfaces is not shown to owners');
 const adminStartup=ok(await call('GET',`${S}/startup`),'startup as admin');check(adminStartup.env.find(e=>e.key==='API_TOKEN').value==='abcdef'&&adminStartup.startup==='exec node app.js'&&adminStartup.env.find(e=>e.key==='MODE').source==='template','admins see everything');
 const stranger=client(stack.base);const other=ok(await call('POST','/api/customers',{email:'o-'+randomBytes(3).toString('hex')+'@example.test'}),'other');ok(await stranger.call('POST','/api/auth/login',{email:other.email,password:other.temporaryPassword}),'other login');
 stranger.status(await stranger.call('GET',`${S}/startup`),404,'strangers cannot see the startup panel');

 // --- Versions -----------------------------------------------------------------------------------------------------------
 const edit=(over)=>call('PUT','/api/templates/t-test',{...base,variables:vars,description:'A test',...over});
 const renamed=ok(await edit({name:'Typed (renamed)'}),'rename only');check(renamed.version===1,'cosmetic changes do not create a version');
 const v2=ok(await edit({env:{MODE:'prod',API_TOKEN:'hunter2',NEW_FLAG:'1'}}),'change env');check(v2.version===2,'a runtime change creates version 2');
 const o1=ok(await call('GET','/api/templates/t-test/outdated'),'outdated');
 check(o1.servers.length===1&&o1.servers[0].fromVersion===1&&o1.servers[0].toVersion===2&&o1.servers[0].changes.some(c=>c.startsWith('environment (NEW_FLAG')),'outdated servers list what would change');
 status(await call('POST','/api/templates/t-test/apply',{}),400,'applying needs confirmation');
 const applied=ok(await call('POST','/api/templates/t-test/apply',{confirm:true}),'apply');
 check(applied.queued===1,'the server is queued for recreation');
 const aj=await nextJob(admin,node);check(aj.kind==='configure'&&aj.payload.recreate&&aj.server.env.NEW_FLAG==='1','the new environment reaches the node');await finishJob(admin,node,aj);
 check(ok(await call('GET','/api/templates/t-test/outdated'),'outdated again').servers.length===0,'nothing left to apply');
 const v3=ok(await edit({internalPorts:[{container:3000,offset:0,protocol:'tcp'},{container:3001,offset:1,protocol:'tcp'}]}),'change ports');
 const o3=ok(await call('GET','/api/templates/t-test/outdated'),'outdated after ports');
 check(v3.version===3&&o3.servers[0].canApply===false&&/port layout/.test(o3.servers[0].blocker),'a changed port layout is never applied to existing servers');
 const skipped=ok(await call('POST','/api/templates/t-test/apply',{confirm:true}),'apply with blocked server');check(skipped.queued===0&&skipped.skipped.length===1,'blocked servers are skipped with a reason');
 const cust=client(stack.base);ok(await cust.call('POST','/api/auth/login',{email:customer.email,password:customer.temporaryPassword}),'login');
 cust.status(await cust.call('PUT','/api/templates/t-test',{...base}),403,'customers cannot edit templates');
 const tl=ok(await cust.call('GET','/api/templates'),'customer list');const ct=tl.find(t=>t.id==='t-test');
 check(ct.startup===null&&ct.env.API_TOKEN==='[configured]'&&ct.variables.length===5,'customers see definitions but never environment or commands');

 // --- Export and import ---------------------------------------------------------------------------------------------------------------
 const doc=ok(await call('GET','/api/templates/t-test/export'),'export');
 check(doc.format==='fledge-template'&&doc.formatVersion===1&&doc.template.env.API_TOKEN==='hunter2'&&doc.template.variables.length===5,'export contains the full template');
 const noEnv=ok(await call('GET','/api/templates/t-test/export?includeEnv=0'),'export without environment');check(Object.keys(noEnv.template.env).length===0,'the environment can be left out');
 await cust.call('GET','/api/templates/t-test/export').then(r=>check(r.code===403,'customers cannot export'));
 const imp=ok(await call('POST','/api/templates/import',{document:doc,id:'t-copy'}),'import under a new id');
 check(imp.template.id==='t-copy'&&imp.template.version===1&&imp.template.variables.length===5,'import creates a copy');
 status(await call('POST','/api/templates/import',{document:doc,id:'t-copy'}),409,'import refuses to overwrite by default');
 ok(await call('POST','/api/templates/import',{document:{...doc,template:{...doc.template,description:'changed'}},id:'t-copy',overwrite:true}),'import with overwrite');
 status(await call('POST','/api/templates/import',{document:{format:'other'}}),400,'foreign documents are refused');
 status(await call('POST','/api/templates/import',{document:{...doc,template:{...doc.template,image:'evil/image:1'}},id:'t-evil'}),403,'imports respect the image allow-list');
 status(await call('POST','/api/templates/import',{document:{...doc,template:{...doc.template,env:{'bad key':'x'}}},id:'t-bad'}),400,'imports are validated like any template');
 status(await call('POST','/api/templates/import',{document:{...doc,template:{...doc.template,variables:[{key:'x',type:'string'}]}},id:'t-bad2'}),400,'including variable definitions');

 // --- Legacy templates keep working ---------------------------------------------------------------------------------------------
 ok(await call('POST','/api/templates',{id:'legacy',name:'Legacy',image:'node:22-slim',internalPorts:[{container:3000,offset:0,protocol:'tcp'}],env:{MOTD:'x'},editableVariables:['MOTD']}),'template with only editableVariables');
 const lt=ok(await call('GET','/api/templates'),'list').find(t=>t.id==='legacy');check(lt.variables.length===1&&lt.variables[0].key==='MOTD'&&lt.variables[0].type==='string'&&lt.variables[0].userEditable,'legacy editable variables appear as plain text fields');

 // --- Deleting ---------------------------------------------------------------------------------------------------------------------------
 status(await call('DELETE','/api/templates/minecraft-java'),409,'preinstalled templates cannot be deleted');
 status(await call('DELETE','/api/templates/t-test'),409,'templates in use cannot be deleted');
 ok(await call('DELETE','/api/templates/t-copy'),'delete an unused template');
 status(await call('DELETE','/api/templates/t-copy'),404,'deleting twice');
 const audit=ok(await call('GET','/api/activity?limit=100'),'activity');
 for(const a of ['template.create','template.update','template.apply','template.import','template.delete'])check(audit.some(x=>x.action===a),'audit trail has '+a);
 const hist=await dbQuery(stack.databaseUrl,"SELECT count(*)::int n FROM template_versions WHERE template_id='t-test'");check(hist[0].n===3,'every runtime change keeps a snapshot');
 console.log(`PASS ${admin.state.count+owner.state.count} assertions: typed variables, validation, startup panel, versions and apply, export/import, legacy templates, deletion`);
}catch(e){failed=e;}
finally{
 if(failed){console.error('FAIL',failed.message);console.error('--- api log tail ---\n'+stack.api.logs().split('\n').slice(-15).join('\n'));}
 await stack.stop();process.exit(failed?1:0);
}
