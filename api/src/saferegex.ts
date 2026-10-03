import vm from 'node:vm';
// Patterns come from template and plugin authors. They are matched in a separate context with a hard time limit,
// so a pattern with catastrophic backtracking fails the check instead of freezing the API.
// The pattern is only ever compiled inside the time-limited context below, never in the API's own realm.
// The two scripts are compiled once: only running them is time-limited, so a busy machine cannot make a good pattern fail.
const scripts={valid:new vm.Script('new RegExp(p),true'),test:new vm.Script('new RegExp(p).test(v)')};
const inContext=(script:vm.Script,p:string,v=''):boolean=>{
 try{return script.runInContext(vm.createContext({p,v}),{timeout:100})===true;}catch{return false;}
};
export function validPattern(pattern:string){
 if(typeof pattern!=='string'||!pattern||pattern.length>200)return false;
 return inContext(scripts.valid,pattern);
}
export function safeTest(pattern:string,value:string){
 if(!validPattern(pattern)||typeof value!=='string'||value.length>4096)return false;
 return inContext(scripts.test,pattern,value);
}
