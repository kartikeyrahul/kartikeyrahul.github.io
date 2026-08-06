/* Design+ by Kartikey — service worker  v33 (library speed patch) */
const V='kn-v55';                    /* app shell   */
const F='kn-fonts';                 /* google fonts */
const CORE=['./','./index.html','./manifest.json','./icon.svg','./icon-192.png','./icon-512.png'];

self.addEventListener('install',e=>{
 self.skipWaiting();
 e.waitUntil(caches.open(V).then(c=>Promise.all(
  CORE.map(u=>c.add(u).catch(()=>{})))));
});

self.addEventListener('activate',e=>{
 e.waitUntil(
  caches.keys().then(k=>Promise.all(
   k.filter(x=>x!==V&&x!==F).map(x=>caches.delete(x))
  )).then(()=>self.clients.claim())
 );
});

self.addEventListener('fetch',e=>{
 const r=e.request;
 if(r.method!=='GET')return;
 const u=new URL(r.url);

 /* ---- Google fonts : cache first ---- */
 if(u.hostname==='fonts.googleapis.com'||u.hostname==='fonts.gstatic.com'){
  e.respondWith(
   caches.open(F).then(c=>c.match(r).then(hit=>
    hit||fetch(r).then(res=>{
     if(res&&(res.status===200||res.type==='opaque'))c.put(r,res.clone());
     return res;
    }).catch(()=>hit)
   ))
  );
  return;
 }

 if(u.origin!==location.origin)return;

 /* ---- page navigations : ALWAYS network first ---- */
 if(r.mode==='navigate'){
  e.respondWith(
   fetch(r).then(res=>{
    const cp=res.clone();
    caches.open(V).then(c=>c.put('./index.html',cp));
    return res;
   }).catch(()=>caches.match('./index.html').then(x=>x||caches.match('./')))
  );
  return;
 }

 /* ---- baaki app files : network first, offline par cache ---- */
 e.respondWith(
  fetch(r).then(res=>{
   if(res&&res.status===200){
    const cp=res.clone();
    caches.open(V).then(c=>c.put(r,cp));
   }
   return res;
  }).catch(()=>caches.match(r))
 );
});
