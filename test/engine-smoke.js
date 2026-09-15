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

  // --- Trennzeichen-toleranter Abgleich (Kamera-OCR spaltet Namen oft mitten
  //     im Wort oder mit fremden Trennzeichen; ohne diesen Weg bliebe der Treffer
  //     leer, da die kurzen Bruchstücke einzeln nicht fuzzy-matchen) ---
  let sp1 = MS.detect("parace tamol 500").map(x => x.ingredient);
  ok("gespalten: 'parace tamol' -> Paracetamol", sp1.includes("Paracetamol"), JSON.stringify(sp1));
  let sp2 = MS.detect("metfor min 1000").map(x => x.ingredient);
  ok("gespalten: 'metfor min' -> Metformin", sp2.includes("Metformin"), JSON.stringify(sp2));
  let sp3 = MS.detect("panto prazol").map(x => x.ingredient);
  ok("gespalten: 'panto prazol' -> Pantoprazol", sp3.includes("Pantoprazol"), JSON.stringify(sp3));
  // Dosisangaben (reine Ziffern) dürfen nichts erkennen
  ok("reine Ziffern erkennen kein Medikament", MS.detect("400 100 1000 20 5").length === 0, JSON.stringify(MS.detect("400 100 1000 20 5").map(x=>x.ingredient)));

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
  // L-Thyrox HEXAL (Levothyroxin): getippte Suche des vollen Markennamens findet den Wirkstoff
  let lt = MS.search("l-thyrox hexal");
  ok("Suche 'l-thyrox hexal' -> Levothyroxin", lt.length > 0 && /levothyroxin/i.test(lt[0].sub), lt.map(m => m.name).join(","));
  // und der Packungstext wird per Scan/OCR erkannt
  let ltd = MS.detect("L-Thyrox HEXAL 75 Mikrogramm Tabletten").map(x => x.ingredient);
  ok("Scan 'L-Thyrox HEXAL 75 …' -> Levothyroxin", ltd.includes("Levothyroxin"), JSON.stringify(ltd));

  // --- Marken-Suche sichtbar + stärke-tolerant (2026-09-04, SW -19) ----------
  // (a) exakt der gemeldete Nutzerfall: "L-Thyroxin" tippen findet den Eintrag …
  let ltx = MS.search("L-Thyroxin");
  ok("Suche 'L-Thyroxin' -> Levothyroxin", ltx.length > 0 && /levothyroxin/i.test(ltx[0].sub), ltx.map(m => m.name).join(","));
  // … und der Treffer weist die erkannte Marke aus (brand-Feld, != Wirkstoffname)
  ok("Treffer trägt Marken-Hinweis 'brand' (!= Wirkstoffname)",
    !!ltx[0] && /l-?thyroxin/i.test(ltx[0].brand || "") && (ltx[0].brand || "").toLowerCase() !== (ltx[0].name || "").toLowerCase(),
    "brand=" + (ltx[0] && ltx[0].brand));
  // (b) stärke-tolerant: voller Markenname MIT Dosis (früher 0 Treffer)
  let lts = MS.search("L-Thyrox HEXAL 75");
  ok("stärke-tolerant: 'L-Thyrox HEXAL 75' -> Levothyroxin", lts.length > 0 && /levothyroxin/i.test(lts[0].sub), lts.map(m => m.name).join(","));
  let lts2 = MS.search("l-thyrox hexal 100 µg");
  ok("stärke-tolerant: 'l-thyrox hexal 100 µg' -> Levothyroxin", lts2.length > 0 && /levothyroxin/i.test(lts2[0].sub), lts2.map(m => m.name).join(","));
  // (c) auch generischer Name mit Dosis
  let ibx = MS.search("Ibuprofen 400");
  ok("stärke-tolerant: 'Ibuprofen 400' -> Ibuprofen", ibx.length > 0 && /ibuprofen/i.test(ibx[0].sub), ibx.map(m => m.name).join(","));
  // (d) generisch getippt -> KEIN Marken-Hinweis (via null, brand leer)
  let lvx = MS.search("Levothyroxin");
  ok("generisch 'Levothyroxin' ohne Marken-Hinweis", lvx.length > 0 && !lvx[0].brand, "brand=" + (lvx[0] && lvx[0].brand));

  // --- Marken-Dubletten-Bereinigung (2026-09-04, DB ms-db-2026-09-04-5) -----
  // Marken-Interaktionszeilen (Losec/Nexium …) doppelten früher die generische
  // Zeile (Omeprazol/Esomeprazol). Da interactionsFor() über den Wirkstoff matcht,
  // bleibt die Interaktion über die generische Zeile erhalten -> das Paar MUSS
  // jetzt GENAU EINE Displayzeile liefern, nie null (Regression gegen versehentl.
  // Über-Löschen) und nie zwei (Regression gegen Rückkehr der Dublette).
  const rawDbEarly = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  const medsByIng = (w) => rawDbEarly.medications
    .filter(m => MS.norm(m.activeIngredient) === MS.norm(w)).map(m => m.id);
  const pairLines = (ids, re) => MS.interactionsFor([49].concat(ids)).filter(x => {
    const n = x.drug1 + "|" + x.drug2; return /levothyroxin/i.test(n) && re.test(n);
  }).length;
  const omeAll = medsByIng("Omeprazol"), esoAll = medsByIng("Esomeprazol");
  ok("bereinigt: Levothyroxin + Omeprazol (inkl. Marke Losec) = genau 1 Zeile",
    pairLines(omeAll, /omeprazol/i) === 1, "n=" + pairLines(omeAll, /omeprazol/i));
  ok("bereinigt: Levothyroxin + Esomeprazol (inkl. Marke Nexium) = genau 1 Zeile",
    pairLines(esoAll, /esomeprazol/i) === 1, "n=" + pairLines(esoAll, /esomeprazol/i));

  // --- Gruppe-A-Harmonisierung (2026-09-04, DB ms-db-2026-09-04-6) -----------
  // 50 Marken-Zeilen trugen einen ANDEREN (markenspezifischen) Titel als die
  // generische Zeile -> keine Titel-Dedup -> dieselbe Interaktion erschien
  // ZWEIMAL mit widersprüchlichem Schweregrad. Belegbasiert vereinheitlicht:
  // Marken-Zeile entfernt, generische Zeile auf den belegten Schweregrad ->
  // jedes Paar MUSS jetzt GENAU EINE Zeile mit korrektem Schweregrad liefern.
  const oneIng = (w) => (rawDbEarly.medications
    .find(m => MS.norm(m.activeIngredient) === MS.norm(w)) || {}).id;
  const harmo = (w1, w2, sevWant) => {
    const L = MS.interactionsFor([oneIng(w1), oneIng(w2)]);
    return { n: L.length, sev: L[0] && L[0].severity,
      pass: L.length === 1 && !!L[0] && L[0].severity === sevWant };
  };
  let hh;
  hh = harmo("Escitalopram", "Duloxetin", 3);
  ok("harmonisiert: Escitalopram+Duloxetin (SSRI+SNRI) = 1 Zeile, Schwer(3)", hh.pass, "n=" + hh.n + " sev=" + hh.sev);
  hh = harmo("Tramadol", "Lorazepam", 3);
  ok("harmonisiert: Tramadol+Lorazepam (Opioid+Benzo) = 1 Zeile, Schwer(3)", hh.pass, "n=" + hh.n + " sev=" + hh.sev);
  hh = harmo("Clopidogrel", "Omeprazol", 3);
  ok("harmonisiert: Clopidogrel+Omeprazol = 1 Zeile, Schwer(3) [angehoben, FDA rät ab]", hh.pass, "n=" + hh.n + " sev=" + hh.sev);
  hh = harmo("Clopidogrel", "Pantoprazol", 1);
  ok("harmonisiert: Clopidogrel+Pantoprazol = 1 Zeile, Mild(1) [Pantoprazol empf. PPI]", hh.pass, "n=" + hh.n + " sev=" + hh.sev);
  hh = harmo("Paracetamol", "Carbamazepin", 2);
  ok("harmonisiert: Paracetamol+Carbamazepin = 1 Zeile, Moderat(2)", hh.pass, "n=" + hh.n + " sev=" + hh.sev);

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

  // --- DB-Integrität: keine echten Medikamenten-Dubletten -------------------
  // (früher: Valsartan 80/182 und Glucophage 35/242 doppelt -> 2026-09-03 zusammengeführt).
  // Marken vs. Generika (Diovan/Valsartan, Glucophage/Metformin) haben UNTERSCHIEDLICHE
  // Namen und sind erlaubt; verboten ist nur identischer Name UND Wirkstoff.
  let medDupes = {};
  rawDb.medications.forEach(m => {
    let k = MS.norm(m.name) + "|" + MS.norm(m.activeIngredient);
    (medDupes[k] = medDupes[k] || []).push(m.id);
  });
  let dupMeds = Object.keys(medDupes).filter(k => medDupes[k].length > 1);
  ok("keine doppelten Medikamente (gleicher Name + Wirkstoff)", dupMeds.length === 0,
    dupMeds.map(k => k + " ids=" + medDupes[k].join("/")).slice(0, 5).join("; "));
  // keine Interaktion referenziert eine nicht-existente Med-ID / ist ein Selbstpaar
  const medIdSet = new Set(rawDb.medications.map(m => m.id));
  let badInter = rawDb.interactions.filter(x =>
    !medIdSet.has(x.drugId1) || !medIdSet.has(x.drugId2) || x.drugId1 === x.drugId2);
  ok("Interaktionen ohne dangling/Selbst-Referenz", badInter.length === 0,
    badInter.slice(0, 5).map(x => "#" + x.id).join(","));
  // komplexe Datensätze müssen konsistent sein: drugCount == Anzahl IDs == Anzahl Namen,
  // keine doppelte ID, keine ID ohne Medikament (kein dangling). Brands desselben
  // Wirkstoffs sind erlaubt (eigene IDs), aber keine exakte ID-Dublette in derselben Zeile.
  let badComplex = rawDb.complex.filter(x => {
    let ids = String(x.drugIds).split(",").map(n => parseInt(n, 10));
    let names = String(x.drugNames).split(",").map(s => s.trim()).filter(Boolean);
    let hasDup = ids.length !== new Set(ids).size;
    let hasDangling = ids.some(i => !medIdSet.has(i));
    return hasDup || hasDangling || ids.length !== x.drugCount || names.length !== x.drugCount;
  });
  ok("komplexe Sätze: drugCount == #IDs == #Namen, keine dup/dangling IDs", badComplex.length === 0,
    badComplex.slice(0, 5).map(x => "#" + x.id + "(" + x.drugIds + "/" + x.drugCount + ")").join(", "));

  // --- Patientenprofil-Kategorien: kein toter Schalter, keine Label-Drift ----
  // (2026-09-08: redundante Kategorie ALTER entfernt, categoryLabel je Kategorie
  // auf EINE kanonische Schreibweise vereinheitlicht — s. RISK_CATEGORIES.)
  const catKeys = new Set(MS.RISK_CATEGORIES.map(c => c.key));
  const risksByCat = {};
  rawDb.risks.forEach(r => { (risksByCat[r.category] = risksByCat[r.category] || []).push(r); });
  // (a) jeder Schalter hat mindestens ein hinterlegtes Risiko (Guard ohne Aufrufer = teuerster Fehler)
  let deadToggles = MS.RISK_CATEGORIES.filter(c => !(risksByCat[c.key] && risksByCat[c.key].length));
  ok("jeder Profil-Schalter hat >=1 Risiko (kein toter Schalter)", deadToggles.length === 0,
    deadToggles.map(c => c.key).join(", "));
  // (b) keine Risiko-Kategorie ohne passenden Schalter (kein verwaister Datensatz wie früher ALTER)
  let orphanCats = Object.keys(risksByCat).filter(k => !catKeys.has(k));
  ok("keine Risiko-Kategorie ohne Schalter (kein Waisen-Datensatz)", orphanCats.length === 0,
    orphanCats.map(k => k + " n=" + risksByCat[k].length).join(", "));
  // (c) Schalter-Label == DB-categoryLabel, genau EINE Schreibweise je Kategorie
  let labelDrift = MS.RISK_CATEGORIES.filter(c => {
    let labels = [...new Set((risksByCat[c.key] || []).map(r => r.categoryLabel))];
    return labels.length !== 1 || labels[0] !== c.label;
  });
  ok("categoryLabel konsistent & == Schalter-Label (keine ASCII-/Doppel-Labels)", labelDrift.length === 0,
    labelDrift.map(c => c.key + " toggle=\"" + c.label + "\" db=" +
      JSON.stringify([...new Set((risksByCat[c.key] || []).map(r => r.categoryLabel))])).join("; "));

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

  // --- Bundeseinheitlicher Medikationsplan (BMP / Data-Matrix) --------------
  // (2026-09-15, gemeldeter Fehler: „App scannt den Plan, zeigt aber keine
  //  Wechselwirkung".) Ein gescannter Medikationsplan ist eine XML-artige
  //  Nutzlast <MP…><M …/></MP>. Frühere DOPPELTE Falle:
  //   (A) Die vielen Zahlen darin enthielten zufällig eine prüfziffer-gültige
  //       Ziffernfolge -> pzn.parse() lieferte eine FALSCHE Einzel-PZN und die
  //       App blieb dort stehen, statt den ganzen Plan zu lesen.
  //   (B) Fuzzy-Matching erfand aus exakten Namen lev-3-Nachbarn hinzu.
  //  Jetzt: looksStructured() erkennt Markup -> pzn.parse()=null; bmp.text()
  //  erntet die Namen; detect() gleicht sie belegt & exklusiv gegen die DB ab.
  //  Nachbau des ARMIN-Musters (Auszug: die Meds, die belegte Paare bilden).
  var bmp = '<MP v="025" l="de-DE" U="a1b2c3d4e5f6"><PI g="Armin" f="Müller" b="19500101"/>' +
    '<S><M p="00489337" t="Metoprololsucc. Beta 47,5" w="Metoprolol" s="47,5 mg" du="1-0-1"/>' +
    '<M p="03105842" t="Ramipril AbZ 5 mg" w="Ramipril" s="5 mg" du="1-0-0"/>' +
    '<M p="00489344" t="Clopidogrel Zentiva" w="Clopidogrel" s="75 mg" du="1-0-0"/>' +
    '<M p="02532741" t="Pantoprazol Actavis" w="Pantoprazol" s="40 mg" du="1-0-0"/>' +
    '<M p="02207085" t="Simvastatin AL" w="Simvastatin" s="40 mg" du="0-0-1"/>' +
    '<M p="01234562" t="Clarithromycin HEC" w="Clarithromycin" s="500 mg" du="1-0-1"/>' +
    '<M p="12345678" t="NovoRapid Penfill" w="Insulin aspart" s="100 E/ml" du="n. Plan"/>' +
    '</S></MP>';

  // (A) DataMatrix-Falle geschlossen: der ganze Plan wird NIE als Einzel-PZN geraten
  ok("BMP: pzn.parse(<MP…>) => null (keine falsche Einzel-PZN)",
    MS.pzn.parse(bmp) === null, JSON.stringify(MS.pzn.parse(bmp)));
  ok("BMP: looksStructured erkennt Markup", MS.bmp.looksStructured(bmp) === true);
  ok("BMP: looksStructured=false bei Freitext (kein Fehlalarm)",
    MS.bmp.looksStructured("Metoprolol 47,5 mg 1-0-1 taeglich") === false);

  // bmp.text() erntet die Namen aus den Attributwerten
  var bmpNames = MS.bmp.text(bmp);
  ok("BMP: bmp.text() erntet Namen (nicht leer, enthält Wirkstoffe)",
    bmpNames.length > 0 && /Metoprolol/.test(bmpNames) && /Clarithromycin/.test(bmpNames), bmpNames.slice(0, 90));
  ok("BMP: bmp.text('') leer (kein Markup -> nichts ernten)", MS.bmp.text("Aspirin 100") === "");

  // detect() über die geernteten Namen findet die echten Wirkstoffe des Plans
  var bmpDet = MS.detect(bmpNames);
  var bmpIng = bmpDet.map(x => x.ingredient);
  ["Metoprolol", "Ramipril", "Clopidogrel", "Pantoprazol", "Simvastatin", "Clarithromycin", "Insulin"].forEach(function (w) {
    ok("BMP: detect findet " + w, bmpIng.indexOf(w) !== -1, JSON.stringify(bmpIng));
  });

  // Kern des gemeldeten Fehlers: der Plan MUSS die belegten Wechselwirkungen zeigen.
  // Paare über den Interaktions-Titel prüfen (drug1/drug2 tragen Marken-Namen).
  var bmpIds = [];
  bmpDet.forEach(f => (f.ids && f.ids.length ? f.ids : [f.medId]).forEach(id => { if (bmpIds.indexOf(id) === -1) bmpIds.push(id); }));
  var bmpA = MS.analyze(bmpIds, []);
  var titleHas = (re1, re2) => bmpA.interactions.some(x => re1.test(x.title || "") && re2.test(x.title || ""));
  ok("BMP-Analyse: Simvastatin + Clarithromycin (Rhabdomyolyse) erkannt",
    titleHas(/simvastatin/i, /clarithromycin/i), "n=" + bmpA.interactions.length);
  ok("BMP-Analyse: Clopidogrel + Pantoprazol erkannt",
    titleHas(/clopidogrel/i, /pantoprazol/i), "n=" + bmpA.interactions.length);
  ok("BMP-Analyse: Insulin + Metoprolol (Hypoglykämie-Maskierung) erkannt",
    titleHas(/insulin/i, /metoprolol/i), "n=" + bmpA.interactions.length);

  // Anti-Fabrikation: exakte Wirkstoffnamen dürfen KEINE lev-3-Nachbarn erfinden
  // (früher aus dem Plan geleakt: clarithromycin->Azithromycin,
  //  simvastatin->Pravastatin & ->Lovastatin — alle Levenshtein-Distanz 3).
  var phantomSrc = MS.detect("Clarithromycin 500 mg, Simvastatin 40 mg").map(x => x.ingredient);
  ok("Anti-Phantom: erkennt exakt Clarithromycin + Simvastatin",
    phantomSrc.indexOf("Clarithromycin") !== -1 && phantomSrc.indexOf("Simvastatin") !== -1, JSON.stringify(phantomSrc));
  ok("Anti-Phantom: KEIN Azithromycin (lev-3-Nachbar von Clarithromycin)",
    phantomSrc.indexOf("Azithromycin") === -1, JSON.stringify(phantomSrc));
  ok("Anti-Phantom: KEIN Pravastatin (lev-3-Nachbar von Simvastatin)",
    phantomSrc.indexOf("Pravastatin") === -1, JSON.stringify(phantomSrc));
  ok("Anti-Phantom: KEIN Lovastatin (lev-3-Nachbar von Simvastatin)",
    phantomSrc.indexOf("Lovastatin") === -1, JSON.stringify(phantomSrc));

  // Anti-Phantom II — Allerweltswort vs. 4-Zeichen-Synonym (2026-09-15, SW -30).
  // Die Clarithromycin-Zeile des realen ARMIN-Plans trägt die Dosierung
  // „alle 12 Std."; das deutsche Stoppwort „alle" ist Levenshtein-1 vom
  // 4-Zeichen-Synonym „allo" (Allopurinol) -> ohne die COMMON_DE-Sperre erfände
  // detect() ein NICHT verordnetes Allopurinol in den Plan (Anti-Fabrikation).
  // Die Sperre muss das Wort blocken, ohne das echte Synonym zu brechen.
  var alleSrc = MS.detect("Clarithromycin alle 12 Std.").map(x => x.ingredient);
  ok("Anti-Phantom: 'alle 12 Std.' erfindet KEIN Allopurinol",
    alleSrc.indexOf("Allopurinol") === -1, JSON.stringify(alleSrc));
  ok("Anti-Phantom: dabei korrekt Clarithromycin erkannt",
    alleSrc.indexOf("Clarithromycin") !== -1, JSON.stringify(alleSrc));
  // Gegenprobe: die Stoppwort-Sperre bricht das echte Synonym/den Namen NICHT
  ok("Gegenprobe: Synonym 'allo' -> Allopurinol bleibt erkannt",
    MS.detect("allo").map(x => x.ingredient).indexOf("Allopurinol") !== -1,
    JSON.stringify(MS.detect("allo").map(x => x.ingredient)));
  ok("Gegenprobe: Name 'Allopurinol' bleibt erkannt",
    MS.detect("Allopurinol").map(x => x.ingredient).indexOf("Allopurinol") !== -1);

  // Echt-Positiv — Johanniskraut/Laif (2026-09-15). Auf dem realen Plan steht in
  // der Selbstmedikation ein Johanniskraut-Präparat; als starker CYP3A4-Induktor
  // ist es interaktions-relevant und MUSS erkannt werden (Wirkstoff Hypericum
  // perforatum). Schützt gegen eine später zu aggressive Stoppwort-/Filterliste,
  // die diesen echten Treffer versehentlich mit-abräumt.
  var jkSrc = MS.detect("Laif 900 Johanniskraut").map(x => x.ingredient);
  ok("Positiv: Johanniskraut/Laif -> Hypericum perforatum erkannt",
    jkSrc.indexOf("Hypericum perforatum") !== -1, JSON.stringify(jkSrc));
  var jkFind = MS.search("laif");
  ok("Suche 'Laif' -> Johanniskraut (Hypericum perforatum)",
    jkFind.length > 0 && /hypericum/i.test(jkFind[0].sub), jkFind.map(m => m.name).join(","));

  // --- Kalender-Export (.ics) für Einnahme-Erinnerungen ---------------------
  ok("Zeit: '8:00' -> '08:00'", MS.ics.validTime("8:00") === "08:00");
  ok("Zeit: '23:59' gültig", MS.ics.validTime("23:59") === "23:59");
  ok("Zeit: '24:00' ungültig", MS.ics.validTime("24:00") === null);
  ok("Zeit: '12:60' ungültig", MS.ics.validTime("12:60") === null);
  ok("Zeit: '8:5' ungültig (2-stellige Minuten nötig)", MS.ics.validTime("8:5") === null);
  ok("ICS-Escape: Komma/Semikolon/Newline/Backslash",
    MS.ics.escape("A, B; C\nD\\E") === "A\\, B\\; C\\nD\\\\E", MS.ics.escape("A, B; C\nD\\E"));

  const now = new Date(2026, 8, 3, 10, 0, 0);   // lokal 2026-09-03 10:00
  const plan = { id: "p_test", name: "Morgens, Abends", times: ["20:00", "08:00", "08:00"] };
  const ics = MS.ics.build(plan, ["Ibuprofen", "ASS, 100"], now);
  const cnt = (re) => (ics.match(re) || []).length;
  ok("ICS: Gerüst VCALENDAR", /^BEGIN:VCALENDAR/.test(ics) && /END:VCALENDAR\r\n$/.test(ics));
  ok("ICS: 2 VEVENT (Duplikat-Zeit entfernt)", cnt(/BEGIN:VEVENT/g) === 2, "n=" + cnt(/BEGIN:VEVENT/g));
  ok("ICS: tägliche Wiederholung", cnt(/RRULE:FREQ=DAILY/g) === 2);
  ok("ICS: VALARM je Termin", cnt(/BEGIN:VALARM/g) === 2 && /TRIGGER:PT0M/.test(ics));
  ok("ICS: Datum heute + floating Zeit", ics.indexOf("DTSTART:20260903T080000") !== -1);
  ok("ICS: Zeiten sortiert (08 vor 20)", ics.indexOf("T080000") < ics.indexOf("T200000"));
  ok("ICS: UID trägt Plan-ID", /UID:p_test-20260903-0800@mediscan\.vaydena\.de/.test(ics));
  ok("ICS: Komma im Plannamen escaped", /SUMMARY:.*Morgens\\, Abends/.test(ics));
  ok("ICS: Komma im Medikamentennamen escaped", /DESCRIPTION:.*ASS\\, 100/.test(ics));
  ok("ICS: CRLF-Zeilenenden", ics.indexOf("\r\n") !== -1);
  ok("ICS: ohne gültige Zeit => null", MS.ics.build({ id: "x", name: "X", times: [] }, [], now) === null &&
    MS.ics.build({ id: "x", name: "X", times: ["bogus"] }, [], now) === null);

  // --- Öffentliche FDA-Datenebene: Form + Anti-Fabrikations-Gate ------------
  // mediscan-fda.json ist eine SEPARATE Ebene: nur wörtliche US-FDA-Originaltexte,
  // je Med-ID entweder ein Textsatz oder null. KEINE abgeleiteten Schweregrade.
  const FDA_PATH = path.join(__dirname, "..", "assets", "data", "mediscan-fda.json");
  const fda = JSON.parse(fs.readFileSync(FDA_PATH, "utf8"));
  ok("FDA: meta.source nennt openFDA", /openFDA/i.test(fda.meta && fda.meta.source), fda.meta && fda.meta.source);
  ok("FDA: Lizenz Public Domain", /public domain/i.test(fda.meta && fda.meta.license), fda.meta && fda.meta.license);
  ok("FDA: Feld drug_interactions (SPL 7)", /drug_interactions/.test(fda.meta && fda.meta.field), fda.meta && fda.meta.field);

  const fdaKeys = Object.keys(fda.items || {});
  const dbIds = new Set(rawDb.medications.map(m => String(m.id)));
  let badKey = fdaKeys.filter(k => !dbIds.has(k));
  ok("FDA: jede Med-ID existiert in der DB", badKey.length === 0, badKey.slice(0, 5).join(","));

  const withText = fdaKeys.filter(k => fda.items[k] && fda.items[k].text);
  ok("FDA: sinnvolle Abdeckung (>= 150 Meds mit Text)", withText.length >= 150, "n=" + withText.length + "/" + fdaKeys.length);

  // jedes Record: entweder null, oder {text:string} – niemals ein abgeleiteter Schweregrad
  const SEV_FIELDS = ["severity", "sev", "rank", "schweregrad", "level"];
  let shapeBad = [], sevInjected = [];
  fdaKeys.forEach(k => {
    const v = fda.items[k];
    if (v === null) return;
    if (typeof v.text !== "string" || v.text.length < 20) shapeBad.push(k);
    SEV_FIELDS.forEach(f => { if (f in v) sevInjected.push(k + "." + f); });
  });
  ok("FDA: Records haben brauchbaren Text (oder null)", shapeBad.length === 0, shapeBad.slice(0, 5).join(","));
  ok("FDA: KEINE abgeleiteten Schweregrad-Felder (Anti-Fabrikation)", sevInjected.length === 0, sevInjected.slice(0, 5).join(","));

  // Sanity: der Text ist echte englische FDA-Prosa, keine eingespritzten deutschen Wertungen
  const DE_VERDICTS = /(Schwerwiegend|Kontraindiziert|Mäßig|Leicht|Vorsicht geboten)/;
  let deInText = withText.filter(k => DE_VERDICTS.test(fda.items[k].text));
  ok("FDA: keine deutschen MediScan-Wertungen im Originaltext", deInText.length === 0, deInText.slice(0, 3).join(","));
  console.log("     FDA-Abdeckung:", withText.length, "von", fdaKeys.length, "Meds mit Original-Text");

  // --- Therapeutische Doppelung (duplicatesFor) ------------------------------
  // Rein STRUKTURELLER Hinweis aus den Stammdaten, keine klinische Wertung:
  // (A) derselbe Wirkstoff über >= 2 unterschiedliche Präparate,
  // (B) >= 2 unterschiedliche Wirkstoffe derselben Kategorie.
  // Bewusst NICHT im klinischen Banner; MDR-sicher (nur DB-Felder activeIngredient/category).
  const dupBy = (ids) => MS.duplicatesFor(ids);

  // (A) gleicher Wirkstoff: Aspirin + ASS = 1 Wirkstoff-Doppelung (Acetylsalicylsäure)
  const assIds = medsByIng("Acetylsalicylsäure");
  const dAss = dupBy(assIds);
  ok("Doppelung A: Aspirin+ASS => genau 1 Treffer",
    dAss.length === 1, "n=" + dAss.length + " ids=" + assIds.join(","));
  ok("Doppelung A: Typ 'ingredient', Wirkstoff Acetylsalicylsäure",
    !!dAss[0] && dAss[0].type === "ingredient" && /acetylsalicyl/i.test(dAss[0].ingredient || ""),
    dAss[0] && dAss[0].type + "/" + dAss[0].ingredient);
  ok("Doppelung A: nennt beide Präparate (Aspirin, ASS)",
    !!dAss[0] && dAss[0].names.indexOf("Aspirin") !== -1 && dAss[0].names.indexOf("ASS") !== -1,
    dAss[0] && dAss[0].names.join(" + "));
  ok("Doppelung A: Schweregrad rank 2 (dezent, nicht klinisch eskaliert)",
    !!dAss[0] && !!dAss[0].sev && dAss[0].sev.rank === 2, dAss[0] && dAss[0].sev && dAss[0].sev.rank);
  // String-IDs (kommen so aus dem DOM) müssen genauso greifen (parseInt-Pfad)
  ok("Doppelung A: greift auch bei String-IDs (DOM-Pfad)",
    dupBy(assIds.map(String)).length === 1);

  // Ibuprofen-Familie: 4 Marken, 1 Wirkstoff => 1 Treffer über mehrere Namen
  const ibuIds = medsByIng("Ibuprofen");
  const dIbu = dupBy(ibuIds);
  ok("Doppelung A: Ibuprofen-Familie => 1 Treffer über mehrere Marken",
    dIbu.length === 1 && dIbu[0].type === "ingredient" &&
    dIbu[0].names.indexOf("Ibuprofen") !== -1 && dIbu[0].names.indexOf("Nurofen") !== -1,
    dIbu[0] ? dIbu[0].names.join(" + ") : "n=0");

  // (B) gleiche Wirkstoffgruppe: zwei VERSCHIEDENE SSRI => 1 Klassen-Doppelung
  const ssriIds = [oneIng("Escitalopram"), oneIng("Sertralin")];
  const dSsri = dupBy(ssriIds);
  ok("Doppelung B: zwei SSRI (Escitalopram+Sertralin) => genau 1 Treffer",
    dSsri.length === 1, "n=" + dSsri.length);
  ok("Doppelung B: Typ 'class', Kategorie SSRI (keine Wirkstoff-Doppelung)",
    !!dSsri[0] && dSsri[0].type === "class" && dSsri[0].category === "SSRI",
    dSsri[0] && dSsri[0].type + "/" + dSsri[0].category);
  ok("Doppelung B: Schweregrad rank 1 (am dezentesten)",
    !!dSsri[0] && !!dSsri[0].sev && dSsri[0].sev.rank === 1, dSsri[0] && dSsri[0].sev && dSsri[0].sev.rank);

  // Keine Fehlalarme: Einzelmedikament + dieselbe ID doppelt (seenId-Dedup, kein Selbst-Treffer)
  ok("Doppelung: Einzelmedikament => 0 Treffer",
    dupBy([oneIng("Metformin")]).length === 0);
  ok("Doppelung: identische ID doppelt => 0 Treffer (Dedup)",
    dupBy([assIds[0], assIds[0]]).length === 0);

  // Sortierung + Ko-Existenz: Wirkstoff-Doppelung (rank2) VOR Klassen-Doppelung (rank1)
  const dMix = dupBy(assIds.concat(ssriIds));
  ok("Doppelung: A und B koexistieren, korrekt sortiert (ingredient vor class)",
    dMix.length === 2 && dMix[0].type === "ingredient" && dMix[1].type === "class",
    dMix.map(d => d.type).join(" > "));

  console.log("\n" + (fail === 0 ? "ALLE GRÜN" : fail + " FEHLGESCHLAGEN") + "  (" + pass + " ok, " + fail + " fail)");
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error("CRASH", e); process.exit(2); });
