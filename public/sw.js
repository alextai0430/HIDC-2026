/* Cache only the public application shell and build assets. Never cache API data. */
const CACHE='hidc-shell-v2';
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.add('/')));self.skipWaiting();});
self.addEventListener('activate',event=>event.waitUntil(Promise.all([self.clients.claim(),caches.delete('hidc-shell-v1')])));
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
 const isPublicEmblem=url.pathname==='/ndl-emblem.png'||(url.pathname==='/_next/image'&&url.searchParams.get('url')==='/ndl-emblem.png');
 if(url.pathname.startsWith('/_next/static/')||isPublicEmblem){event.respondWith(caches.open(CACHE).then(async cache=>{const found=await cache.match(event.request);if(found)return found;const result=await fetch(event.request);if(result.ok)await cache.put(event.request,result.clone());return result;}));}
 else if(event.request.mode==='navigate'&&url.pathname==='/'){event.respondWith(fetch(event.request).then(async result=>{if(result.ok){const cache=await caches.open(CACHE);await cache.put('/',result.clone());}return result;}).catch(()=>caches.match('/')));}
});
