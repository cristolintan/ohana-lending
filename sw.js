// sw.js — Ohana Lending PWA service worker
// Relative asset paths so it works whether the app is served from "/"
// (local dev) or a subpath like "/ohana-lending/" (GitHub Pages).
const CACHE = "ohana-v12";

const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
  "./tailwindcss.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  // CDN deps (versioned URLs → safe to cache-first forever)
  "https://unpkg.com/react@18/umd/react.production.min.js",
  "https://unpkg.com/react-dom@18/umd/react-dom.production.min.js",
  "https://unpkg.com/@babel/standalone@7.29.7/babel.min.js",
  "https://unpkg.com/lucide@latest/dist/umd/lucide.min.js",
  "https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js",
  "https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"
];

// Install: pre-cache the app shell, then take over immediately.
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

// Activate: remove old caches.
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch strategy:
//   • Navigations & app code (index.html / app.js) → network-first:
//     always get the latest when online, fall back to cache when offline.
//     (No more manual cache-busting for code changes.)
//   • Everything else (CDN libs, icons) → cache-first: fast and stable.
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return; // never cache non-GET requests

  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co")) return;   // API/auth/storage: always network, never cache
  const isAppCode = url.origin === self.location.origin && /\/(index\.html|app\.js)?$/.test(url.pathname);

  if (req.mode === "navigate" || isAppCode) {
    e.respondWith(
      fetch(req)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(req, clone));
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || caches.match("./index.html")))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.status === 200 && res.type !== "opaque") {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(req, clone));
      }
      return res;
    }))
  );
});
