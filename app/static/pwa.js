/* 安装与更新均由用户触发；业务数据不进入公共缓存，也不自动重试写入。 */
(()=>{
 const $=id=>document.getElementById(id),dialog=$('pwa-dialog');if(!dialog)return;
 const install=$('pwa-install'),notice=$('pwa-notice'),update=$('pwa-update-open'),reconnect=$('pwa-reconnect'),action=$('pwa-dialog-action');
 let installedHere=false;
 const standalone=matchMedia('(display-mode:standalone)'),isInstalled=()=>installedHere||standalone.matches||navigator.standalone===true;
 let prompt=null,registration=null,waiting=null,requestedRefresh=false,disconnected=!navigator.onLine,lastCheck=0,controlledAtLoad=Boolean(navigator.serviceWorker?.controller);
 function renderNotice(){notice.hidden=!disconnected&&!waiting;reconnect.hidden=!disconnected;update.hidden=disconnected||!waiting;$('pwa-notice-message').textContent=disconnected?'暂时无法连接；未确认的操作请联网后核对。计时按服务器已保存的设置运行。':'新版本已准备好，保存当前编辑后即可更新。';}
 function refreshInstall(){if(install)install.textContent=isInstalled()?'应用说明':'安装到桌面';}
 function openDialog(title,description,detail,button,callback){$('pwa-dialog-title').textContent=title;$('pwa-dialog-description').textContent=description;$('pwa-dialog-detail').textContent=detail;action.hidden=!button;action.textContent=button||'';action.onclick=callback||null;action.disabled=false;document.querySelector('.nav-more')?.removeAttribute('open');dialog.showModal();}
 if(install)install.onclick=()=>{
  if(isInstalled()){openDialog('今日航线已独立打开','计划、执行与复盘都在这里。','联网使用，计时与记录以服务器为准；离线时保留公共资源和连接提示。',null);return;}
  const ios=/iPad|iPhone|iPod/.test(navigator.userAgent)||navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1;
  const instruction=!window.isSecureContext?'当前是HTTP预览，请在正式HTTPS站点安装。':ios?'在Safari中点“分享”，选择“添加到主屏幕”，保持“作为Web App打开”。':'在浏览器菜单选择“安装应用”或“添加到主屏幕”；电脑也可使用地址栏的安装图标。';
  openDialog('把今日航线放到桌面','桌面显示应用图标，点开后使用独立窗口。',prompt?'安装后仍使用现有账号与服务器记录。':instruction,prompt?'安装到桌面':null,async()=>{const event=prompt;prompt=null;if(!event)return;action.disabled=true;try{await event.prompt();await event.userChoice;dialog.close();}catch{$('pwa-dialog-detail').textContent=instruction;}finally{action.disabled=false;}});
 };
 $('pwa-dialog-close').onclick=$('pwa-dialog-cancel').onclick=()=>dialog.close();
 dialog.addEventListener('click',e=>{if(e.target!==dialog)return;const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();});
 window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();prompt=e;refreshInstall();});
 window.addEventListener('appinstalled',()=>{installedHere=true;prompt=null;refreshInstall();dialog.close();});standalone.addEventListener('change',refreshInstall);
 update.onclick=()=>openDialog('更新今日航线','请先保存正在编辑的内容，再重新打开当前页面。','正在进行的计时保留在服务器，不会因为重新打开而停止。','更新并重新打开',()=>{if(disconnected){$('pwa-dialog-detail').textContent='请先恢复连接再更新。';return;}requestedRefresh=true;if(waiting&&waiting.state==='installed')waiting.postMessage({type:'SKIP_WAITING'});else location.reload();});
 async function checkConnection(){reconnect.disabled=true;try{const r=await fetch('/manifest.webmanifest',{cache:'no-store'});if(!r.ok)throw Error();disconnected=false;window.dispatchEvent(new Event('focus'));}catch{disconnected=true;}finally{reconnect.disabled=false;renderNotice();}}
 reconnect.onclick=checkConnection;window.addEventListener('offline',()=>{disconnected=true;renderNotice();});window.addEventListener('online',checkConnection);window.addEventListener('app-network-error',()=>{disconnected=true;renderNotice();});
 refreshInstall();renderNotice();
 if(!('serviceWorker' in navigator)||!window.isSecureContext)return;
 navigator.serviceWorker.addEventListener('controllerchange',()=>{if(!controlledAtLoad){controlledAtLoad=true;return;}if(requestedRefresh)location.reload();else if(registration?.active){waiting=registration.active;renderNotice();}});
 function offerUpdate(){if(registration.waiting&&navigator.serviceWorker.controller){waiting=registration.waiting;renderNotice();}}
 async function checkUpdate(){if(document.hidden||Date.now()-lastCheck<60000)return;lastCheck=Date.now();try{await registration?.update();offerUpdate();}catch{/* 更新检查失败不打断正常使用。 */}}
 // 首次渲染之后注册，不用安装流程阻塞页面。
 window.addEventListener('load',async()=>{try{registration=await navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'});offerUpdate();registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed')offerUpdate();});});document.addEventListener('visibilitychange',checkUpdate);window.addEventListener('focus',checkUpdate);}catch{/* 普通网页仍可照常使用；安装入口提供浏览器说明。 */}},{once:true});
})();
