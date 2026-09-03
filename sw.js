/* MediScan – Service Worker (Offline-Shell + Referenzdatenbank).
 * Bei App-Änderungen VERSION erhöhen → alter Cache wird verworfen.
 */
var VERSION = "ms-v1-2026-09-03-4";
var CACHE = "mediscan-" + VERSION;

/* Alles, was die App offline braucht (inkl. der 1,4-MB-Referenz-DB und jsPDF). */
var SHELL = [
  "./",
  "index.html",
  "app.html",
  "impressum.html",
  "datenschutz.html",
  "agb.html",
  "manifest.webmanifest",
  "assets/mediscan.css",
  "assets/ms-engine.js",
  "assets/ms-app.js",
  "assets/jspdf.umd.min.js",
  "assets/data/mediscan-db.json",
  "assets/icons/icon-192.png",
  "assets/icons/icon-512.png",
  "assets/icons/icon-maskable-512.png",
  "assets/icons/apple-touch-icon.png",
  "assets/icons/favicon-32.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // Jede Datei einzeln – eine fehlende darf die Installation nicht komplett kippen.
      return Promise.all(SHELL.map(function (u) {
        return c.add(new Request(u, { cache: "reload" })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("message", function (e) {
  if (e.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url;
  try { url = new URL(req.url); } catch (x) { return; }
  // Fremd-Origin (z. B. Tesseract-CDN) nicht abfangen – online laden lassen.
  if (url.origin !== self.location.origin) return;

  // Navigationen: erst Netz, dann App-Shell aus dem Cache (Offline-Fallback).
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).catch(function () {
        return caches.match(req).then(function (r) { return r || caches.match("app.html"); });
      })
    );
    return;
  }

  // Sonst: Cache-first, sonst Netz (und ins Cache legen).
  e.respondWith(
    caches.match(req).then(function (r) {
      return r || fetch(req).then(function (resp) {
        if (resp && resp.ok && resp.type === "basic") {
          var cp = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cp); });
        }
        return resp;
      });
    })
  );
});
