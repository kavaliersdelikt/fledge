// Documentation images from the shipped VM UI and a real guest's sockets.
import {execFileSync} from 'node:child_process';
import {seedVM} from './vm-demo.mjs';
export async function captureVM({demo,seeded,page,session,save}){
 const vm=await seedVM(demo,seeded.customer.id);
 try{
  const catalogue=async()=>{await session(demo.c);await page.goto(demo.webUrl+'/virtualization');await page.getByRole('heading',{name:'Virtual machines',exact:true}).waitFor();await page.getByRole('tab',{name:'Media',exact:true}).click();await page.getByRole('heading',{name:'Import a verified image',exact:true}).waitFor();await page.evaluate(()=>document.fonts.ready);await save('vm-catalogue')};
  if(process.env.ONLY==='vm-catalogue'){await catalogue();return;}
  if(process.env.VM_RELAY_CONTAINER){
   if(!/^[A-Za-z0-9_.-]+$/.test(process.env.VM_RELAY_CONTAINER)||!process.env.VM_RELAY_SCRIPT)throw Error('Set the disposable relay container and its bounded Linux script');
   execFileSync('docker',['exec','-d',process.env.VM_RELAY_CONTAINER,'sh',process.env.VM_RELAY_SCRIPT],{stdio:'inherit'});
  }
  await seeded.owner.call('PUT','/api/auth/preferences',{mode:'dark'});
  await session(seeded.owner);await page.setViewportSize({width:1360,height:960});
  await page.goto(demo.webUrl+'/servers/'+vm.id);await page.getByRole('heading',{name:'Alpine Linux',exact:true}).waitFor();
  await page.getByRole('heading',{name:'Hardware',exact:true}).waitFor();await save('vm-overview');
  await page.getByRole('tab',{name:'Console',exact:true}).click();
  const connected=()=>page.getByRole('status').filter({hasText:/^Connected$/}).waitFor({timeout:30000});
  await connected();await page.locator('.vm-console__screen canvas').waitFor();await page.waitForTimeout(1500);
  if(await page.locator('.vm-console__screen canvas').evaluate(c=>c.width<100||c.height<100))throw Error('No real guest framebuffer');
  await save('vm-console');
  await page.getByRole('button',{name:'Reconnect',exact:true}).click();await connected();
  await page.getByRole('button',{name:'Fullscreen',exact:true}).click();await page.waitForFunction(()=>!!document.fullscreenElement);await page.getByRole('button',{name:'Exit fullscreen',exact:true}).click();await page.waitForFunction(()=>!document.fullscreenElement);
  await page.getByRole('button',{name:'Serial',exact:true}).click();await connected();await page.locator('.vm-console__screen').click();await page.keyboard.press('Enter');await page.waitForTimeout(1000);await save('vm-serial');
  for(const [tab,name] of [['Disks','vm-disks'],['Network','vm-network'],['Installation','vm-installation'],['Recovery','vm-recovery']]){
   await page.getByRole('tab',{name:tab,exact:true}).click();await page.waitForTimeout(250);await save(name);
  }
  await page.setViewportSize({width:390,height:844});await page.getByRole('tab',{name:'Overview',exact:true}).click();await save('vm-mobile');
  await page.setViewportSize({width:1360,height:960});await seeded.owner.call('PUT','/api/auth/preferences',{mode:'light'});await page.reload();await page.getByRole('heading',{name:'Hardware',exact:true}).waitFor();await save('vm-light');
  await catalogue();
  console.log('Real guest desktop/serial, reconnect, fullscreen and VM screenshots passed');
 }finally{vm.stop()}
}
