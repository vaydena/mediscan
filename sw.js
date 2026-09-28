/* MediScan – Service Worker (Offline-Shell + Referenzdatenbank).
 * Bei App-Änderungen VERSION erhöhen → alter Cache wird verworfen.
 */
var VERSION = "ms-v1-2026-09-28-42";
var CACHE = "mediscan-" + VERSION;
/* Große, versionierte (unveränderliche) OCR-Abhängigkeiten (Tesseract-Kette)
 * getrennt & dauerhaft halten – NICHT bei jedem App-Update mit-verworfen, sonst
 * würde bei jeder VERSION-Erhöhung erneut ~15 MB deu.traineddata geladen. */
var OCR_CACHE = "mediscan-ocr-v1";
/* Vorlese-Aufnahmen (Stimme Seraphina, media/tts/<hash>.mp3): inhaltsadressiert,
 * also unveränderlich → einmal gehört, dauerhaft offline verfügbar, auch über
 * App-Updates hinweg. Die Liste media/tts/index.json kommt dagegen immer
 * frisch aus dem Netz (Offline-Fallback: letzte bekannte Liste). */
var TTS_CACHE = "mediscan-tts-v1";

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
  "assets/data/mediscan-fda.json",
  "assets/icons/icon-192.png",
  "assets/icons/icon-512.png",
  "assets/icons/icon-maskable-512.png",
  "assets/icons/apple-touch-icon.png",
  "assets/icons/favicon-32.png"
];

/* Ohne diese Dateien ist die App offline unbrauchbar. */
var CRITICAL = [
  "app.html",
  "assets/mediscan.css",
  "assets/ms-engine.js",
  "assets/ms-app.js",
  "assets/jspdf.umd.min.js",
  "assets/data/mediscan-db.json"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // Kerndateien MÜSSEN vollständig im neuen Cache liegen – sonst schlägt die
      // Installation fehl und der alte SW (samt altem Cache) bleibt aktiv. Früher
      // wurde jeder Fehler verschluckt; ein abgebrochener DB-Download beim Update
      // hinterließ dann einen Cache OHNE Referenz-DB, und activate löschte den alten.
      // Übrige Dateien (Rechtstexte, Icons, FDA-Ebene) bleiben best effort.
      return Promise.all(SHELL.map(function (u) {
        var p = c.add(new Request(u, { cache: "reload" }));
        return CRITICAL.indexOf(u) !== -1 ? p : p.catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { if (k !== CACHE && k !== OCR_CACHE && k !== TTS_CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("message", function (e) {
  if (e.data === "skipWaiting") self.skipWaiting();
});

// Klick auf eine Einnahme-Erinnerung: vorhandenes App-Fenster fokussieren, sonst öffnen.
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.url.indexOf("/app.html") !== -1 && "focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("app.html");
    })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url;
  try { url = new URL(req.url); } catch (x) { return; }

  // OCR-Abhängigkeiten (Tesseract-Kette) liegen ALLE auf cdn.jsdelivr.net:
  //   tesseract.js@5.1.1/dist/tesseract.min.js   (Haupt-Skript)
  //   tesseract.js@v5.1.1/dist/worker.min.js     (Worker)
  //   tesseract.js-core@v5.1.1/…-simd-lstm.wasm.js (WASM-Core)
  //   @tesseract.js-data/deu/…/deu.traineddata.gz  (Sprachdaten)
  // Diese versionierten, unveränderlichen Dateien cache-first bedienen →
  // nach dem ersten Online-Scan funktioniert die Texterkennung auch bei
  // CDN-Aussetzern/offline zuverlässig (Ursache der „2 von 8: gar nichts
  // erkannt"-Fehlläufe: jeder Scan hing bislang an einem Live-CDN-Fetch).
  // Auch OPAKE Antworten (no-cors, z. B. importScripts der WASM-Core im
  // Worker) werden gespeichert. Persistenter, versionsunabhängiger Cache.
  if (url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(
      caches.match(req).then(function (r) {
        return r || fetch(req).then(function (resp) {
          // Nur versionierte Pfade (…@x.y.z/…) dauerhaft cachen – so kann eine
          // fehlerhafte opake Antwort nicht fuer eine "latest"-URL haengen bleiben.
          if (resp && (resp.ok || (resp.type === "opaque" && url.pathname.indexOf("@") > 0))) {
            var cp = resp.clone();
            caches.open(OCR_CACHE).then(function (c) { c.put(req, cp); });
          }
          return resp;
        });
      })
    );
    return;
  }

  // Sonstige Fremd-Origins nicht abfangen – online laden lassen.
  if (url.origin !== self.location.origin) return;

  var ttsPath = new URL("media/tts/", self.registration.scope).pathname;
  if (url.pathname.indexOf(ttsPath) === 0) {
    if (/\.mp3$/.test(url.pathname) && !req.headers.has("range")) {
      e.respondWith(
        caches.open(TTS_CACHE).then(function (c) {
          return c.match(req).then(function (r) {
            return r || fetch(req).then(function (resp) {
              if (resp && resp.ok && resp.status === 200) c.put(req, resp.clone());
              return resp;
            });
          });
        })
      );
    } else if (/\/index\.json$/.test(url.pathname)) {
      e.respondWith(
        fetch(req, { cache: "no-cache" }).then(function (resp) {
          if (resp && resp.ok) { var cp = resp.clone(); caches.open(TTS_CACHE).then(function (c) { c.put(req, cp); }); }
          return resp;
        }).catch(function () { return caches.open(TTS_CACHE).then(function (c) { return c.match(req); }); })
      );
    }
    return;
  }

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
