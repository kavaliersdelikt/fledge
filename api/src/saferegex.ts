import vm from 'node:vm';
// Patterns come from template and plugin authors. They are matched in a separate context with a hard time limit,
// so a pattern with catastrophic backtracking fails the check instead of freezing the API.
// The pattern is only ever compiled inside the time-limited context below, never in the API's own realm.
const inContext=(code:string,p:string,v=''):boolean=>{
 try{return vm.runInContext(code,vm.createContext({p,v}),{timeout:50})===true;}catch{return false;}
};
export function validPattern(pattern:string){
 if(typeof pattern!=='string'||!pattern||pattern.length>200)return false;
 return inContext('new RegExp(p),true',pattern);
}
export function safeTest(pattern:string,value:string){
 if(!validPattern(pattern)||typeof value!=='string'||value.length>4096)return false;
 return inContext('new RegExp(p).test(v)',pattern,value);
}
