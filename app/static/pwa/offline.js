const retry=document.querySelector('#offline-retry'),status=document.querySelector('#offline-status');
retry.addEventListener('click',async()=>{retry.disabled=true;status.textContent='正在检查连接…';try{const r=await fetch('/manifest.webmanifest',{cache:'no-store'});if(!r.ok)throw Error();location.reload();}catch{status.textContent='仍无法连接，请检查网络后再试。';retry.disabled=false;}});
