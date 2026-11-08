// Cache only this public offline screen. Never store CRM pages, API responses,
// server actions, customer data or credentials in Cache Storage.
const PUBLIC_CACHE='karven-pwa-public-v1';
const OFFLINE='/offline.html';
self.addEventListener('install',event=>{
 event.waitUntil((async()=>{const cache=await caches.open(PUBLIC_CACHE);await cache.add(new Request(OFFLINE,{cache:'reload',credentials:'omit'}));await self.skipWaiting()})());
});
self.addEventListener('activate',event=>{
 event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('karven-pwa-public-')&&name!==PUBLIC_CACHE)await caches.delete(name);await self.clients.claim()})());
});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||request.mode!=='navigate'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||url.pathname.startsWith('/.netlify/'))return;
 // Let Next.js and the browser handle online navigation without wrapping the
 // response: server-action revalidation must retain its native router context.
 if(self.navigator.onLine)return;
 event.respondWith((async()=>{
  const cached=await caches.match(OFFLINE,{cacheName:PUBLIC_CACHE});
  return cached||new Response('Нет подключения к интернету. Восстановите соединение и обновите страницу.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
 })());
});
