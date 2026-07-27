/* PATRIMONIO — service worker
   Guarda la app en el teléfono para que abra sin señal.
   Los datos NO pasan por aquí: viven en el almacenamiento del navegador. */

const VERSION = "patrimonio-v2.7";
const ARCHIVOS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png"
];

self.addEventListener("install", ev => {
  ev.waitUntil(
    caches.open(VERSION).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", ev => {
  ev.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", ev => {
  const req = ev.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // La sincronización con Google Apps Script siempre va a la red, nunca al caché.
  if (url.origin !== self.location.origin) return;

  ev.respondWith(
    caches.match(req).then(hit => {
      if (hit) {
        // Refresca en segundo plano para la próxima vez.
        fetch(req).then(r => {
          if (r && r.ok) caches.open(VERSION).then(c => c.put(req, r.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(req)
        .then(r => {
          if (r && r.ok) {
            const copia = r.clone();
            caches.open(VERSION).then(c => c.put(req, copia));
          }
          return r;
        })
        .catch(() => {
          if (req.mode === "navigate") return caches.match("./index.html");
          return new Response("", { status: 504 });
        });
    })
  );
});
