// The built-in email templates. Administrators can edit the subject and body of each one in
// Settings, Email; "reset" returns to what is written here.
//
// Body markup (kept deliberately small):
//   blank line          starts a new paragraph
//   - item              a bullet list
//   [button: Label | https://link]   a call-to-action button (plain "Label: link" in the text version)
//   **bold**            bold text
//   {{name}}            a variable (the list is shown next to each template)
//   {{#if name}}…{{/if}} shown only when the variable is not empty

export type TemplateVar={name:string;help:string;sample:string};
export type TemplateDef={id:string;label:string;group:'Account'|'Billing'|'Limits'|'Administrators'|'System';audience:'customer'|'admin';critical:boolean;description:string;vars:TemplateVar[];subject:string;body:string;bccAdmin?:boolean};

/** Available in every template. */
export const COMMON_VARS:TemplateVar[]=[
 {name:'brand',help:'The panel name',sample:'Fledge'},{name:'panelUrl',help:'Address of the panel',sample:'https://panel.example.com'},
 {name:'email',help:'The recipient’s email address',sample:'alex@example.com'},{name:'supportEmail',help:'Your support address (Settings, Store)',sample:'support@example.com'},
 {name:'companyName',help:'Your company name (Settings, Store)',sample:'Example Hosting Ltd'},{name:'companyAddress',help:'Your postal address (Settings, Store)',sample:'1 Example Street, Exampleville'},{name:'year',help:'The current year',sample:'2026'},
];
const v=(name:string,help:string,sample:string):TemplateVar=>({name,help,sample});
const link=v('link','The one-time link','https://panel.example.com/?token=abc');
const server=[v('serverName','Name of the server','Survival SMP')];
const money=[v('amount','Amount with currency, for example €8.00','€8.00'),v('planName','Name of the plan','Minecraft 4 GB')];
const billingUrl=v('billingUrl','Link to the customer’s billing page','https://panel.example.com/billing');

export const TEMPLATES:TemplateDef[]=[
 // ---- Account ----
 {id:'verify_email',label:'Verify your email address',group:'Account',audience:'customer',critical:true,description:'Sent when someone signs up. The account stays locked until the link is used.',vars:[link,v('hours','How long the link works','24')],
  subject:'Confirm your email for {{brand}}',
  body:'Welcome to {{brand}}!\n\nConfirm your email address to finish creating your account. The link works for {{hours}} hours.\n\n[button: Confirm email address | {{link}}]\n\nIf you did not sign up, you can ignore this message.'},
 {id:'welcome',label:'Welcome',group:'Account',audience:'customer',critical:false,description:'Sent once the account is active.',vars:[],
  subject:'Welcome to {{brand}}',
  body:'Your account is ready.\n\n[button: Open {{brand}} | {{panelUrl}}]\n\nIf you need help, reply to this email{{#if supportEmail}} or write to {{supportEmail}}{{/if}}.'},
 {id:'already_registered',label:'Address already registered',group:'Account',audience:'customer',critical:true,description:'Sent instead of an error when someone signs up with an address that already has an account, so sign-up never reveals who has one.',vars:[v('resetUrl','Link to the password reset page','https://panel.example.com/')],
  subject:'You already have a {{brand}} account',
  body:'Someone (hopefully you) tried to sign up to {{brand}} with this address, but it already has an account.\n\n[button: Sign in | {{panelUrl}}]\n\nForgot your password? Use “Forgot password” on the sign-in page. If this was not you, nothing has changed and you can ignore this message.'},
 {id:'invite',label:'Invitation',group:'Account',audience:'customer',critical:true,description:'Sent when an administrator invites a customer.',vars:[link,v('days','How long the link works','7')],
  subject:'You have been invited to {{brand}}',
  body:'You have been invited to {{brand}}, the game server panel.\n\nSet your password with the link below. It works for {{days}} days.\n\n[button: Set your password | {{link}}]'},
 {id:'password_reset',label:'Password reset',group:'Account',audience:'customer',critical:true,description:'Sent when someone asks to reset their password.',vars:[link,v('duration','How long the link works','one hour')],
  subject:'Reset your {{brand}} password',
  body:'Someone asked to reset the password for this {{brand}} account.\n\nChoose a new password with the link below. It works for {{duration}} and can be used once.\n\n[button: Choose a new password | {{link}}]\n\nIf you did not ask for this, you can ignore this message; your password has not changed.'},
 {id:'password_changed',label:'Password changed',group:'Account',audience:'customer',critical:true,description:'A security notice after a password change or reset.',vars:[v('when','When it happened','3 Oct 2026, 14:05 UTC')],
  subject:'Your {{brand}} password was changed',
  body:'The password for your {{brand}} account was changed on {{when}}.\n\nAll other sign-ins were signed out. If this was not you, reset your password right away and contact us.\n\n[button: Reset password | {{panelUrl}}]'},
 {id:'email_change_verify',label:'Confirm your new address',group:'Account',audience:'customer',critical:true,description:'Sent to the new address when someone changes their email.',vars:[link,v('newEmail','The new address','new@example.com'),v('hours','How long the link works','24')],
  subject:'Confirm your new email for {{brand}}',
  body:'Confirm that {{newEmail}} is your new email address for {{brand}}. The link works for {{hours}} hours.\n\n[button: Confirm new address | {{link}}]\n\nIf you did not ask for this, ignore this message.'},
 {id:'email_changed',label:'Email address changed',group:'Account',audience:'customer',critical:true,description:'A security notice sent to the old address after a change.',vars:[v('newEmail','The new address','new@example.com')],
  subject:'The email for your {{brand}} account was changed',
  body:'The email address of your {{brand}} account was changed to {{newEmail}}.\n\nIf this was not you, contact us immediately{{#if supportEmail}} at {{supportEmail}}{{/if}}.'},
 {id:'approval_pending',label:'Waiting for approval',group:'Account',audience:'customer',critical:false,description:'Sent when sign-up needs an administrator’s approval.',vars:[],
  subject:'Your {{brand}} account is waiting for approval',
  body:'Thanks for confirming your address. An administrator will review your account shortly, and we will email you as soon as it is approved.'},
 {id:'account_approved',label:'Account approved',group:'Account',audience:'customer',critical:false,description:'Sent when an administrator approves a sign-up.',vars:[],
  subject:'Your {{brand}} account was approved',
  body:'Good news: your account was approved.\n\n[button: Sign in | {{panelUrl}}]'},
 {id:'account_rejected',label:'Account declined',group:'Account',audience:'customer',critical:false,description:'Sent when an administrator declines a sign-up.',vars:[],
  subject:'About your {{brand}} account',
  body:'We are sorry, but we could not approve your account.{{#if supportEmail}} If you think this is a mistake, write to {{supportEmail}}.{{/if}}'},
 {id:'deletion_scheduled',label:'Account deletion scheduled',group:'Account',audience:'customer',critical:true,description:'Sent when someone asks to delete their account.',vars:[v('date','When it will be deleted','17 Oct 2026')],
  subject:'Your {{brand}} account will be deleted',
  body:'Your account is scheduled for deletion on {{date}}. Until then you can sign in and cancel this.\n\n[button: Keep my account | {{panelUrl}}]'},
 {id:'account_deleted',label:'Account deleted',group:'Account',audience:'customer',critical:true,description:'Sent after an account was deleted.',vars:[],
  subject:'Your {{brand}} account was deleted',
  body:'Your account and its personal data were deleted. Invoices are kept in anonymised form for as long as the law requires.'},

 // ---- Billing ----
 {id:'payment_receipt',label:'Payment received',group:'Billing',audience:'customer',critical:false,description:'The receipt after a successful payment.',bccAdmin:true,vars:[...money,v('invoiceUrl','Link to the invoice or receipt','https://pay.example.com/invoice'),v('periodEnd','End of the paid period','3 Nov 2026'),v('interval','Billing interval, for example monthly','monthly'),billingUrl],
  subject:'Receipt for {{amount}} — {{planName}}',
  body:'Thank you! We received your payment of **{{amount}}** for **{{planName}}** ({{interval}}).\n\n{{#if periodEnd}}Paid until {{periodEnd}}.{{/if}}\n\n[button: View invoice | {{invoiceUrl}}]\n\nManage your subscription any time in {{billingUrl}}.'},
 {id:'server_ready',label:'Your server is ready',group:'Billing',audience:'customer',critical:false,description:'Sent when a purchased server has been created.',vars:[...server,v('planName','Name of the plan','Minecraft 4 GB'),v('serverUrl','Link to the server','https://panel.example.com/servers/abc')],
  subject:'Your server {{serverName}} is ready',
  body:'Your **{{planName}}** server **{{serverName}}** has been created and is starting up.\n\n[button: Open the server | {{serverUrl}}]'},
 {id:'provisioning_delayed',label:'Setting up your server',group:'Billing',audience:'customer',critical:false,description:'Sent when payment worked but the server cannot be created yet.',vars:[v('planName','Name of the plan','Minecraft 4 GB')],
  subject:'We are setting up your {{planName}} server',
  body:'Your payment went through, but we need a little more time to set up your server. We keep trying automatically and will email you as soon as it is ready. You do not need to do anything.'},
 {id:'payment_failed',label:'Payment failed',group:'Billing',audience:'customer',critical:true,description:'The first notice when a renewal payment fails.',vars:[...money,v('retryDate','When the next attempt happens','6 Oct 2026'),v('suspendDate','When the server will be suspended','10 Oct 2026'),billingUrl],
  subject:'Your payment for {{planName}} failed',
  body:'We could not collect **{{amount}}** for **{{planName}}**.\n\nPlease update your payment method so your server keeps running.{{#if suspendDate}} If it stays unpaid, the server will be suspended on {{suspendDate}}.{{/if}}\n\n[button: Update payment method | {{billingUrl}}]'},
 {id:'payment_reminder',label:'Payment still missing',group:'Billing',audience:'customer',critical:true,description:'A reminder while a payment is overdue.',vars:[...money,v('suspendDate','When the server will be suspended','10 Oct 2026'),billingUrl],
  subject:'Reminder: payment for {{planName}} is overdue',
  body:'Your payment of **{{amount}}** for **{{planName}}** is still unpaid.{{#if suspendDate}} Your server will be suspended on {{suspendDate}}.{{/if}}\n\n[button: Pay now | {{billingUrl}}]'},
 {id:'payment_final',label:'Final payment warning',group:'Billing',audience:'customer',critical:true,description:'The last warning before termination.',vars:[...money,v('terminateDate','When the server and its data will be deleted','2 Nov 2026'),billingUrl],
  subject:'Final notice: {{planName}} will be deleted',
  body:'Your **{{planName}}** subscription is overdue and the server is suspended.{{#if terminateDate}} If it is not paid by **{{terminateDate}}**, the server and its data will be deleted.{{/if}}\n\n[button: Pay now | {{billingUrl}}]'},
 {id:'server_suspended_billing',label:'Server suspended for billing',group:'Billing',audience:'customer',critical:true,description:'Sent when a server is suspended because of an unpaid invoice.',vars:[...server,...money,billingUrl],
  subject:'{{serverName}} was suspended',
  body:'**{{serverName}}** was suspended because the payment for **{{planName}}** is overdue. Your data is kept.\n\nPay the open invoice and the server starts again by itself.\n\n[button: Pay now | {{billingUrl}}]'},
 {id:'server_resumed',label:'Server running again',group:'Billing',audience:'customer',critical:false,description:'Sent when a payment lifts a billing suspension.',vars:[...server],
  subject:'{{serverName}} is running again',
  body:'Thank you, your payment arrived. **{{serverName}}** is starting again.'},
 {id:'subscription_canceled',label:'Cancellation confirmed',group:'Billing',audience:'customer',critical:false,description:'Sent when a subscription is set to end.',vars:[...money,v('endDate','When access ends','3 Nov 2026'),v('retentionDate','Until when the data is kept','3 Dec 2026'),billingUrl],
  subject:'Your {{planName}} subscription will end',
  body:'Your **{{planName}}** subscription is canceled and ends on **{{endDate}}**. Until then everything keeps working.{{#if retentionDate}} After that we keep your data until {{retentionDate}}, in case you change your mind.{{/if}}\n\n[button: Resume subscription | {{billingUrl}}]'},
 {id:'subscription_ended',label:'Subscription ended',group:'Billing',audience:'customer',critical:false,description:'Sent when access ends.',vars:[...money,v('retentionDate','Until when the data is kept','3 Dec 2026'),billingUrl],
  subject:'Your {{planName}} subscription has ended',
  body:'Your **{{planName}}** subscription has ended and the server was stopped.{{#if retentionDate}} Your data is kept until {{retentionDate}}. Subscribe again before then to get everything back.{{/if}}\n\n[button: Subscribe again | {{billingUrl}}]'},
 {id:'subscription_resumed',label:'Subscription resumed',group:'Billing',audience:'customer',critical:false,description:'Sent when a canceled subscription is resumed.',vars:[...money],
  subject:'Your {{planName}} subscription continues',
  body:'Your **{{planName}}** subscription will continue as before. Nothing else is needed.'},
 {id:'renewal_upcoming',label:'Renewal reminder',group:'Billing',audience:'customer',critical:false,description:'Sent a few days before a renewal.',vars:[...money,v('date','Renewal date','3 Nov 2026'),billingUrl],
  subject:'Your {{planName}} renews on {{date}}',
  body:'Your **{{planName}}** subscription renews on **{{date}}** for **{{amount}}**.\n\n[button: Manage subscription | {{billingUrl}}]'},
 {id:'trial_ending',label:'Trial ending',group:'Billing',audience:'customer',critical:false,description:'Sent shortly before a trial turns into a paid subscription.',vars:[...money,v('date','When the trial ends','6 Oct 2026'),billingUrl],
  subject:'Your trial of {{planName}} ends on {{date}}',
  body:'Your trial of **{{planName}}** ends on **{{date}}**. After that **{{amount}}** is charged to your card. Cancel before then if you do not want to continue.\n\n[button: Manage subscription | {{billingUrl}}]'},
 {id:'plan_changed',label:'Plan changed',group:'Billing',audience:'customer',critical:false,description:'Sent after an upgrade or downgrade.',vars:[...money,v('oldPlanName','Previous plan','Minecraft 2 GB'),v('effective','When it takes effect','now'),billingUrl],
  subject:'Your plan changed to {{planName}}',
  body:'Your plan changed from **{{oldPlanName}}** to **{{planName}}** ({{effective}}).\n\n[button: View subscription | {{billingUrl}}]'},
 {id:'refund_issued',label:'Refund issued',group:'Billing',audience:'customer',critical:false,description:'Sent when a payment was refunded.',vars:[v('amount','Refunded amount','€8.00'),v('planName','Plan','Minecraft 4 GB'),v('invoiceUrl','Link to the invoice','https://pay.example.com/invoice')],
  subject:'Refund of {{amount}}',
  body:'We refunded **{{amount}}** for **{{planName}}**. It can take a few days to appear on your statement.\n\n[button: View invoice | {{invoiceUrl}}]'},

 // ---- Limits ----
 {id:'limit_nearly',label:'Close to a limit',group:'Limits',audience:'customer',critical:false,description:'Sent when usage reaches the warning threshold.',vars:[v('detail','What is nearly used up','12 of 14 GB memory in use'),billingUrl],
  subject:'You are close to a limit on {{brand}}',
  body:'{{detail}}\n\nIf you need more, you can upgrade your plan.\n\n[button: See your usage | {{panelUrl}}]'},
 {id:'limit_reached',label:'Limit reached',group:'Limits',audience:'customer',critical:false,description:'Sent when a limit blocks or warns about an action.',vars:[v('detail','What was blocked','This would exceed the limit of 2 servers (2 in use, 1 requested).')],
  subject:'A limit was reached on {{brand}}',
  body:'{{detail}}\n\n[button: See your usage | {{panelUrl}}]'},

 // ---- Administrators ----
 {id:'admin_approval_needed',label:'Customer waiting for approval',group:'Administrators',audience:'admin',critical:false,description:'Sent to the administrator copy address when sign-up needs approval.',vars:[v('customerEmail','The new customer','new@example.com'),link],
  subject:'[{{brand}}] {{customerEmail}} is waiting for approval',
  body:'**{{customerEmail}}** signed up and confirmed their address.\n\n[button: Review customers | {{link}}]'},
 {id:'admin_fulfilment_failed',label:'Paid server could not be created',group:'Administrators',audience:'admin',critical:false,description:'A customer paid but their server could not be placed.',vars:[v('customerEmail','The customer','new@example.com'),v('planName','Plan','Minecraft 4 GB'),v('error','What went wrong','No capacity'),link],
  subject:'[{{brand}}] A paid server could not be created',
  body:'**{{customerEmail}}** paid for **{{planName}}**, but the server could not be created: {{error}}\n\nWe keep retrying. You can also refund and cancel from the subscription.\n\n[button: Open the subscription | {{link}}]'},
 {id:'admin_dispute',label:'Payment dispute opened',group:'Administrators',audience:'admin',critical:false,description:'A customer disputed a payment.',vars:[v('customerEmail','The customer','new@example.com'),v('planName','Plan','Minecraft 4 GB'),link],
  subject:'[{{brand}}] Payment dispute from {{customerEmail}}',
  body:'**{{customerEmail}}** disputed a payment for **{{planName}}**. The server is on hold while you respond to the dispute with your payment provider.\n\n[button: Open the subscription | {{link}}]'},
 {id:'admin_billing_health',label:'Billing needs attention',group:'Administrators',audience:'admin',critical:false,description:'Webhooks failing, drift repaired or provider unreachable.',vars:[v('detail','What needs attention','3 webhook events failed')],
  subject:'[{{brand}}] Billing needs attention',
  body:'{{detail}}\n\nOpen Billing, Health for details.'},

 // ---- System ----
 {id:'test',label:'Test email',group:'System',audience:'admin',critical:true,description:'Sent by “Send a test email”.',vars:[],
  subject:'{{brand}} test email',
  body:'If you can read this, {{brand}} can send email.'},
];

export const templateById=(id:string)=>TEMPLATES.find(t=>t.id===id);
