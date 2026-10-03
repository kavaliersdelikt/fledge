// Small built-in lists used by sign-up. They are a speed bump, not a guarantee: the
// administrator can add domains to block, and email verification is the real gate.

/** Throw-away mailbox providers. */
export const DISPOSABLE_DOMAINS=new Set(`
mailinator.com guerrillamail.com guerrillamail.net guerrillamail.org guerrillamailblock.com sharklasers.com grr.la 10minutemail.com 10minutemail.net 20minutemail.com
tempmail.com temp-mail.org temp-mail.io tempmailo.com tempail.com tmpmail.org tmpmail.net trashmail.com trashmail.net trashmail.de yopmail.com yopmail.net yopmail.fr
getnada.com nada.email dispostable.com maildrop.cc mailnesia.com mailcatch.com mintemail.com spambox.us spam4.me spamgourmet.com throwawaymail.com throam.com
fakeinbox.com fakemail.net fake-mail.net emailondeck.com mohmal.com mytemp.email burnermail.io discard.email discardmail.com discardmail.de dropmail.me
getairmail.com harakirimail.com incognitomail.org instantemailaddress.com jetable.org mail-temporaire.fr mailforspam.com mailmoat.com mailnull.com mailtemp.info
minuteinbox.com moakt.com mt2015.com mvrht.net nowmymail.com owlymail.com proxymail.eu rcpt.at receiveee.com safetymail.info selfdestructingmail.com
smailpro.com spamex.com superrito.com tempinbox.com tempr.email tempmailaddress.com tempsky.com thankyou2010.com trbvm.com trbvn.com wegwerfmail.de wegwerfmail.net
yepmail.net zetmail.com 1secmail.com 1secmail.org 1secmail.net kzccv.com qiott.com wuuvo.com icznn.com ezztt.com vjuum.com laafd.com txcct.com
emailfake.com email-fake.com crazymailing.com cuvox.de dayrep.com einrot.com fleckens.hu gustr.com jourrapide.com rhyta.com superrito.com teleworm.us armyspy.com
`.split(/\s+/).filter(Boolean));

/** 12+ character passwords that show up in every breach list, plus the usual patterns. */
const COMMON=new Set(`
passwordpassword password1234 password12345 password123456 passw0rd1234 p@ssw0rd1234 123456789012 1234567890123 12345678901234 123456789abc 111111111111 000000000000
qwertyuiop12 qwertyuiopas qwertyuiop123 qwertyuiopasdf qwertyuiop1234 1qaz2wsx3edc 1q2w3e4r5t6y 1q2w3e4r5t6y7u zaq12wsxcde3 qazwsxedcrfv asdfghjkl123 asdfghjklqwe zxcvbnm12345
iloveyou1234 iloveyou12345 iloveyou123456 letmein12345 letmein123456 welcome12345 welcome123456 welcome1234567 administrator adminadmin123 admin1234567 admin12345678 administrator1
changeme1234 changeme12345 changemenow1 monkey123456 dragon123456 football1234 baseball1234 superman1234 trustno1trustno1 abc123abc123 abcdefghijkl abcdefghijkl1 abcd12345678
minecraft1234 minecraft12345 minecraft123456 mypassword123 mypassword1234 mypassword12345 thisismypassword secretpassword secret123456 passwordis123 samsung12345 princess1234
`.split(/\s+/).filter(Boolean));

export function weakPassword(password:string,email=''):string|null{
 const p=password.toLowerCase();
 if(COMMON.has(p))return 'That password is on lists of passwords attackers try first. Choose something longer and less predictable.';
 if(new Set(p).size<=3)return 'That password repeats too few characters.';
 for(let period=1;period<=4;period++){
  if(p.length>=period*3&&p===p.slice(0,period).repeat(Math.ceil(p.length/period)).slice(0,p.length))return 'That password is a repeating pattern.';
 }
 const codes=[...p].map(c=>c.charCodeAt(0));
 const step=(d:number)=>codes.slice(1).every((c,i)=>c-codes[i]===d);
 if(codes.length>=8&&(step(1)||step(-1)))return 'That password is a simple sequence.';
 const local=email.split('@')[0]?.toLowerCase().replace(/[^a-z0-9]/g,'')||'';
 if(local.length>=4&&p.replace(/[^a-z0-9]/g,'').includes(local))return 'The password must not contain your email address.';
 return null;
}

export function domainOf(email:string){return email.slice(email.lastIndexOf('@')+1).toLowerCase();}
/** True when the domain, or a parent of it, is in the set. */
export function domainMatches(domain:string,list:Iterable<string>|Set<string>){
 const set=list instanceof Set?list:new Set(list);
 const parts=domain.split('.');
 for(let i=0;i<parts.length-1;i++)if(set.has(parts.slice(i).join('.')))return true;
 return false;
}
