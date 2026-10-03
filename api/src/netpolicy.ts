import type {FastifyRequest} from 'fastify';
import {fail} from './core.js';
import {settings} from './settings.js';
import {ipAllowed} from './cidr.js';

// Optional network restriction for administrator accounts (Settings → Security). It applies to
// browser sessions and API tokens alike. ADMIN_IP_ALLOW_DISABLE=true is the break-glass switch
// for an operator who locked themselves out.
export async function adminNetworkPolicy(req:FastifyRequest){
 if(req.actor?.role!=='admin'||process.env.ADMIN_IP_ALLOW_DISABLE==='true')return;
 const cidrs=(await settings()).security.adminAllowedCidrs;
 if(cidrs.length&&!ipAllowed(req.ip,cidrs))fail(403,'Administrator access is restricted to specific networks, and yours is not one of them.');
}
