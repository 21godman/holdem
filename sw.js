"use strict";
// Cache-first service worker：預快取全部靜態檔，離線可用
const CACHE = "poker-equity-v4";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./poker.js",
  "./gto.js",
  "./worker.js",
  "./app.js",
  "./quiz.js",
  "./quiz-ui.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
