// 不访问网络：验证单次探测、退避上限、超时与前后台恢复。
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('app/static/network-recovery.js','utf8');
const timers=new Map(),events={},documentEvents={};let nextTimer=0,now=0,calls=0,recovered=0,fail=true;
const window={addEventListener:(key,fn)=>{events[key]=fn;}},document={hidden:false,addEventListener:(key,fn)=>{documentEvents[key]=fn;}};
const context=vm.createContext({window,document,AbortController,setTimeout:(fn,delay)=>{timers.set(++nextTimer,{fn,at:now+delay});return nextTimer;},clearTimeout:id=>timers.delete(id),probe:async()=>{calls++;if(fail)throw Error('offline');},recovered:()=>recovered++});
vm.runInContext(source+';globalThis.recovery=new AppNetworkRecovery({probe,recovered});',context);
const recovery=context.recovery,flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
async function advance(ms){now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn();}await flush();}
(async()=>{
 recovery.start();recovery.start();await flush();assert.equal(calls,1,'并发触发只探测一次');assert.equal(timers.size,1);
 await advance(1000);assert.equal(calls,2);await advance(1999);assert.equal(calls,2);await advance(1);assert.equal(calls,3);
 document.hidden=true;documentEvents.visibilitychange();assert.equal(timers.size,0);await advance(60000);assert.equal(calls,3);
 document.hidden=false;documentEvents.visibilitychange();await flush();assert.equal(calls,4);
 fail=false;events.online();await flush();assert.equal(recovered,1);assert.equal(recovery.active,false);assert.equal(timers.size,0);await advance(60000);assert.equal(recovered,1);
 fail=true;recovery.start();await flush();for(const delay of [1000,2000,5000,10000,30000,30000]){const t=[...timers.values()][0];assert.equal(t.at-now,delay);await advance(delay);}
 timers.clear();
 vm.runInContext('globalThis.timeoutRecovery=new AppNetworkRecovery({probe:signal=>new Promise((resolve,reject)=>signal.addEventListener("abort",()=>reject(Error("timeout")))),recovered});',context);
 context.timeoutRecovery.start();await flush();assert.equal(context.timeoutRecovery.pending,true);await advance(8000);assert.equal(context.timeoutRecovery.pending,false);assert.equal([...timers.values()][0].at-now,1000);
 console.log('PASS：单次探测、1／2／5／10／30秒退避及上限、后台暂停、回前台立即恢复、8秒超时及成功停止重试');
})().catch(e=>{console.error(e);process.exitCode=1;});
