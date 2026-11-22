/* Service worker: caches the app so it works with NO internet after the first visit.
 * UPDATED: new cache name, files are fetched fresh when installing, and the small app files
 * (html, js, css) are loaded from the network first so updates show up; opencv.js stays cache-first. */
const CACHE = "cellcounter-v3";
const FILES = [
  "./", "index.html", "style.css", "core.js", "app.js", "report.js",
  "opencv.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // "reload" skips the browser's own HTTP cache, so the NEW files are stored, not old copies
      return Promise.all(FILES.map(function (f) {
        return cache.add(new Request(f, { cache: "reload" })).catch(function () { /* skip missing file */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
                             .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  const big = new URL(e.request.url).pathname.endsWith("opencv.js");

  if (big) {                       // large file: cache first (works offline, loads fast)
    e.respondWith(
      caches.match(e.request).then(function (hit) {
        return hit || fetch(e.request).then(function (resp) {
          const copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
          return resp;
        });
      })
    );
    return;
  }

  e.respondWith(                   // small files: network first, cache when offline
    fetch(e.request, { cache: "no-cache" }).then(function (resp) {
      const copy = resp.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      return resp;
    }).catch(function () { return caches.match(e.request); })
  );
});
