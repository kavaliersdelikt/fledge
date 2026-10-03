import vm from 'node:vm';
// Patterns come from template and plugin authors. They are matched in a separate context with a hard time limit,
// so a pattern with catastrophic backtracking fails the check instead of freezing the API.
export function validPattern(pattern:string){
 if(typeof pattern!=='string'||!pattern||pattern.length>200)return false;
 try{new RegExp(pattern);return true;}catch{return false;}
}
export function safeTest(pattern:string,value:string){
 if(!validPattern(pattern)||typeof value!=='string'||value.length>4096)return false;
 try{return vm.runInContext('new RegExp(p).test(v)',vm.createContext({p:pattern,v:value}),{timeout:50})===true;}catch{return false;}
}
