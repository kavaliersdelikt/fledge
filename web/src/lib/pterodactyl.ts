export type FledgeTemplate = {
  id: string; name: string; image: string; startup?: string;
  internalPorts: Array<{container:number;offset:number;protocol:'tcp'|'udp'}>;
  env: Record<string,string>; memoryMb:number; cpuPercent:number; diskMb:number;
  editableVariables:string[];
};

type Egg = {
  name?: unknown; startup?: unknown; docker_images?: unknown;
  variables?: unknown; scripts?: unknown; config?: {stop?: unknown};
};

const slug = (value:string) => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,48) || 'pterodactyl-import';

/** Convert the portable parts of a Pterodactyl egg. Install scripts and
 * Pterodactyl's startup interpolation have no safe equivalent in Fledge. */
export function convertPterodactylEgg(input:unknown, options:{image?:string;port?:number;protocol?:'tcp'|'udp'}={}):{template:FledgeTemplate;warnings:string[]} {
  if(!input || typeof input!=='object' || Array.isArray(input)) throw new Error('Paste one Pterodactyl egg export in JSON format.');
  const egg=input as Egg;
  if(typeof egg.name!=='string' || !egg.name.trim()) throw new Error('The egg must include a name.');
  const warnings:string[]=[];
  const images=egg.docker_images && typeof egg.docker_images==='object' && !Array.isArray(egg.docker_images) ? Object.values(egg.docker_images as Record<string,unknown>).filter((v):v is string=>typeof v==='string'&&!!v.trim()) : [];
  const image=options.image?.trim()||images[0]||'';
  if(!image) warnings.push('Choose a Docker image that is available on your nodes and allowed by the Fledge API and agents.');
  else if(images.length) warnings.push('The selected image must exist on your nodes and match the Fledge image allowlist. Pterodactyl daemon images may not be compatible.');
  const env:Record<string,string>={},editableVariables:string[]=[];
  if(Array.isArray(egg.variables)) for(const raw of egg.variables){
    if(!raw||typeof raw!=='object'||Array.isArray(raw)) {warnings.push('Skipped a malformed egg variable.');continue;}
    const v=raw as Record<string,unknown>,key=v.env_variable;
    if(typeof key!=='string'||!/^[A-Z_][A-Z0-9_]*$/.test(key)){warnings.push('Skipped a variable with a name Fledge cannot use.');continue;}
    const value=v.default_value;
    env[key]=value==null?'':typeof value==='string'||typeof value==='number'||typeof value==='boolean'?String(value):'';
    if(v.user_editable===true) editableVariables.push(key);
  }
  if(egg.startup) warnings.push('Pterodactyl startup commands are not copied: their variable interpolation and container entrypoint semantics differ. Fledge will use the selected image entrypoint.');
  if(egg.scripts) warnings.push('Pterodactyl install scripts are not copied. Fledge does not run egg install scripts during provisioning.');
  if(egg.config?.stop) warnings.push('The Pterodactyl stop command is not copied; Fledge stops containers through Docker.');
  if(!Number.isInteger(options.port)||Number(options.port)<1||Number(options.port)>65535) throw new Error('Enter a valid primary container port (1–65535).');
  const protocol=options.protocol||'tcp';
  const name=egg.name.trim().slice(0,100);
  const template:FledgeTemplate={id:slug(name),name,image,startup:'',internalPorts:[{container:Number(options.port),offset:0,protocol}],env,memoryMb:2048,cpuPercent:100,diskMb:10240,editableVariables:[...new Set(editableVariables)].slice(0,30)};
  warnings.push('Pterodactyl eggs do not define public port allocations in a portable way. Review the primary port and protocol before saving.');
  return {template,warnings};
}
