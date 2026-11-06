const retry=document.querySelector('#offline-retry'),status=document.querySelector('#offline-status');
const destination=location.pathname==='/offline'?'/return-today':location.pathname+location.search;
let returning=false;
const recovery=new AppNetworkRecovery({
 probe:async signal=>{
  // 普通fetch不走导航离线兜底，确认原页面可达后才重新打开。
  const response=await fetch(destination,{cache:'no-store',credentials:'same-origin',signal});
  if(!response.ok||new URL(response.url).origin!==location.origin||!response.headers.get('content-type')?.includes('text/html'))throw Error('页面尚未恢复');
 },
 recovered:()=>{if(returning)return;returning=true;status.textContent='连接已恢复，正在返回…';if(location.pathname==='/offline')location.replace(destination+location.hash);else location.reload();},
 status:(phase,delay)=>{retry.disabled=phase==='checking';status.textContent=phase==='checking'?'正在自动检查连接…':phase==='waiting'?`暂未恢复，约${delay/1000}秒后自动重试。`:'连接已恢复。';},
});
retry.addEventListener('click',()=>recovery.start());
recovery.start();
