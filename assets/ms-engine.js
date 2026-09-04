/* MediScan – Matching-Engine (offline, framework-frei)
 * Bildet die Logik der Original-App nach:
 *  - Wirkstoff-Äquivalenz (activeIngredient) als Schlüssel für Wechselwirkungen
 *  - Subset-Matching für Mehrfach-Wechselwirkungen (alle geforderten Wirkstoffe vorhanden)
 *  - Patientenrisiken per medicationId (echter FK) + Wirkstoff-Äquivalenz, gefiltert nach Profil
 *  - OCR-tolerantes Erkennen (Substring + Levenshtein) und validierte Handelsnamen
 * Keine erfundenen klinischen Daten – nur die rekonstruierte Original-DB + Namens-Synonyme.
 */
window.MediScan = (function () {
  "use strict";

  var DB = null;      // rohe Tabellen aus mediscan-db.json
  var IDX = null;     // aufgebaute Indizes

  // ---- Schweregrad: EINE einheitliche, eskalierende Skala -------------------
  // (Original-App hatte 3 widersprüchliche Paletten – hier vereinheitlicht.)
  var SEV_INTERACTION = {
    1: { label: "Mild",           color: "#388E3C", bg: "#E8F5E9", rank: 1 },
    2: { label: "Moderat",        color: "#F57C00", bg: "#FFF3E0", rank: 2 },
    3: { label: "Schwer",         color: "#E53935", bg: "#FFEBEE", rank: 3 },
    4: { label: "Kontraindiziert",color: "#B71C1C", bg: "#F9E0E0", rank: 4 }
  };
  var SEV_COMPLEX = {
    1: { label: "Mild",     color: "#388E3C", bg: "#E8F5E9", rank: 1 },
    2: { label: "Moderat",  color: "#F57C00", bg: "#FFF3E0", rank: 2 },
    3: { label: "Schwer",   color: "#E53935", bg: "#FFEBEE", rank: 3 },
    4: { label: "Kritisch", color: "#B71C1C", bg: "#F9E0E0", rank: 4 }
  };
  var SEV_RISK = {
    1: { label: "Hinweis",  color: "#388E3C", bg: "#E8F5E9", rank: 1 },
    2: { label: "Vorsicht", color: "#F57C00", bg: "#FFF3E0", rank: 2 },
    3: { label: "Warnung",  color: "#E53935", bg: "#FFEBEE", rank: 3 }
  };
  function sev(kind, level) {
    var t = kind === "complex" ? SEV_COMPLEX : kind === "risk" ? SEV_RISK : SEV_INTERACTION;
    return t[level] || { label: "Unbekannt", color: "#757575", bg: "#F5F5F5", rank: 0 };
  }

  // ---- Patientenprofil: Kategorien der Risikotabelle ------------------------
  // key = category in patient_risks; label = Anzeige; für Profil-Schalter.
  var RISK_CATEGORIES = [
    { key: "KINDER",           label: "Kind / Jugendliche" },
    { key: "AELTERE",          label: "Ältere Menschen" },
    { key: "ALTER",            label: "Ältere (≥ 65 J.)" },
    { key: "SCHWANGERSCHAFT",  label: "Schwangerschaft" },
    { key: "STILLZEIT",        label: "Stillzeit" },
    { key: "NIERE",            label: "Niereninsuffizienz" },
    { key: "LEBER",            label: "Leberinsuffizienz" },
    { key: "BEGLEITERKRANKUNG",label: "Begleiterkrankung" },
    { key: "GENETIK",          label: "Genetik / Laborwerte" }
  ];

  // ---- Normalisierung -------------------------------------------------------
  function norm(s) {
    return (s || "")
      .toString()
      .toLowerCase()
      .replace(/[®™]/g, "")
      .replace(/[^\wäöüß\s\-]/g, " ")   // Ziffern/Buchstaben/Umlaute/Bindestrich behalten
      .replace(/\s+/g, " ")
      .trim();
  }
  // Umlaut-Faltung: macht „Acetylsalicylsäure" und „Acetylsalicylsaeure" gleich.
  // (Die Risiko-Tabelle nutzt teils ASCII-Umschrift; so matchen beide Schreibweisen.)
  function fold(s) {
    return norm(s).replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
  }
  // Title-Case für die Anzeige von (klein gespeicherten) Handelsnamen.
  function cap(s) {
    return String(s || "").replace(/(^|[\s\-\/])([a-zäöü])/g, function (_m, sep, ch) { return sep + ch.toUpperCase(); });
  }

  // Trailing Dosis-/Darreichungs-Tokens abschneiden ("l-thyrox hexal 75",
  // "ibuprofen 400", "… 100 g") -> Kernname für stärke-tolerante Suche.
  // (norm() hat µ bereits zu Space gemacht -> aus "µg" wird das Token "g".)
  function stripDose(s) {
    var t = norm(s).split(" ").filter(Boolean), changed = true;
    while (t.length > 1 && changed) {
      changed = false;
      var last = t[t.length - 1];
      if (/^\d+([.,]\d+)?$/.test(last)) { t.pop(); changed = true; }
      else if (/^(mg|mcg|ug|µg|g|ml|l|ie|mmol|%|retard|tabl?|tabletten?|filmtabl(ette[n]?)?|kaps(el[n]?)?|stk|st)$/.test(last)) { t.pop(); changed = true; }
    }
    return t.join(" ");
  }
  // Scoring-Helfer für search(): Gleichheit > Präfix > Teilstring.
  function scMed(hay, needle) {
    if (!needle) return 0;
    if (hay === needle) return 100;
    if (hay.indexOf(needle) === 0) return 80;
    if (hay.indexOf(needle) !== -1) return 60;
    return 0;
  }
  function scSyn(hay, needle) {
    if (!needle || needle.length < 2) return 0;
    if (hay === needle) return 95;
    if (hay.indexOf(needle) === 0) return 78;
    if (needle.length >= 3 && hay.indexOf(needle) !== -1) return 58;
    return 0;
  }

  // Levenshtein mit Frühabbruch (max)
  function lev(a, b, max) {
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    if (la === 0) return lb; if (lb === 0) return la;
    var prev = new Array(lb + 1), cur = new Array(lb + 1), i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur[0] = i; var best = cur[0];
      var ca = a.charCodeAt(i - 1);
      for (j = 1; j <= lb; j++) {
        var cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1;
      var t = prev; prev = cur; cur = t;
    }
    return prev[lb];
  }
  function fuzzyOk(token, term) {
    var minl = Math.min(token.length, term.length);
    if (minl < 4) return false;
    var max = minl <= 5 ? 1 : minl <= 9 ? 2 : 3;
    return lev(token, term, max) <= max;
  }

  // ---- Index aufbauen -------------------------------------------------------
  function buildIndex() {
    var medById = {};
    var ingredientToIds = {};     // normalisierter Wirkstoff -> [medId,…]
    var terms = [];               // {t, medId, ing}  Suchbegriffe -> Med
    var foldResolve = {};         // gefalteter Name/Wirkstoff/Handelsname -> gefalteter Wirkstoff
    var i, m;

    for (i = 0; i < DB.medications.length; i++) {
      m = DB.medications[i];
      medById[m.id] = m;
      var ingN = norm(m.activeIngredient);
      (ingredientToIds[ingN] = ingredientToIds[ingN] || []).push(m.id);
      var nName = norm(m.name);
      if (nName.length >= 3) terms.push({ t: nName, medId: m.id, ing: ingN });
      if (ingN.length >= 3 && ingN !== nName) terms.push({ t: ingN, medId: m.id, ing: ingN });
      // Faltungs-Auflösung: sowohl Name als auch Wirkstoff zeigen auf den Wirkstoff.
      var fIng = fold(m.activeIngredient);
      foldResolve[fold(m.name)] = fIng;
      foldResolve[fIng] = fIng;
    }
    // validierte Handelsnamen -> Wirkstoff(e) -> repräsentative Med-IDs.
    // Wert ist String (Einzelwirkstoff) ODER Array (Kombipräparat, z. B.
    // „Janumet" = Metformin + Sitagliptin). Nicht gelistete Bestandteile werden
    // übersprungen (nie erfunden); bleibt kein bekannter Wirkstoff, entfällt der Eintrag.
    var syn = DB.synonyms || {};
    var synResolve = {};   // norm(Handelsname) -> [medId,…]  (ein Med je auflösbarem Wirkstoff)
    Object.keys(syn).forEach(function (k) {
      var val = syn[k];
      var ingList = Array.isArray(val) ? val : [val];
      var medIds = [], firstIng = null, seenIng = {};
      for (var s = 0; s < ingList.length; s++) {
        var ingN = norm(ingList[s]);
        if (seenIng[ingN]) continue; seenIng[ingN] = 1;
        var ids = ingredientToIds[ingN];
        if (ids && ids.length) { medIds.push(ids[0]); if (!firstIng) firstIng = ingN; }
      }
      if (!medIds.length) return;                 // Handelsname nennt keinen bekannten Wirkstoff
      var nk = norm(k);
      synResolve[nk] = medIds;
      terms.push({ t: nk, medId: medIds[0], ing: firstIng, syn: true,
                   combo: medIds.length > 1 ? medIds.slice() : null });
      foldResolve[fold(k)] = fold(ingList[0]);    // Handelsname -> (erster) Wirkstoff, gefaltet
    });

    IDX = { medById: medById, ingredientToIds: ingredientToIds, terms: terms,
            foldResolve: foldResolve, synResolve: synResolve };
  }

  async function load(url) {
    if (DB) return DB;
    var res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) throw new Error("DB laden fehlgeschlagen: HTTP " + res.status);
    DB = await res.json();
    buildIndex();
    return DB;
  }

  function meta() { return DB ? DB.meta : null; }
  function medById(id) { return IDX ? IDX.medById[id] : null; }
  function ingredientOf(id) { var m = medById(id); return m ? norm(m.activeIngredient) : null; }

  // ---- Erkennen aus OCR-Text ------------------------------------------------
  // liefert [{medId,name,ingredient,term,score,syn}] – je Wirkstoff EIN Treffer
  function detect(ocrText) {
    if (!IDX) return [];
    var full = norm(ocrText);
    // „Verklebte" Fassung ohne Leerzeichen/Bindestriche: fängt Handelsnamen, die
    // die Kamera-OCR getrennt liest (z. B. „ben u ron" statt „ben-u-ron", „beloc
    // zok"). Beide sind schon genormt → nur Space/Bindestrich müssen fallen.
    var squish = full.replace(/[ \-]/g, "");
    // Tokens für Fuzzy – reine Ziffernfolgen (Dosierungen wie „400", „1000") raus,
    // sie sind kein Wirkstoffname und würden das Fuzzy nur verrauschen.
    var rawTokens = full.split(" ").filter(function (w) {
      return w.length >= 3 && !/^\d+$/.test(w);
    });
    var tokens = Array.from(new Set(rawTokens));
    var bestByIng = {};   // ing -> {medId,term,score,syn}

    for (var i = 0; i < IDX.terms.length; i++) {
      var term = IDX.terms[i];
      var t = term.t, score = 0;
      // 1) Substring des Gesamttextes (stark)
      if (t.length >= 4 && full.indexOf(t) !== -1) {
        score = 100 + t.length;
      } else if (t.length >= 6 && t.replace(/[ \-]/g, "").length >= 6 &&
                 squish.indexOf(t.replace(/[ \-]/g, "")) !== -1) {
        // 1b) Trennzeichen-toleranter Substring (mehrwortige / getrennt gedruckte
        //     Namen). Nur ab 6 Zeichen, damit keine kurzen Namen zufällig in
        //     langen Wörtern „aufgehen".
        score = 96 + t.length;
      } else {
        // 2) Fuzzy gegen einzelne Tokens
        for (var j = 0; j < tokens.length; j++) {
          var tok = tokens[j];
          if (Math.abs(tok.length - t.length) > 3) continue;
          if (tok === t) { score = Math.max(score, 90 + t.length); break; }
          if (fuzzyOk(tok, t)) { score = Math.max(score, 60 + t.length); }
        }
      }
      if (score > 0) {
        var cur = bestByIng[term.ing];
        if (!cur || score > cur.score) {
          bestByIng[term.ing] = { medId: term.medId, term: t, score: score, syn: !!term.syn, combo: term.combo || null };
        }
      }
    }

    var out = [];
    Object.keys(bestByIng).forEach(function (ing) {
      var b = bestByIng[ing];
      var m = IDX.medById[b.medId];
      if (!m) return;
      out.push({
        medId: m.id, ids: b.combo ? b.combo.slice() : [m.id],
        name: m.name, ingredient: m.activeIngredient,
        category: m.category, term: b.term, score: b.score, syn: b.syn, combo: !!b.combo
      });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }

  // ---- Autocomplete-Suche (manuelles Hinzufügen) ----------------------------
  // Liefert einheitliche „pick"-Objekte: { ids:[medId,…], name, sub, category, via }.
  // Ein Kombipräparat trägt mehrere ids; die UI fügt beim Auswählen alle hinzu.
  function search(query, limit) {
    if (!IDX) return [];
    var q = norm(query);
    if (q.length < 2) return [];
    limit = limit || 12;
    // Stärke-tolerant: "L-Thyrox HEXAL 75", "Ibuprofen 400" auch ohne Dosis finden.
    var qCore = stripDose(q);
    var useCore = qCore !== q && qCore.length >= 2;
    var scored = [];
    // direkte Medikamenten-/Wirkstoff-Treffer
    for (var id in IDX.medById) {
      var m = IDX.medById[id];
      var nName = norm(m.name), nIng = norm(m.activeIngredient);
      var s = Math.max(scMed(nName, q), scMed(nIng, q));
      if (useCore) s = Math.max(s, scMed(nName, qCore), scMed(nIng, qCore));
      if (s > 0) scored.push({ ids: [m.id], name: m.name, sub: m.activeIngredient, category: m.category, via: null, s: s, key: "m" + m.id });
    }
    // Handelsnamen-Treffer (inkl. Kombipräparate)
    var syn = DB.synonyms || {};
    Object.keys(syn).forEach(function (k) {
      var nk = norm(k);
      var s = Math.max(scSyn(nk, q), useCore ? scSyn(nk, qCore) : 0);
      if (!s) return;
      var ids = IDX.synResolve[nk];
      if (!ids || !ids.length) return;
      if (ids.length === 1) {
        var mm = IDX.medById[ids[0]];
        scored.push({ ids: [mm.id], name: mm.name, sub: mm.activeIngredient, category: mm.category, via: k, brand: cap(k), s: s, key: "m" + mm.id });
      } else {
        var subs = ids.map(function (i) { return IDX.medById[i].activeIngredient; }).join(" + ");
        scored.push({ ids: ids.slice(), name: cap(k), sub: subs, category: "Kombipräparat", via: k, s: s + 3, key: "c" + nk });
      }
    });
    scored.sort(function (a, b) { return b.s - a.s; });
    var seen = {}, res = [];
    for (var i = 0; i < scored.length && res.length < limit; i++) {
      if (seen[scored[i].key]) continue;
      seen[scored[i].key] = 1; res.push(scored[i]);
    }
    return res;
  }

  // Menge ausgewählter Med-IDs -> Menge vorhandener Wirkstoffe
  function ingredientsOf(medIds) {
    var set = {};
    medIds.forEach(function (id) { var ing = ingredientOf(id); if (ing) set[ing] = true; });
    return set;
  }

  // ---- Paarweise Wechselwirkungen (Wirkstoff-Äquivalenz, dedupliziert) ------
  function interactionsFor(medIds) {
    var present = ingredientsOf(medIds);
    var seen = {}, out = [];
    for (var i = 0; i < DB.interactions.length; i++) {
      var it = DB.interactions[i];
      var a = ingredientOf(it.drugId1), b = ingredientOf(it.drugId2);
      if (!a || !b || a === b) continue;
      if (!present[a] || !present[b]) continue;
      var key = [a, b].sort().join("|") + "|" + (it.interactionTitle || "");
      if (seen[key]) continue; seen[key] = 1;
      out.push({
        kind: "interaction",
        severity: it.severity, sev: sev("interaction", it.severity),
        title: it.interactionTitle, description: it.interactionDescription,
        drug1: nameOfIngredient(a, it.drugId1), drug2: nameOfIngredient(b, it.drugId2)
      });
    }
    out.sort(function (a, b) { return b.sev.rank - a.sev.rank; });
    return out;
  }
  function nameOfIngredient(ing, fallbackId) {
    var ids = IDX.ingredientToIds[ing];
    if (ids && ids.length) return IDX.medById[ids[0]].name;
    var m = IDX.medById[fallbackId]; return m ? m.name : ing;
  }

  // ---- Mehrfach-Wechselwirkungen (Subset: alle geforderten Wirkstoffe da) ---
  function complexFor(medIds) {
    var present = ingredientsOf(medIds);
    var out = [];
    for (var i = 0; i < DB.complex.length; i++) {
      var c = DB.complex[i];
      var ids = String(c.drugIds || "").split(",").map(function (x) { return parseInt(x, 10); })
                 .filter(function (n) { return !isNaN(n); });
      if (!ids.length) continue;
      var all = ids.every(function (id) { var ing = ingredientOf(id); return ing && present[ing]; });
      if (!all) continue;
      out.push({
        kind: "complex",
        severity: c.severity, sev: sev("complex", c.severity),
        title: c.interactionTitle, description: c.interactionDescription,
        recommendation: c.recommendation, affectedSystems: c.affectedSystems,
        drugNames: c.drugNames, drugCount: c.drugCount
      });
    }
    out.sort(function (a, b) { return b.sev.rank - a.sev.rank; });
    return out;
  }

  // ---- Patientenrisiken (Zuordnung über medicationName, nicht über den FK) --
  // Wichtig: In der rekonstruierten DB ist risks.medicationId unbrauchbar
  // (kodiert die Kategorie, nicht das Präparat). Verlässlich ist risks.medicationName.
  // Wir lösen diesen Namen – inkl. Wirkstoffklassen wie „Fluorchinolone
  // (Ciprofloxacin, Levofloxacin)" und ASCII-Umschrift – gegen die gewählten
  // Medikamente auf. Kandidaten stammen ausschließlich aus dem Namen des Risikos
  // selbst, daher sind keine Falschzuordnungen möglich.
  function riskNameCandidates(rawName) {
    var out = [rawName];
    var noParen = String(rawName || "").replace(/\([^)]*\)/g, " ");
    out.push(noParen);
    noParen.split(/[\/,+]/).forEach(function (s) { out.push(s); }); // „A / B", „A, B"
    var re = /\(([^)]*)\)/g, mm;                                     // Klassen-Mitglieder in Klammern
    while ((mm = re.exec(String(rawName || "")))) {
      mm[1].split(/[\/,+]/).forEach(function (s) { out.push(s); });
    }
    var seen = {}, res = [];
    for (var i = 0; i < out.length; i++) {
      var f = fold(out[i]);
      if (f && !seen[f]) { seen[f] = 1; res.push(f); }
    }
    return res;
  }
  // activeCategories: Array von category-keys aus RISK_CATEGORIES (Profil)
  function risksFor(medIds, activeCategories) {
    if (!activeCategories || !activeCategories.length) return [];
    var catSet = {}; activeCategories.forEach(function (c) { catSet[c] = true; });
    // gewählte Wirkstoffe (gefaltet) -> repräsentatives Med für die Anzeige
    var presentIng = {}, selByIng = {};
    (medIds || []).forEach(function (id) {
      var m = medById(id); if (!m) return;
      var fi = fold(m.activeIngredient);
      presentIng[fi] = true;
      if (!selByIng[fi]) selByIng[fi] = m;
    });
    var out = [], seen = {};
    for (var i = 0; i < DB.risks.length; i++) {
      var r = DB.risks[i];
      if (!catSet[r.category]) continue;
      var cands = riskNameCandidates(r.medicationName || "");
      var hitIng = null;
      for (var ci = 0; ci < cands.length; ci++) {
        var ing = IDX.foldResolve[cands[ci]];
        if (ing && presentIng[ing]) { hitIng = ing; break; }
      }
      if (!hitIng) continue;                 // Risiko betrifft keines der gewählten Präparate
      var selMed = selByIng[hitIng];
      var key = (selMed ? selMed.id : hitIng) + "|" + r.category + "|" + (r.riskTitle || "");
      if (seen[key]) continue; seen[key] = 1;
      out.push({
        kind: "risk",
        severity: r.severity, sev: sev("risk", r.severity),
        category: r.category, categoryLabel: r.categoryLabel,
        title: r.riskTitle, riskCondition: r.riskCondition,
        description: r.description, recommendation: r.recommendation,
        medName: selMed ? selMed.name : r.medicationName,
        ingredient: selMed ? selMed.activeIngredient : ""
      });
    }
    out.sort(function (a, b) { return b.sev.rank - a.sev.rank; });
    return out;
  }

  // ---- Voll-Analyse in einem Aufruf ----------------------------------------
  function analyze(medIds, activeCategories) {
    return {
      interactions: interactionsFor(medIds),
      complex: complexFor(medIds),
      risks: risksFor(medIds, activeCategories || [])
    };
  }

  // ---- PZN (Pharmazentralnummer) --------------------------------------------
  // Deterministische, komplett offline PZN-Verarbeitung. WICHTIG: bewusst KEINE
  // Zuordnung PZN -> Präparat – dafür gibt es kein lizenzfreies Register, und
  // eine erfundene Zuordnung wäre ein Sicherheitsrisiko (falsches Medikament).
  // Hier nur: Prüfziffer validieren + PZN aus Barcode-/Data-Matrix-Rohtext
  // extrahieren. Die Zuordnung zu einem Präparat passiert ausschließlich
  // gerätelokal durch die Nutzerin (siehe ms-app.js, ms.pzn-Map).
  //
  // PZN-8 (aktueller Standard): 7 Datenziffern + 1 Prüfziffer.
  // Prüfziffer = (Σ ziffer_i · i, i = 1..7) mod 11 ; Ergebnis 10 => ungültig.
  function pad8(s) { s = String(s == null ? "" : s).replace(/\D/g, ""); return s.length === 7 ? "0" + s : s; }
  function pznCheck(raw) {
    var s = String(raw == null ? "" : raw).replace(/\D/g, "");
    if (s.length === 7) s = "0" + s;           // führende Null (PZN-7-Schreibweise)
    if (s.length !== 8) return false;
    var sum = 0;
    for (var i = 0; i < 7; i++) sum += (i + 1) * (s.charCodeAt(i) - 48);
    var c = sum % 11;
    if (c === 10) return false;
    return c === (s.charCodeAt(7) - 48);
  }
  // Findet eine prüfziffer-gültige PZN in beliebigem Barcode-/DataMatrix-/OCR-Text.
  // Reihenfolge: (1) ausgezeichnete „PZN …", (2) deutsche Pharma-GTIN (Präfix 4150),
  // (3) irgendeine Ziffernfolge (Länge 8, dann 7) mit gültiger PZN-Prüfziffer.
  function pznParse(raw) {
    var text = String(raw == null ? "" : raw);
    var lab = text.match(/PZN[\s.:\-]*?(\d[\d\s]{5,8}\d)/i);          // (1)
    if (lab) { var p = lab[1].replace(/\s/g, ""); if (pznCheck(p)) return { pzn: pad8(p), valid: true, source: "label" }; }
    var g = text.replace(/\D/g, "").match(/4150(\d{8})/);            // (2)
    if (g && pznCheck(g[1])) return { pzn: pad8(g[1]), valid: true, source: "gtin" };
    var runs = text.match(/\d{7,}/g) || [];                          // (3)
    for (var len = 8; len >= 7; len--) {
      for (var r = 0; r < runs.length; r++) {
        var run = runs[r];
        for (var k = 0; k + len <= run.length; k++) {
          var cand = run.substr(k, len);
          if (pznCheck(cand)) return { pzn: pad8(cand), valid: true, source: "checksum" };
        }
      }
    }
    return null;
  }

  // ---- Kalender-Export (.ics) für Einnahme-Erinnerungen ---------------------
  // Erzeugt eine RFC-5545-Kalenderdatei mit täglich wiederkehrenden Terminen
  // (ein VEVENT je Einnahmezeit, VALARM zur Einnahmezeit). So kommen die
  // Erinnerungen zuverlässig aus dem echten Kalender des Nutzers – vollständig
  // offline, ohne Server, ohne dass Daten das Gerät verlassen. Reine
  // Text-Erzeugung; keine erfundenen klinischen Daten.
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function icsEscape(s) {                      // RFC 5545 TEXT-Escaping
    return String(s == null ? "" : s)
      .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
      .replace(/\r?\n/g, "\\n");
  }
  function icsFold(line) {                      // ~75-Zeichen-Faltung (CRLF + Space)
    if (line.length <= 74) return line;
    var out = line.substr(0, 74), i = 74;
    while (i < line.length) { out += "\r\n " + line.substr(i, 73); i += 73; }
    return out;
  }
  function validTime(str) {                     // "8:5"->null, "08:05"->"08:05", "24:00"->null
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(str == null ? "" : str).trim());
    if (!m) return null;
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return pad2(h) + ":" + pad2(mi);
  }
  function stampUTC(d) {
    return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + "T" +
      pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + "Z";
  }
  function localDay(d) { return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()); }

  // plan: {id, name, times:[...]}; medNames: [String]; now: Date (Testbarkeit)
  function buildICS(plan, medNames, now) {
    now = now || new Date();
    var times = [];
    ((plan && plan.times) || []).forEach(function (t) {
      var v = validTime(t); if (v && times.indexOf(v) === -1) times.push(v);
    });
    times.sort();
    if (!times.length) return null;
    var domain = "mediscan.vaydena.de";
    var name = (plan && plan.name) ? String(plan.name) : "Medikationsplan";
    var meds = (medNames || []).filter(Boolean);
    var descPlain = (meds.length ? meds.join(", ") : "Medikamente laut Plan") +
      "\nMediScan-Erinnerung. Kein Ersatz für ärztliche oder pharmazeutische Beratung.";
    var uidBase = (plan && plan.id ? plan.id : "plan") + "-" + localDay(now);
    var day = localDay(now), stamp = stampUTC(now);
    var L = [
      "BEGIN:VCALENDAR", "VERSION:2.0",
      "PRODID:-//MediScan//Medikationsplan//DE", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"
    ];
    times.forEach(function (t) {
      var hms = t.replace(":", "") + "00";       // HHMMSS (floating local time)
      L.push("BEGIN:VEVENT");
      L.push("UID:" + uidBase + "-" + t.replace(":", "") + "@" + domain);
      L.push("DTSTAMP:" + stamp);
      L.push("DTSTART:" + day + "T" + hms);
      L.push("DURATION:PT5M");
      L.push("RRULE:FREQ=DAILY");
      L.push(icsFold("SUMMARY:" + icsEscape("Medikamente einnehmen – " + name + " (" + t + ")")));
      L.push(icsFold("DESCRIPTION:" + icsEscape(descPlain)));
      L.push("BEGIN:VALARM");
      L.push("ACTION:DISPLAY");
      L.push("TRIGGER:PT0M");
      L.push(icsFold("DESCRIPTION:" + icsEscape("Medikamente einnehmen – " + name)));
      L.push("END:VALARM");
      L.push("END:VEVENT");
    });
    L.push("END:VCALENDAR");
    return L.join("\r\n") + "\r\n";
  }

  return {
    load: load, meta: meta, medById: medById,
    detect: detect, search: search,
    interactionsFor: interactionsFor, complexFor: complexFor, risksFor: risksFor,
    analyze: analyze, sev: sev, norm: norm,
    pzn: { parse: pznParse, check: pznCheck, pad8: pad8 },
    ics: { build: buildICS, escape: icsEscape, fold: icsFold, validTime: validTime },
    RISK_CATEGORIES: RISK_CATEGORIES
  };
})();
