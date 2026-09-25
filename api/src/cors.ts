import cors from '@fastify/cors';
import type {FastifyInstance} from 'fastify';

export const PANEL_CORS_METHODS=['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'] as const;

export async function registerPanelCors(app:FastifyInstance,origin:string){
 await app.register(cors,{origin,credentials:true,methods:[...PANEL_CORS_METHODS]});
}

