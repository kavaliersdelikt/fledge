import {settings} from '../settings.js';
import {callPlugin,getPlugin,type PluginRow} from '../plugins/manager.js';
import type {ProviderStatus} from './states.js';

// The payments contract. A payment plugin declares `payments` in its manifest, holds the
// "payments" permission and implements the methods below inside the plugin sandbox. Fledge
// owns orders, subscriptions, entitlements and emails; the plugin only translates between
// those and one payment provider (Stripe, for the bundled plugin).
//
// Every method returns plain data. Dates are ISO strings, amounts are integers in the
// currency's smallest unit. Nothing a plugin returns is trusted as an amount to charge: the
// core compares against its own records.

export type SubSnapshot={id:string;status:ProviderStatus;currentPeriodStart?:string|null;currentPeriodEnd?:string|null;cancelAtPeriodEnd?:boolean;trialEnd?:string|null;canceledAt?:string|null;endedAt?:string|null;
 amount?:number;currency?:string;customerId?:string|null;latestInvoiceId?:string|null;metadata?:Record<string,string>;livemode?:boolean};
export type InvoiceSnapshot={id:string;subscriptionId?:string|null;customerId?:string|null;status:'draft'|'open'|'paid'|'void'|'uncollectible';number?:string|null;amountDue:number;amountPaid:number;amountRefunded?:number;currency:string;
 periodStart?:string|null;periodEnd?:string|null;hostedUrl?:string|null;pdfUrl?:string|null;paidAt?:string|null;description?:string|null;attemptCount?:number;livemode?:boolean};
export type SessionSnapshot={id:string;status:'open'|'complete'|'expired';paid:boolean;subscriptionId?:string|null;customerId?:string|null;orderId?:string|null;livemode?:boolean};
/** What a webhook turns into. `kind` tells the core what to look at again. */
export type WebhookEvent={id:string;type:string;kind:'checkout'|'subscription'|'invoice'|'refund'|'dispute_opened'|'dispute_closed'|'ignore';livemode:boolean;
 refs:{sessionId?:string;subscriptionId?:string;invoiceId?:string;customerId?:string;disputeId?:string};won?:boolean};

export type CheckoutInput={
 order:{id:string;planName:string;description:string;cycle:string;amount:number;currency:string;trialDays:number;setupFee:number};
 customer:{userId:string;email:string;providerCustomerId:string|null};
 urls:{success:string;cancel:string};
 options:{automaticTax:boolean;collectAddress:boolean;collectTaxId:boolean;promoCodes:boolean};
};
export type ChangeInput={subscriptionId:string;itemName:string;amount:number;currency:string;cycle:string;prorate:boolean};

export type ProviderInfo={id:string;pluginId:string;name:string;plugin:PluginRow};
/** The payment plugin chosen in Settings, Billing, if it is installed, switched on and trusted. */
export async function activeProvider():Promise<ProviderInfo|null>{
 const id=(await settings()).billing.provider;
 if(!id)return null;
 const p=await getPlugin(id);
 if(!p||!p.enabled||!p.manifest.payments||!p.granted_permissions.includes('payments'))return null;
 return {id:p.manifest.payments.id,pluginId:p.id,name:p.manifest.payments.label||p.name,plugin:p};
}
export async function requireProvider():Promise<ProviderInfo>{
 const p=await activeProvider();
 if(!p)throw Object.assign(new Error('Payments are not available right now.'),{statusCode:503,error:'payments_unavailable'});
 return p;
}

const call=async<T>(method:string,args:unknown[],ms=20000):Promise<T>=>{
 const p=await requireProvider();
 return callPlugin<T>(p.pluginId,method,args,{limits:{deadlineMs:ms}});
};
export const provider={
 health:()=>call<{ok:boolean;message?:string;livemode?:boolean;account?:string}>('healthCheck',[],15000),
 createCheckout:(i:CheckoutInput)=>call<{url:string;sessionId:string;customerId?:string|null;livemode?:boolean}>('createCheckout',[i]),
 createPortal:(customerId:string,returnUrl:string)=>call<{url:string}>('createPortal',[customerId,returnUrl]),
 reconcile:(refs:{subscriptionId?:string;sessionId?:string;invoiceId?:string})=>call<{subscription?:SubSnapshot|null;session?:SessionSnapshot|null;invoice?:InvoiceSnapshot|null}>('reconcile',[refs]),
 /** Verifies the signature and turns the request into events. `ok:false` means the request is not from the provider. */
 webhook:(req:{body:string;headers:Record<string,string>})=>call<{ok:boolean;error?:string;events:WebhookEvent[]}>('webhook',[req]),
 cancel:(subscriptionId:string,when:'period_end'|'now')=>call<{ok:boolean}>('cancel',[subscriptionId,when]),
 resume:(subscriptionId:string)=>call<{ok:boolean}>('resume',[subscriptionId]),
 changePlan:(i:ChangeInput)=>call<{ok:boolean}>('changePlan',[i]),
 refund:(invoiceId:string,amount?:number)=>call<{ok:boolean;refundId?:string}>('refund',[invoiceId,amount??null]),
};
