// Money is always an integer in the currency's smallest unit ("minor units"), never a float.

export type Interval='month'|'quarter'|'semiannual'|'year';
export const INTERVALS:Record<Interval,{months:number;adjective:string;per:string;order:number}>={
 month:{months:1,adjective:'monthly',per:'month',order:1},
 quarter:{months:3,adjective:'quarterly',per:'3 months',order:2},
 semiannual:{months:6,adjective:'every 6 months',per:'6 months',order:3},
 year:{months:12,adjective:'yearly',per:'year',order:4},
};
export const isInterval=(v:unknown):v is Interval=>typeof v==='string'&&Object.prototype.hasOwnProperty.call(INTERVALS,v);

/** Digits after the decimal point for a currency (2 for EUR, 0 for JPY, 3 for BHD). */
export function exponent(currency:string):number{
 try{return new Intl.NumberFormat('en',{style:'currency',currency:currency.toUpperCase()}).resolvedOptions().maximumFractionDigits??2;}catch{return 2;}
}
export function validCurrency(currency:string):boolean{
 if(!/^[a-z]{3}$/i.test(currency))return false;
 try{new Intl.NumberFormat('en',{style:'currency',currency:currency.toUpperCase()});return true;}catch{return false;}
}

const asInt=(minor:number|bigint|string):number=>{const n=typeof minor==='bigint'?Number(minor):typeof minor==='string'?Number(minor):minor;return Number.isFinite(n)?Math.trunc(n):0;};

/** 850 + "eur" -> "€8.50". */
export function formatMoney(minor:number|bigint|string,currency:string,locale='en'):string{
 const e=exponent(currency),n=asInt(minor)/10**e;
 try{return new Intl.NumberFormat(locale,{style:'currency',currency:currency.toUpperCase(),minimumFractionDigits:e,maximumFractionDigits:e}).format(n);}catch{return `${n.toFixed(e)} ${currency.toUpperCase()}`;}
}

/** Parses what an administrator typed ("8", "8.5", "8,50") into minor units without using floating point. Throws on garbage. */
export function parseMajor(input:string|number,currency:string):number{
 const e=exponent(currency);
 const text=String(input).trim().replace(',','.');
 if(!/^\d{1,9}(\.\d+)?$/.test(text))throw new Error('Enter an amount such as 8 or 8.50');
 const [whole,frac='']=text.split('.');
 if(frac.length>e)throw new Error(`${currency.toUpperCase()} has ${e} decimal place${e===1?'':'s'}`);
 const minor=Number(whole)*10**e+Number((frac+'0'.repeat(e)).slice(0,e)||0);
 if(!Number.isSafeInteger(minor))throw new Error('That amount is too large');
 return minor;
}

/** What one month costs on a given interval, in minor units (rounded). */
export const perMonth=(amount:number,interval:Interval)=>Math.round(amount/INTERVALS[interval].months);

/** Percent saved by paying on `interval` instead of month-by-month (0 when there is no saving). */
export function savingsPercent(monthly:number|null,amount:number,interval:Interval):number{
 if(!monthly||monthly<=0||interval==='month')return 0;
 const full=monthly*INTERVALS[interval].months;
 return full>amount?Math.round(((full-amount)/full)*100):0;
}

/** Adds whole months to a date the way billing does (the 31st of a short month falls on its last day). */
export function addMonths(date:Date,months:number):Date{
 const d=new Date(date.getTime()),day=d.getUTCDate();
 d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+months);
 const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
 d.setUTCDate(Math.min(day,last));
 return d;
}
