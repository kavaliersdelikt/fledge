import cors from '@fastify/cors';
import type {FastifyInstance} from 'fastify';

export const PANEL_CORS_METHODS=['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'] as const;

export async function registerPanelCors(app:FastifyInstance,origin:string){
 const parsed=new URL(origin);
 if(!['http:','https:'].includes(parsed.protocol)||parsed.origin!==origin)throw new Error('WEB_ORIGIN must be one exact HTTP or HTTPS origin (scheme, host, and optional port only)');
 await app.register(cors,{origin,credentials:true,methods:[...PANEL_CORS_METHODS]});
}

