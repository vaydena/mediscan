/* Node-Smoke-Test der Matching-Engine gegen die echte Referenz-DB.
 * Ausführen:  node test/engine-smoke.js
 * Prüft: DB-Laden, OCR-Erkennung (exakt/fuzzy/Synonym), paarweise + komplexe
 * Wechselwirkungen, Patientenrisiken per Profil. Kein Browser nötig.
 */
const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "assets", "data", "mediscan-db.json");

// Minimaler Browser-Shim
global.window = {};
global.fetch = async function (url) {
  const p = url.startsWith("http") ? DB_PATH : path.join(__dirname, "..", url);
  const txt = fs.readFileSync(DB_PATH, "utf8");
  return { ok: true, status: 200, json: async () => JSON.parse(txt) };
};

require(path.join(__dirname, "..", "assets", "ms-engine.js"));
const MS = global.window.MediScan;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
}

(async function () {
  await MS.load("assets/data/mediscan-db.json");
  const meta = MS.meta();
  console.log("DB:", JSON.stringify(meta.counts));

  // --- Erkennung: exakte Namen ---
  let d = MS.detect("Patient nimmt Aspirin 100 mg und Ibuprofen 400");
  let ings = d.map(x => x.ingredient);
  ok("erkennt Aspirin (Acetylsalicylsäure)", ings.includes("Acetylsalicylsäure"), JSON.stringify(ings));
  ok("erkennt Ibuprofen", ings.includes("Ibuprofen"), JSON.stringify(ings));

  // --- Fuzzy: OCR-Tippfehler ---
  let f = MS.detect("Ibuprofin Metformim Simvastin");
  let fi = f.map(x => x.ingredient);
  ok("fuzzy: Ibuprofin -> Ibuprofen", fi.includes("Ibuprofen"), JSON.stringify(fi));
  ok("fuzzy: Metformim -> Metformin", fi.includes("Metformin"), JSON.stringify(fi));

  // --- Synonyme / Handelsnamen ---
  let s = MS.detect("Godamed 100, Beloc zok, Voltaren");
  let si = s.map(x => x.ingredient);
  ok("synonym: Godamed -> Acetylsalicylsäure", si.includes("Acetylsalicylsäure"), JSON.stringify(si));
  ok("synonym: Beloc -> Metoprolol", si.includes("Metoprolol"), JSON.stringify(si));
  ok("synonym: Voltaren -> Diclofenac", si.includes("Diclofenac"), JSON.stringify(si));

  // --- Autocomplete (neue „pick"-Form: {ids,name,sub,category}) ---
  let q = MS.search("simva");
  ok("suche 'simva' findet Simvastatin", q.some(m => /simvastatin/i.test(m.sub)), q.map(m=>m.name).join(","));

  // --- Paarweise Wechselwirkung ASS x Ibuprofen ---
  function idOf(name) { let r = MS.search(name); return r.length ? r[0].ids[0] : null; }
  let assId = MS.detect("Aspirin")[0].medId;
  let ibuId = MS.detect("Ibuprofen")[0].medId;
  let inter = MS.interactionsFor([assId, ibuId]);
  ok("Wechselwirkung ASS x Ibuprofen gefunden", inter.length >= 1, "n=" + inter.length);
  if (inter.length) console.log("     z.B.:", inter[0].sev.label, "-", inter[0].title);

  // --- Viele Medikamente: paarweise + komplex ---
  let many = MS.detect("Marcumar Aspirin Ibuprofen Diclofenac Ramipril Metformin Simvastatin Furosemid");
  let ids = many.map(x => x.medId);
  let a = MS.analyze(ids, []);
  ok("mehrere Meds -> paarweise Interaktionen", a.interactions.length >= 3, "n=" + a.interactions.length);
  console.log("     paarweise:", a.interactions.length, "| komplex:", a.complex.length);

  // --- Komplex: irgendein Datensatz muss triggerbar sein ---
  // nimm den ersten complex-Datensatz und wähle genau dessen Wirkstoffe
  const raw = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  let c0 = raw.complex[0];
  let cIds = String(c0.drugIds).split(",").map(n => parseInt(n, 10));
  let cx = MS.complexFor(cIds);
  ok("komplexe Wechselwirkung reproduzierbar", cx.length >= 1, "title=" + c0.interactionTitle + " n=" + cx.length);

  // --- Patientenrisiken: Profil Schwangerschaft ---
  // Zuordnung läuft über medicationName (der FK medicationId ist in der DB unbrauchbar).
  // Ein SCHWANGERSCHAFT-Risiko wählen, dessen Präparat auch wirklich wählbar ist.
  function medIdByName(nm) { let r = MS.search(nm); return r.length ? r[0].ids[0] : null; }
  let prg = raw.risks.find(r => r.category === "SCHWANGERSCHAFT" && medIdByName(r.medicationName));
  let prgId = medIdByName(prg.medicationName);
  let r0 = MS.risksFor([prgId], ["SCHWANGERSCHAFT"]);
  ok("Patientenrisiko (Schwangerschaft) korrekt zugeordnet",
    r0.length >= 1 && r0.some(x => x.title === prg.riskTitle),
    "med=" + prg.medicationName + " n=" + r0.length);
  // ohne Profil -> keine Risiken
  let rNone = MS.risksFor([prgId], []);
  ok("ohne Profil keine Risiken", rNone.length === 0, "n=" + rNone.length);
  if (r0.length) console.log("     Risiko:", r0[0].sev.label, "-", r0[0].title);

  // --- Anti-Regression: Risiken NUR dem passenden Wirkstoff zuordnen ---
  // (früherer Bug: alle Risiken einer Kategorie wurden dem gewählten Med angehängt)
  let aspId = MS.detect("Aspirin")[0].medId;
  let aspRisks = MS.risksFor([aspId], ["KINDER"]);
  let aspIngOk = aspRisks.length >= 1 && aspRisks.every(x => /acetylsalicyl/i.test(x.ingredient));
  ok("Risiken nur für gewählten Wirkstoff (keine Fehlzuordnung)", aspIngOk,
    "n=" + aspRisks.length + " ings=" + [...new Set(aspRisks.map(x => x.ingredient))].join(","));
  let aspTitles = aspRisks.map(x => x.title);
  ok("Aspirin/KINDER enthält Reye-Syndrom", aspTitles.some(t => /Reye/i.test(t)), aspTitles.join(" | "));
  ok("Aspirin/KINDER enthält KEIN fremdes Risiko (Grey-Syndrom)",
    !aspTitles.some(t => /Grey|Grau-?Syndrom/i.test(t)), aspTitles.join(" | "));
  // Klassen-Zuordnung: ein NSAR muss ein NSAR-Klassenrisiko erhalten, wenn vorhanden
  let ibuId2 = MS.detect("Ibuprofen")[0].medId;
  let ibuRisks = MS.risksFor([ibuId2], ["SCHWANGERSCHAFT"]);
  ok("Ibuprofen/Schwangerschaft nur Ibuprofen-Wirkstoff",
    ibuRisks.every(x => /ibuprofen/i.test(x.ingredient)),
    "ings=" + [...new Set(ibuRisks.map(x => x.ingredient))].join(","));

  // --- Erweiterte Handelsnamen-Datenbank ---
  ok("Synonym-DB erweitert (>= 250)", meta.counts.synonyms >= 250, "n=" + meta.counts.synonyms);
  let newSyn = MS.detect("Patient nimmt Seroquel und Xarelto");
  let nsi = newSyn.map(x => x.ingredient);
  ok("neuer Handelsname Seroquel -> Quetiapin", nsi.includes("Quetiapin"), JSON.stringify(nsi));

  // --- Kombipräparate: ein Handelsname -> mehrere Wirkstoffe ---
  let jm = MS.search("janumet");
  let jmPick = jm.find(p => p.ids.length > 1);
  ok("Kombi 'Janumet' liefert 2 Wirkstoffe (Pick)", !!jmPick && jmPick.ids.length === 2,
    jmPick ? jmPick.sub : "kein Kombi-Pick");
  if (jmPick) {
    let jmIngs = jmPick.ids.map(id => MS.medById(id).activeIngredient).sort();
    ok("Janumet = Metformin + Sitagliptin",
      jmIngs.includes("Metformin") && jmIngs.includes("Sitagliptin"), jmIngs.join(" + "));
  }
  // Kombi über OCR-Detect: beide Bestandteile werden als ids geliefert
  let dj = MS.detect("Janumet 50 mg/1000 mg");
  let djIds = []; dj.forEach(f => (f.ids || [f.medId]).forEach(i => { if (djIds.indexOf(i) === -1) djIds.push(i); }));
  let djIngs = djIds.map(i => MS.medById(i).activeIngredient);
  ok("Detect 'Janumet' fügt beide Wirkstoffe hinzu",
    djIngs.includes("Metformin") && djIngs.includes("Sitagliptin"), djIngs.join(" + "));
  // Kombi Targin = Oxycodon + Naloxon
  let tg = MS.search("targin").find(p => p.ids.length > 1);
  let tgIngs = tg ? tg.ids.map(id => MS.medById(id).activeIngredient).sort() : [];
  ok("Kombi 'Targin' = Oxycodon + Naloxon",
    tgIngs.includes("Oxycodon") && tgIngs.includes("Naloxon"), tgIngs.join(" + "));
  // Kombi wirkt in der Analyse: Delix plus (Ramipril+HCT) + ein NSAR -> Triple-Whammy-Nähe
  let dpPick = MS.search("delix plus").find(p => p.ids.length > 1);
  ok("Kombi 'Delix plus' = Ramipril + HCT", !!dpPick &&
    dpPick.ids.map(id => MS.medById(id).activeIngredient).sort().join("+") === "Hydrochlorothiazid+Ramipril",
    dpPick ? dpPick.sub : "n/a");

  // --- DB-Integrität: jeder Synonym-Wirkstoff existiert wirklich ---
  const rawDb = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  const ingNorm = new Set(rawDb.medications.map(m => MS.norm(m.activeIngredient)));
  let brokenSyn = [];
  Object.keys(rawDb.synonyms).forEach(k => {
    let v = rawDb.synonyms[k]; let list = Array.isArray(v) ? v : [v];
    // mind. EIN Bestandteil muss existieren (Kombis dürfen nicht-gelistete Zusatzstoffe nennen)
    if (!list.some(x => ingNorm.has(MS.norm(x)))) brokenSyn.push(k + " -> " + JSON.stringify(v));
  });
  ok("kein Synonym zeigt komplett ins Leere", brokenSyn.length === 0, brokenSyn.slice(0, 5).join("; "));

  // --- PZN (Pharmazentralnummer): Prüfziffer + Parsing ----------------------
  // Testvektoren sind rein arithmetisch (mod-11), keine echten Präparate.
  ok("PZN-Prüfziffer: 03110083 gültig", MS.pzn.check("03110083"));
  ok("PZN-Prüfziffer: 12345678 gültig", MS.pzn.check("12345678"));
  ok("PZN-Prüfziffer: 12345670 ungültig (falsche Prüfziffer)", !MS.pzn.check("12345670"));
  ok("PZN-Prüfziffer: Rest 10 => ungültig (0000003X)", !MS.pzn.check("00000030") && !MS.pzn.check("00000035"));
  ok("PZN-Prüfziffer: zu kurz/lang ungültig", !MS.pzn.check("123") && !MS.pzn.check("123456789"));

  var pLabel = MS.pzn.parse("Beloc-Zok PZN-12345678, 30 St.");
  ok("PZN-Parse: ausgezeichnete 'PZN-12345678'", pLabel && pLabel.pzn === "12345678" && pLabel.source === "label",
    JSON.stringify(pLabel));
  var pHyphen = MS.pzn.parse("-12345678");           // Code-39-Rohwert mit Bindestrich
  ok("PZN-Parse: Code-39 '-12345678'", pHyphen && pHyphen.pzn === "12345678", JSON.stringify(pHyphen));
  var pGtin = MS.pzn.parse("01)04150031100839(17)261130");   // GS1-DataMatrix mit Pharma-GTIN 4150…
  ok("PZN-Parse: aus GTIN 4150+PZN abgeleitet", pGtin && pGtin.pzn === "03110083",
    JSON.stringify(pGtin));
  var pSeven = MS.pzn.parse("PZN 1234562");          // 7-stellige Schreibweise -> auf 8 normalisiert
  ok("PZN-Parse: 7-stellig -> 01234562", pSeven && pSeven.pzn === "01234562", JSON.stringify(pSeven));
  ok("PZN-Parse: Text ohne Nummer => null", MS.pzn.parse("kein code hier") === null);

  console.log("\n" + (fail === 0 ? "ALLE GRÜN" : fail + " FEHLGESCHLAGEN") + "  (" + pass + " ok, " + fail + " fail)");
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error("CRASH", e); process.exit(2); });
