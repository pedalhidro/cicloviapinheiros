// cicloviapinheiros — service worker
//
// Mesmo desenho do ecossistema Pedal (ver levabici/sw.js, amora/web/sw.js):
//   STATIC_CACHE  — casca do app (HTML/CSS/JS/libs): stale-while-revalidate —
//                   serve do cache na hora e atualiza por trás, então um
//                   deploy chega na visita seguinte.
//                   Exceção: data/* é network-first. Aqui "velho" não é casca
//                   velha, é dizer que a ciclovia está aberta quando o OSM já
//                   diz que fechou; o cache só entra sem rede (e o painel
//                   avisa a idade do dado pelo check.json).
//   RUNTIME_CACHE — tiles: stale-while-revalidate.
//
// DISCIPLINA: qualquer mudança em arquivo servido exige subir a VERSION.
// A rodada de 6 h do fetch_osm.py NÃO exige: data/* nunca vem do cache com rede.
//
// v1 — primeira versão: mapa de estado (24 h / aberta / fechada pelo horário /
//      interditada) a partir das tags do OSM.
// v2 — corredor do rio (passarelas, estradas de terra da beira-rio), contorno
//      ocre no chão solto, portões (o que fica atrás de portão fechado fecha
//      junto), acessos como marcadores, vermelho sempre por cima; saem as
//      pontas Cebolão/Pedreira e as ruas.
const VERSION = 'ciclopinheiros-v2';
const STATIC_CACHE = `${VERSION}-static`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const STATIC_ASSETS = [
  './',
  'index.html',
  'style.css',
  'status.js',
  'app.js',
  'manifest.webmanifest',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'lib/leaflet/leaflet.css',
  'lib/leaflet/leaflet.js',
  'lib/leaflet/images/layers.png',
  'lib/leaflet/images/layers-2x.png',
  'lib/fonts/ibm-plex-mono-400.woff2',
  'lib/fonts/ibm-plex-mono-600.woff2',
];

const TILE_HOSTS = ['tile.openstreetmap.org', 'telhas.pedalhidrografi.co'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

function staleWhileRevalidate(event, cacheName) {
  return caches.open(cacheName).then((cache) =>
    cache.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res && (res.ok || res.type === 'opaque')) cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
}

function networkFirst(event, cacheName) {
  return caches.open(cacheName).then((cache) =>
    fetch(event.request)
      .then((res) => {
        if (res && res.ok) cache.put(event.request, res.clone());
        return res;
      })
      .catch(() => cache.match(event.request))
  );
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  if (url.origin === location.origin) {
    if (url.pathname.includes('/data/')) event.respondWith(networkFirst(event, STATIC_CACHE));
    else event.respondWith(staleWhileRevalidate(event, STATIC_CACHE));
    return;
  }
  if (TILE_HOSTS.includes(url.hostname)) event.respondWith(staleWhileRevalidate(event, RUNTIME_CACHE));
});
