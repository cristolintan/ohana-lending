// sw.js — Ohana Lending PWA service worker
// Relative asset paths so it works whether the app is served from "/"
// (local dev) or a subpath like "/ohana-lending/" (GitHub Pages).
//
// Caches are split on purpose:
//   • SHELL — our own code (index.html / app.js / icons). Versioned: a release
//     bumps VERSION and the old shell is dropped.
//   • LIB   — third-party libraries from unpkg/jsdelivr. NOT versioned with the
//     app, so shipping an app update no longer forces every device to
//     re-download ~5 MB of React/Babel/charts over mobile data.
const VERSION = "v17";
const SHELL = `ohana-shell-${VERSION}`;
const LIB = "ohana-lib-v1";
const KEEP = [SHELL, LIB];

// Must-have app shell — install fails (and the SW is discarded) if these fail.
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
  "./tailwindcss.js",
  "./icons/icon-96.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/badge-96.png"
];

// Third-party libs — cached best-effort so one flaky CDN can't block install.
const LIB_ASSETS = [
  "https://unpkg.com/react@18/umd/react.production.min.js",
  "https://unpkg.com/react-dom@18/umd/react-dom.production.min.js",
  "https://unpkg.com/@babel/standalone@7.29.7/babel.min.js",
  "https://unpkg.com/lucide@latest/dist/umd/lucide.min.js",
  "https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js",
  "https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js",
  "https://unpkg.com/lightweight-charts@5/dist/lightweight-charts.standalone.production.js",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"
];

// ─── Install ────────────────────────────────────────────────────────────────
// Note: no skipWaiting() here. The new worker waits until the app asks for it
// (SKIP_WAITING), so a release never swaps code out from under a half-typed
// payment. The app surfaces an "Update ready" prompt instead.
self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(SHELL_ASSETS);
    const lib = await caches.open(LIB);
    await Promise.allSettled(LIB_ASSETS.map(u => lib.add(u)));
  })());
});

// ─── Activate ───────────────────────────────────────────────────────────────
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch {}
    }
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !KEEP.includes(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// The app posts this after the user taps "Update" on the update banner.
self.addEventListener("message", e => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

// ─── Fetch strategies ───────────────────────────────────────────────────────
const timeout = ms => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));

// Network-first with a deadline: on a slow/failing mobile connection we stop
// waiting and serve the cached copy rather than leaving a blank screen.
async function networkFirst(req, cacheName, ms, preload) {
  const cache = await caches.open(cacheName);
  // navigationPreload resolves to undefined when it isn't active — fall through
  // to a normal fetch, with one shared deadline over both.
  const fromNetwork = (async () => {
    if (preload) { const early = await preload; if (early) return early; }
    return fetch(req);
  })();
  try {
    const res = await Promise.race([fromNetwork, timeout(ms)]);
    if (!res) throw new Error("no response");
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch {
    const hit = await cache.match(req) || await caches.match(req);
    if (hit) return hit;
    if (req.mode === "navigate") {
      const shell = await cache.match("./index.html") || await caches.match("./index.html");
      if (shell) return shell;
    }
    return new Response("Offline — this content isn't cached yet.", {
      status: 503, headers: { "Content-Type": "text/plain" }
    });
  }
}

// Cache-first: static assets that only change when their URL changes.
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
  return res;
}

// Stale-while-revalidate: instant from cache, refreshed in the background.
// Used for the CDN libs — several are floating URLs ("@latest", "@2", "@5"),
// so cache-first-forever would pin them to whatever shipped on install day.
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const network = fetch(req)
    .then(res => { if (res && res.ok) cache.put(req, res.clone()).catch(() => {}); return res; })
    .catch(() => null);
  if (hit) { network.catch(() => {}); return hit; }
  // Nothing cached and the network is down: surface a real network error so the
  // caller fails the way it would without a service worker (a synthetic 504
  // would make a dead <script> tag look like it loaded).
  const res = await network;
  return res || Response.error();
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;                    // never cache writes

  const url = new URL(req.url);
  if (!url.protocol.startsWith("http")) return;        // chrome-extension:, blob:, …
  if (url.hostname.endsWith("supabase.co")) return;    // API/auth/storage: always live

  const sameOrigin = url.origin === self.location.origin;

  // Navigations and app code: always try the network so a deploy lands fast.
  if (req.mode === "navigate") {
    e.respondWith(networkFirst(req, SHELL, 4000, e.preloadResponse));
    return;
  }
  if (sameOrigin && /\/(index\.html|app\.js|manifest\.json)$/.test(url.pathname)) {
    e.respondWith(networkFirst(req, SHELL, 4000));
    return;
  }
  if (sameOrigin) {                                    // icons, tailwindcss.js
    e.respondWith(cacheFirst(req, SHELL));
    return;
  }
  e.respondWith(staleWhileRevalidate(req, LIB));       // unpkg / jsdelivr libs
});

// ─── Background sync ────────────────────────────────────────────────────────
// The outbox is flushed by the page (it holds the authenticated Supabase
// client), so the sync event's job is to wake any open client and tell it to
// drain. If no window is open the queue simply waits for the next launch —
// the app also flushes on load and on the "online" event.
self.addEventListener("sync", e => {
  if (e.tag !== "ohana-outbox") return;
  e.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clients) c.postMessage({ type: "flush-outbox" });
  })());
});

// ─── Web Push (internal staff alerts) ────────────────────────────────────────
// Payload shape (JSON): { title, body, url, icon, tag, requireInteraction }
self.addEventListener("push", e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; }
  catch { data = { body: e.data ? e.data.text() : "" }; }

  const title = data.title || "Ohana Lending";
  const options = {
    body: data.body || "",
    icon: data.icon || "./icons/icon-192.png",   // resolves under the SW scope
    badge: "./icons/badge-96.png",               // monochrome silhouette (Android status bar)
    tag: data.tag || undefined,                   // same tag collapses into one
    renotify: !!data.tag,
    requireInteraction: !!data.requireInteraction,
    data: { url: data.url || "./" }
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// Click → focus an already-open app tab (and tell it where to go), else open one.
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const raw = (e.notification.data && e.notification.data.url) || "./";
  // Resolve relative URLs (e.g. "?loan=OL-0001") against the scope so the
  // GitHub Pages subpath "/ohana-lending/" is preserved.
  const targetUrl = new URL(raw, self.registration.scope).href;

  e.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clients) {
      if (c.url.startsWith(self.registration.scope) && "focus" in c) {
        await c.focus();
        c.postMessage({ type: "notification-click", url: targetUrl });
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});
