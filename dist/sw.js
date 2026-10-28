/* Service worker: keeps the app (and, after first use, the built-in decoder) available offline.
 * It never sees the files you play: they are read by the page directly. */
// Both lines below are filled in by the build (vite.config.ts): a version per release and the hashed app files.
const CACHE = 'webplayer-vd7cc8618c0';
const SHELL = ['/', '/en/', '/en/video/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png'];
const BUILT = ["/assets/launcher-5LoySZae.js","/assets/launcher-DpqsnV90.css","/assets/main-B54408GH.css","/assets/main-CSlvjkJP.js","/assets/modulepreload-polyfill-P2Xu9kJm.js"]; // hashed JS and CSS of this build

self.addEventListener('install', (event) => {
  // No skipWaiting here: the page offers "Reload" and tells us when to take over.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([...SHELL, ...BUILT])));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('webplayer-v') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// Files shared to the installed app from the system share sheet arrive as a POST; park them in a cache for the page.
async function handleShare(request) {
  const form = await request.formData();
  const files = form.getAll('media').filter((f) => f instanceof File);
  const cache = await caches.open('webplayer-share');
  await Promise.all((await cache.keys()).map((k) => cache.delete(k)));
  await Promise.all(
    files.map((f, i) =>
      cache.put(
        '/shared/' + i,
        new Response(f, { headers: { 'X-Name': encodeURIComponent(f.name), 'X-Modified': String(f.lastModified), 'Content-Type': f.type || 'application/octet-stream' } }),
      ),
    ),
  );
  // Open the player page in the visitor's language.
  const l = (request.headers.get('accept-language') || '').slice(0, 2).toLowerCase();
  const lang = ['de', 'pl', 'cs'].includes(l) ? l : 'en';
  return Response.redirect(`/${lang}/video/?shared=${files.length}`, 303);
}

const immutable = (url) => url.pathname.startsWith('/assets/') || url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/icons/');

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET') return;

  if (req.mode === 'navigate') {
    // Pages: network first, fall back to the cached shell when offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('/en/video/'))),
    );
    return;
  }

  if (immutable(url)) {
    // Hashed or versioned files: cache first, remember what the network returns.
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone(); // clone before the page reads the body
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
