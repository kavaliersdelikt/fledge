import {test} from 'node:test';
import assert from 'node:assert/strict';
import {convertPterodactylEgg} from '../../web/src/lib/pterodactyl.ts';

test('converts a portable Pterodactyl egg into a Fledge template',()=>{
 const result=convertPterodactylEgg({name:'Minecraft Quilt',startup:'java -jar server.jar',docker_images:{Java:'ghcr.io/pterodactyl/yolks:java_21'},variables:[
  {env_variable:'TYPE',default_value:'QUILT',user_editable:false},
  {env_variable:'VERSION',default_value:'1.21.11',user_editable:true},
  {env_variable:'EULA',default_value:'TRUE',user_editable:true}
 ],scripts:{installation:{script:'download code'}}},{image:'itzg/minecraft-server:java21-alpine',port:25565,protocol:'tcp'});
 assert.deepEqual(result.template,{id:'minecraft-quilt',name:'Minecraft Quilt',image:'itzg/minecraft-server:java21-alpine',startup:'java -jar server.jar',internalPorts:[{container:25565,offset:0,protocol:'tcp'}],env:{TYPE:'QUILT',VERSION:'1.21.11',EULA:'TRUE'},memoryMb:2048,cpuPercent:100,diskMb:10240,editableVariables:['VERSION','EULA']});
 assert.equal(result.warnings.length,4);
 assert.match(result.warnings[0],/selected image/);
 assert.match(result.warnings[1],/startup command was copied/);
 assert.match(result.warnings[2],/install scripts/);
});

test('skips invalid variable names and warns about portability',()=>{
 const result=convertPterodactylEgg({name:'Odd Egg',docker_images:{default:'vendor/image:latest'},variables:[{env_variable:'bad-name',default_value:'x'},{env_variable:'SAFE',default_value:4,user_editable:true}],config:{stop:'stop'},startup:'java -Xmx{{SERVER_MEMORY}}M -Dport={{server.build.default.port}} -jar {{SERVER_JARFILE}}'},{image:'vendor/image:latest',port:2456,protocol:'udp'});
 assert.deepEqual(result.template.env,{SAFE:'4'});
 assert.deepEqual(result.template.editableVariables,['SAFE']);
 assert.ok(result.warnings.some(w=>w.includes('cannot use')));
 assert.equal(result.template.stopCommand,'stop');
 assert.equal(result.template.startup,'java -Xmx${SERVER_MEMORY}M -Dport=${SERVER_PORT} -jar ${SERVER_JARFILE}');
 assert.equal(result.template.internalPorts[0].protocol,'udp');
});

test('rejects malformed imports and invalid ports',()=>{
 assert.throws(()=>convertPterodactylEgg('bad'),/Paste one Pterodactyl egg/);
 assert.throws(()=>convertPterodactylEgg({name:'Missing port'},{port:70000}),/valid primary container port/);
});

test('reads the legacy PTDL_v1 image field, normalises ^^C and warns on unknown schemas',()=>{
 const v1=convertPterodactylEgg({meta:{version:'PTDL_v1'},name:'Old Egg',image:'vendor/old:1',config:{stop:'^^C'}},{port:25565});
 assert.equal(v1.template.image,'vendor/old:1');
 assert.equal(v1.template.stopCommand,'^C');
 assert.ok(!v1.warnings.some(w=>w.includes('export format')));
 const unknown=convertPterodactylEgg({meta:{version:'PTDL_v9'},name:'Future Egg',docker_images:{Default:'vendor/new:1'}},{port:25565});
 assert.ok(unknown.warnings.some(w=>w.includes('PTDL_v9')));
});
