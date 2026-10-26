// localhost安全上下文与/tmp临时库；不访问真实记录，不改仓库文件。
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
const base=process.env.DAILY_PLAN_TEST_URL,revision=process.env.PWA_TEST_REVISION;
if(!base||new URL(base).hostname!=='127.0.0.1'||!revision?.startsWith('/tmp/daily-plan-pwa-'))throw Error('仅临时隔离环境');
(async()=>{const b=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});try{
 const context=await b.newContext({viewport:{width:390,height:844},locale:'zh-CN',timezoneId:'Asia/Shanghai',serviceWorkers:'allow'}),p=await context.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto(base+'/');await p.locator('[data-target-category=math]').waitFor();await p.waitForFunction(()=>navigator.serviceWorker.controller);await p.reload();await p.locator('[data-target-category=math]').waitFor();assert(await p.locator('#pwa-notice').isHidden(),'首次安装不误报更新');
 const client=await context.newCDPSession(p),manifest=await client.send('Page.getAppManifest');assert(!manifest.errors.length,JSON.stringify(manifest.errors));const data=JSON.parse(manifest.data);assert.equal(data.name,'今日航线');assert.equal(data.display,'standalone');assert(data.icons.some(i=>i.purpose==='maskable'));
 const health=await (await p.request.get(base+'/api/system/health')).json();assert(health.database_path.startsWith('/tmp/daily-plan-pwa-'));
 const keys=await p.evaluate(async()=>{const cache=await caches.open((await caches.keys()).find(x=>x.startsWith('daily-plan-public-')));return (await cache.keys()).map(x=>new URL(x.url).pathname);});assert(keys.includes('/offline'));assert(keys.every(x=>x==='/offline'||x.startsWith('/static/')),'仅缓存公共资源');
 await p.locator('.nav-more summary').click();await p.locator('#pwa-install').click();await p.locator('#pwa-dialog').waitFor();assert.match(await p.locator('#pwa-dialog-detail').innerText(),/浏览器菜单/);await p.screenshot({path:'/tmp/pwa-install-390.png'});await p.locator('#pwa-dialog-close').click();
 // 安装事件只在主动点击后触发原生安装，不自动促装。
 await p.evaluate(()=>{window.installCalls=0;const event=new Event('beforeinstallprompt',{cancelable:true});event.prompt=async()=>window.installCalls++;event.userChoice=Promise.resolve({outcome:'dismissed'});dispatchEvent(event);});assert.equal(await p.evaluate(()=>window.installCalls),0);await p.locator('.nav-more summary').click();await p.locator('#pwa-install').click();await p.locator('#pwa-dialog-action').click();assert.equal(await p.evaluate(()=>window.installCalls),1);
 // 断网不假称已保存、不缓存API；断网导航显示中性页，重新连接回原URL。
 await context.setOffline(true);await p.locator('#pwa-notice').waitFor();assert.match(await p.locator('#pwa-notice').innerText(),/核对/);assert(await p.evaluate(()=>fetch('/api/settings').then(()=>false,()=>true)));
 await p.goto(base+'/execute');await p.getByRole('heading',{name:'暂时无法连接'}).waitFor();await p.screenshot({path:'/tmp/pwa-offline-390.png'});assert.equal(new URL(p.url()).pathname,'/execute');await context.setOffline(false);await p.locator('#offline-retry').click();await p.locator('#execute-panel').waitFor({state:'attached'});
 await p.goto(base+'/');await p.locator('[data-target-category=math]').waitFor();await p.locator('[data-target-category=math]').fill('123');
 // 下载新版只提示，输入不丢；用户确认后激活，其他页不被强制刷新。
 const second=await context.newPage();await second.goto(base+'/');await second.locator('[data-target-category=math]').waitFor();await second.locator('[data-target-category=math]').fill('234');
 fs.writeFileSync(revision,'test-version-two');await p.evaluate(async()=>{await (await navigator.serviceWorker.getRegistration()).update();});await p.locator('#pwa-update-open').waitFor();assert.equal(await p.locator('[data-target-category=math]').inputValue(),'123');assert.equal(await second.locator('[data-target-category=math]').inputValue(),'234');
 await p.locator('#pwa-update-open').click();await p.locator('#pwa-dialog-action').click();await p.waitForFunction(()=>!document.querySelector('#pwa-dialog')?.open);await p.waitForFunction(async()=>{const names=await caches.keys();return names.includes('daily-plan-public-test-version-two')&&!names.includes('daily-plan-public-test-version-one');});await p.locator('[data-target-category=math]').waitFor();assert.equal(await second.locator('[data-target-category=math]').inputValue(),'234');
 for(const width of [360,390,768,1100]){await p.setViewportSize({width,height:844});assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 // iOS没有通用安装事件，提供Safari步骤。
 const ios=await b.newContext({viewport:{width:390,height:844},userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'}),i=await ios.newPage();await i.goto(base+'/login');await i.locator('#pwa-install').click();assert.match(await i.locator('#pwa-dialog-detail').innerText(),/Safari.*分享.*添加到主屏幕/);await ios.close();
 assert.deepEqual(errors,[]);console.log('PASS: 安装manifest／图标、主动促装、首次不误报、公共缓存与API不缓存、离线导航／恢复、真实新版等待／手动更新／另一页输入保留、四视口与iOS说明');
}finally{await b.close();}})().catch(e=>{console.error(e);process.exit(1)});
