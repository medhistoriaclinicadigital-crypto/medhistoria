// Service worker de MedHistoriaClinicaOnline — habilita instalación como PWA.
// Solo cachea el "shell" de la app (HTML/manifest/íconos) para que abra rápido
// y funcione offline como pantalla básica. NUNCA cachea llamadas a Supabase
// ni a los CDNs externos (jsPDF, JsBarcode, EmailJS) — esas siempre van a la red.

var CACHE_NAME = 'medhistoria-shell-v1';
var APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png'
];

self.addEventListener('install', function(event){
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(APP_SHELL);
    })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE_NAME; })
            .map(function(k){ return caches.delete(k); })
      );
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event){
  var req = event.request;

  // Solo intervenimos pedidos GET del mismo origen (el shell de la app).
  // Todo lo demás (Supabase, CDNs externos) pasa directo a la red, sin tocar.
  if(req.method !== 'GET' || new URL(req.url).origin !== self.location.origin){
    return;
  }

  event.respondWith(
    fetch(req).then(function(res){
      var resClone = res.clone();
      caches.open(CACHE_NAME).then(function(cache){ cache.put(req, resClone); });
      return res;
    }).catch(function(){
      return caches.match(req).then(function(cached){
        return cached || caches.match('/index.html');
      });
    })
  );
});
