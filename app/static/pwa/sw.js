/* 只存公共资源；业务页面、认证和API始终走网络，不重放任何写入。 */
const CACHE_PREFIX='daily-plan-public-',CACHE=CACHE_PREFIX+'__PWA_VERSION__';
const SHELL=['/offline','/static/pwa/offline.css','/static/pwa/offline.js','/static/pwa/icon-192.png','/static/pwa/icon-512.png','/static/pwa/icon-maskable-512.png','/static/pwa/apple-touch-icon.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL))));
self.addEventListener('activate',e=>e.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith(CACHE_PREFIX)&&name!==CACHE)await caches.delete(name);await self.clients.claim();})()));
self.addEventListener('message',e=>{if(e.data?.type==='SKIP_WAITING')self.skipWaiting();});
self.addEventListener('fetch',e=>{
 const request=e.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
 if(request.mode==='navigate'){
  e.respondWith((async()=>{try{const response=await fetch(request,{cache:'no-store'});if(response.status<500)return response;}catch{}try{return await (await caches.open(CACHE)).match('/offline')||Response.error();}catch{return Response.error();}})());return;
 }
 if(!url.pathname.startsWith('/static/')&&url.pathname!=='/offline')return;
 // Service Worker源码只从网络读取，绝不能让它成为自己的旧缓存。
 if(url.pathname==='/static/pwa/sw.js')return;
 e.respondWith((async()=>{let cache;try{cache=await caches.open(CACHE);const saved=await cache.match(request);if(saved)return saved;}catch{}const response=await fetch(request);if(cache&&response.ok&&!response.redirected&&response.type==='basic'){try{await cache.put(request,response.clone());}catch{}}return response;})());
});
