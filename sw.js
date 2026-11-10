/* Service worker: permite usar la app sin conexiÃ³n y abrirla como aplicaciÃ³n. */

const VERSION = '2026-11-10-2';
const CACHE = `escaner-${VERSION}`;

/* Archivos propios que cambian con cada actualizaciÃ³n: se piden a la red
   primero para no quedarse con una versiÃ³n vieja de la app. */
const NETWORK_FIRST = /(\.html?|\.js|\.css|\.json)$/i;

const SHELL = [
    './',
    './index.html',
    './styles.css',
    './js/app.js',
    './js/imaging.js',
    './js/store.js',
    './js/pdf.js',
    './vendor/jspdf.umd.min.js',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE);
            // Se guarda archivo por archivo: si uno falla, el resto igual queda.
            await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
            await self.skipWaiting();
        })()
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            const keys = await caches.keys();
            await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
            await self.clients.claim();
        })()
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    // NavegaciÃ³n: red primero, cachÃ© como respaldo.
    if (request.mode === 'navigate') {
        event.respondWith(
            (async () => {
                try {
                    const fresh = await fetch(request);
                    const cache = await caches.open(CACHE);
                    await cache.put('./index.html', fresh.clone());
                    return fresh;
                } catch {
                    const cache = await caches.open(CACHE);
                    return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
                }
            })()
        );
        return;
    }

    // CÃ³digo propio: red primero (para recibir actualizaciones), cachÃ© despuÃ©s.
    if (NETWORK_FIRST.test(url.pathname)) {
        event.respondWith(
            (async () => {
                const cache = await caches.open(CACHE);
                try {
                    const fresh = await fetch(request);
                    if (fresh && fresh.ok) await cache.put(request, fresh.clone());
                    return fresh;
                } catch {
                    const cached = await cache.match(request, { ignoreSearch: true });
                    return cached || Response.error();
                }
            })()
        );
        return;
    }

    // Recursos estables (iconos, librerÃ­a PDF): cachÃ© primero.
    event.respondWith(
        (async () => {
            const cache = await caches.open(CACHE);
            const cached = await cache.match(request, { ignoreSearch: true });
            if (cached) {
                fetch(request)
                    .then((response) => {
                        if (response && response.ok) cache.put(request, response);
                    })
                    .catch(() => {});
                return cached;
            }
            try {
                const response = await fetch(request);
                if (response && response.ok) cache.put(request, response.clone());
                return response;
            } catch {
                return Response.error();
            }
        })()
    );
});
