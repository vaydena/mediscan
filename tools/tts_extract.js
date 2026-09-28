#!/usr/bin/env node
/* Sammelt alle Texte, die die Vorlesefunktion in der App sprechen kann, und
 * schreibt tools/tts-texts.json ({hash: text}). Daraus erzeugt der Workflow
 * .github/workflows/tts.yml die Seraphina-Aufnahmen (tools/tts_build.py).
 *
 * Die Aufteilung in Abschnitte muss exakt der in assets/ms-app.js entsprechen
 * (toggleSpeak/speakSegments): Titel, Einstufung, Namen, Einleitung,
 * „Was kann passieren?"/„Was ist zu tun?" samt Text, „Empfehlung:" samt Text.
 * splitSections und ttsKey werden deshalb direkt aus ms-app.js übernommen.
 * Nur generische Texte der Referenzdatenbank – keine Nutzerdaten.
 *
 * Ausführen:  node tools/tts_extract.js
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "assets", "ms-app.js"), "utf8");
const ENGINE = fs.readFileSync(path.join(ROOT, "assets", "ms-engine.js"), "utf8");
const DB = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "data", "mediscan-db.json"), "utf8"));

// Funktionen 1:1 aus ms-app.js übernehmen (kein Nachbau, der auseinanderlaufen kann).
function grab(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " nicht in ms-app.js gefunden");
  let depth = 0, i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}
function grabVar(src, name) {
  const m = new RegExp("var " + name + " = [^;]+;").exec(src);
  if (!m) throw new Error(name + " nicht in ms-app.js gefunden");
  return m[0];
}
const ctx = {};
new Function("ctx", [grabVar(APP, "SEC_HAPPEN"), grabVar(APP, "SEC_TODO"), grabVar(APP, "TTS_VER"),
  grab(APP, "splitSections"), grab(APP, "ttsNorm"), grab(APP, "ttsKey"),
  "ctx.splitSections = splitSections; ctx.ttsNorm = ttsNorm; ctx.ttsKey = ttsKey;"].join("\n"))(ctx);

const texts = {};
function add(t) {
  t = ctx.ttsNorm(t);
  if (t) texts[ctx.ttsKey(t)] = t;
}
function addDesc(d) {
  const s = ctx.splitSections(d);
  if (s.lead.length) add(s.lead.join("\n\n"));
  if (s.happen.length) add(s.happen.join("\n\n"));
  if (s.todo.length) add(s.todo.join("\n\n"));
}

// Feste Texte der Oberfläche
["Was kann passieren?", "Was ist zu tun?", "Empfehlung:"].forEach(add);
const ok = /<div class="ok-note"[^>]*>.*?<span>(.*?)<\/span><\/div>/.exec(APP);
if (!ok) throw new Error("ok-note nicht gefunden");
add(ok[1].replace(/<[^>]+>/g, ""));

// Einstufungen (auch als „Höchste Einstufung: …“)
const labels = new Set();
for (const m of ENGINE.matchAll(/label: "([^"]+)"/g)) labels.add(m[1]);
labels.add("Unbekannt");
labels.forEach(function (l) { add(l); add("Höchste Einstufung: " + l); });

// Doppelungen (Titel werden in der Engine aus Stammdaten gebildet)
for (const m of ENGINE.matchAll(/description: "(Diese Präparate[^"]+)"/g)) add(m[1]);
const cats = new Set();
DB.medications.forEach(function (m) {
  add(m.name);
  if (m.activeIngredient) add("Wirkstoff-Doppelung: " + m.activeIngredient);
  if (m.category) cats.add(m.category);
});
cats.forEach(function (c) { add("Mehrere Wirkstoffe der Gruppe „" + c + "“"); });

// Wechselwirkungen, Mehrfach-Wechselwirkungen, Patientenrisiken
DB.interactions.forEach(function (x) { add(x.interactionTitle); addDesc(x.interactionDescription); });
DB.complex.forEach(function (x) { add(x.interactionTitle); addDesc(x.interactionDescription); add(x.recommendation); });
DB.risks.forEach(function (x) {
  add(x.riskTitle); addDesc(x.description); add(x.recommendation);
  add(x.medicationName); add(x.categoryLabel); add(x.riskCondition);
});

const out = {};
Object.keys(texts).sort().forEach(function (k) { out[k] = texts[k]; });
fs.writeFileSync(path.join(__dirname, "tts-texts.json"), JSON.stringify(out, null, 0) + "\n");
const chars = Object.values(out).reduce(function (a, t) { return a + t.length; }, 0);
console.log(Object.keys(out).length + " Texte, " + chars + " Zeichen -> tools/tts-texts.json");
