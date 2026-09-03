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
    // validierte Handelsnamen -> Wirkstoff -> alle Med-IDs dieses Wirkstoffs
    var syn = DB.synonyms || {};
    Object.keys(syn).forEach(function (k) {
      var ingN = norm(syn[k]);
      var ids = ingredientToIds[ingN];
      if (!ids || !ids.length) return;
      terms.push({ t: norm(k), medId: ids[0], ing: ingN, syn: true });
      foldResolve[fold(k)] = fold(syn[k]);   // Handelsname -> Wirkstoff (gefaltet)
    });

    IDX = { medById: medById, ingredientToIds: ingredientToIds, terms: terms, foldResolve: foldResolve };
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
    // Tokens für Fuzzy
    var rawTokens = full.split(" ").filter(function (w) { return w.length >= 3; });
    var tokens = Array.from(new Set(rawTokens));
    var bestByIng = {};   // ing -> {medId,term,score,syn}

    for (var i = 0; i < IDX.terms.length; i++) {
      var term = IDX.terms[i];
      var t = term.t, score = 0;
      // 1) Substring des Gesamttextes (stark)
      if (t.length >= 4 && full.indexOf(t) !== -1) {
        score = 100 + t.length;
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
          bestByIng[term.ing] = { medId: term.medId, term: t, score: score, syn: !!term.syn };
        }
      }
    }

    var out = [];
    Object.keys(bestByIng).forEach(function (ing) {
      var b = bestByIng[ing];
      var m = IDX.medById[b.medId];
      if (!m) return;
      out.push({
        medId: m.id, name: m.name, ingredient: m.activeIngredient,
        category: m.category, term: b.term, score: b.score, syn: b.syn
      });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }

  // ---- Autocomplete-Suche (manuelles Hinzufügen) ----------------------------
  function search(query, limit) {
    if (!IDX) return [];
    var q = norm(query);
    if (q.length < 2) return [];
    limit = limit || 12;
    var scored = [];
    for (var id in IDX.medById) {
      var m = IDX.medById[id];
      var nName = norm(m.name), nIng = norm(m.activeIngredient);
      var s = 0;
      if (nName === q || nIng === q) s = 100;
      else if (nName.indexOf(q) === 0 || nIng.indexOf(q) === 0) s = 80;
      else if (nName.indexOf(q) !== -1 || nIng.indexOf(q) !== -1) s = 60;
      if (s > 0) scored.push({ med: m, s: s });
    }
    // Handelsnamen-Treffer
    var syn = DB.synonyms || {};
    Object.keys(syn).forEach(function (k) {
      if (norm(k).indexOf(q) === 0) {
        var ids = IDX.ingredientToIds[norm(syn[k])];
        if (ids && ids[0]) scored.push({ med: IDX.medById[ids[0]], s: 70, via: k });
      }
    });
    scored.sort(function (a, b) { return b.s - a.s; });
    var seen = {}, res = [];
    for (var i = 0; i < scored.length && res.length < limit; i++) {
      if (seen[scored[i].med.id]) continue;
      seen[scored[i].med.id] = 1; res.push(scored[i].med);
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

  return {
    load: load, meta: meta, medById: medById,
    detect: detect, search: search,
    interactionsFor: interactionsFor, complexFor: complexFor, risksFor: risksFor,
    analyze: analyze, sev: sev, norm: norm,
    RISK_CATEGORIES: RISK_CATEGORIES
  };
})();
