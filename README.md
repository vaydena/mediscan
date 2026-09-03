# MediScan – Web-PWA

Offline-fähige Progressive Web App zum Prüfen von **Medikamenten-Wechselwirkungen** und
**individuellen Patientenrisiken**. Rekonstruiert aus der ursprünglichen MediScan-Android-App
des Betreibers (eigene App, Quellcode verlorengegangen) als statische Web-Anwendung.

**Live:** https://mediscan.vaydena.de

> ⚠️ **Medizinischer Hinweis:** MediScan ist ein **Informations- und Nachschlagewerkzeug** und
> ersetzt **keine** ärztliche oder pharmazeutische Beratung. Keine Therapieentscheidung allein
> auf Basis dieser App treffen.

## Aufbau

| Datei/Ordner | Zweck |
|---|---|
| `index.html` | Landingpage |
| `app.html` | Das Tool (Suche/Scan → Analyse → PDF) |
| `assets/ms-engine.js` | Offline-Matching-Engine (`window.MediScan`) |
| `assets/ms-app.js` | UI-Controller |
| `assets/data/mediscan-db.json` | Referenzdatenbank (Medikamente, Wechselwirkungen, Risiken, Synonyme) |
| `assets/jspdf.umd.min.js` | PDF-Erzeugung (lokal, kein CDN) |
| `assets/mediscan.css` | Styles (Landing + App) |
| `sw.js`, `manifest.webmanifest` | PWA/Offline |
| `impressum.html`, `datenschutz.html`, `agb.html` | Rechtstexte |
| `test/engine-smoke.js` | Node-Smoke-Test der Engine (wird nicht deployt) |
| `tools/make-icons.js` | Icon-Generator (wird nicht deployt) |

## Datenverarbeitung

Die Wechselwirkungsprüfung läuft **vollständig im Browser**. Medikamentendaten verlassen das
Gerät nicht. Einzige Ausnahme: Beim optionalen Foto-Scan wird die Texterkennung
(Tesseract.js) beim ersten Mal von einem CDN geladen – das Bild selbst bleibt lokal.

## Datenbank neu bauen

```bash
node tools/make-icons.js          # Icons erzeugen
node test/engine-smoke.js         # Engine gegen die DB testen
```

## Deploy

Standardweg: **`git push`** → GitHub Actions (`.github/workflows/deploy.yml`) → FTPS (curl) nach
`/mediscan/` auf Hostinger. Secret `FTP_PASSWORD` (reines Passwort des Deploy-FTP-Kontos).
Sofort-Weg lokal: `deploy-local.ps1` (fragt das Passwort interaktiv ab).

## Datenqualität & geplante Erweiterung

Die klinischen Inhalte stammen 1:1 aus der Original-App. **Keine erfundenen medizinischen
Daten.** Ergänzt wurden nur validierte deutsche Handelsnamen → Wirkstoff (Synonyme), die gegen
die vorhandenen Wirkstoffe geprüft sind. Eine spätere Abdeckungs-Erweiterung ist über eine
separate Datenebene vorgesehen (bevorzugt lizenzsauber via openFDA/Public Domain; DrugBank
und rein statistische Quellen sind für den kommerziellen Betrieb ausgeschlossen).
