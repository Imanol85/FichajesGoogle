/*
 * Service worker de Fichajes. Guarda una copia de los ficheros de la app para
 * que se abra sin cobertura. Las llamadas al servidor no pasan por aquí.
 * Con conexión siempre se sirve lo último publicado, así que una versión
 * nueva llega sola. VERSION solo hay que cambiarla si se quitan o se
 * renombran ficheros, para que se borre la copia antigua.
 */
const VERSION = 'fichajes-1';
const FICHEROS = [
  './',
  'index.html',
  'estilos.css',
  'app.js',
  'config.js',
  'manifest.webmanifest',
  'iconos/icono-180.png',
  'iconos/icono-192.png',
  'iconos/icono-512.png'
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(FICHEROS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((nombres) => Promise.all(nombres.filter((n) => n !== VERSION).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Primero la red, para que una versión nueva llegue en cuanto hay conexión;
// si falla, la copia guardada.
self.addEventListener('fetch', (evento) => {
  const peticion = evento.request;
  if (peticion.method !== 'GET' || new URL(peticion.url).origin !== self.location.origin) return;
  evento.respondWith(
    fetch(peticion)
      .then((respuesta) => {
        if (respuesta.ok) {
          const copia = respuesta.clone();
          caches.open(VERSION).then((cache) => cache.put(peticion, copia));
        }
        return respuesta;
      })
      .catch(() => caches.match(peticion, { ignoreSearch: true }).then((guardada) => {
        if (guardada) return guardada;
        // Sin copia de esa dirección: al abrir la app se sirve la página principal.
        return peticion.mode === 'navigate' ? caches.match('index.html') : Response.error();
      }))
  );
});
