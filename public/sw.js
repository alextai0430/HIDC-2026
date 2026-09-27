/* Cache only the public application shell and build assets. Never cache API data. */
const CACHE='hidc-shell-v1';
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.add('/')));self.skipWaiting();});
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
 if(url.pathname.startsWith('/_next/static/')||url.pathname==='/favicon.svg'){event.respondWith(caches.open(CACHE).then(async cache=>{const found=await cache.match(event.request);if(found)return found;const result=await fetch(event.request);if(result.ok)await cache.put(event.request,result.clone());return result;}));}
 else if(event.request.mode==='navigate'&&url.pathname==='/'){event.respondWith(fetch(event.request).then(async result=>{if(result.ok){const cache=await caches.open(CACHE);await cache.put('/',result.clone());}return result;}).catch(()=>caches.match('/')));}
});
