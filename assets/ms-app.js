/* MediScan – UI-Controller (framework-frei).
 * Verdrahtet app.html mit window.MediScan (Engine) + jsPDF-Bericht + Tesseract-OCR.
 * Speichert Auswahl/Profil lokal (localStorage). Keine erfundenen klinischen Daten.
 */
(function () {
  "use strict";
  var MS = window.MediScan;
  var DB_URL = "assets/data/mediscan-db.json";
  var LS_SEL = "ms.sel", LS_PROF = "ms.profile", LS_PZN = "ms.pzn";
  var TESS_CDN = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  var ZXING_CDN = "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js";

  // ---- kleine Helfer --------------------------------------------------------
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function lsGet(k, def) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  var toastT = null;
  function toast(msg) {
    var t = el("ms-toast");
    if (!t) { t = document.createElement("div"); t.id = "ms-toast"; t.className = "toast"; document.body.appendChild(t); }
    t.textContent = msg; t.style.opacity = "1";
    clearTimeout(toastT); toastT = setTimeout(function () { t.style.transition = "opacity .4s"; t.style.opacity = "0"; }, 2600);
  }

  // ---- Zustand --------------------------------------------------------------
  var selected = [];          // Med-IDs (Zahlen)
  var profile = [];           // category-keys
  var resultsShown = false;
  var ready = false;
  var pznMap = {};            // gerätelokal gelernt: PZN(String) -> [medId,…]
  var pendingPZN = null;      // erkannte, noch nicht zugeordnete PZN

  // ---- Auswahl ---------------------------------------------------------------
  // Fügt eine Menge Med-IDs hinzu (ein Kombipräparat liefert mehrere).
  function addByIds(ids) {
    if (!ids || !ids.length) return;
    var valid = [], added = 0, dup = 0;
    ids.forEach(function (raw) {
      var id = parseInt(raw, 10);
      if (isNaN(id) || !MS.medById(id)) return;
      valid.push(id);
      if (selected.indexOf(id) !== -1) { dup++; return; }
      selected.push(id); added++;
    });
    if (added) { lsSet(LS_SEL, selected); renderChips(); maybeRerun(); }
    // Wartet eine erkannte PZN auf Zuordnung? -> gerätelokal mit dieser Wahl merken.
    if (pendingPZN && valid.length) {
      linkPZN(pendingPZN, valid);
      var nm = valid.map(function (id) { return MS.medById(id).name; }).join(" + ");
      var learned = pendingPZN; pendingPZN = null; renderPending();
      toast("PZN " + learned + " ↔ " + nm + " gemerkt (nur auf diesem Gerät).");
      return;
    }
    if (added > 1) toast(added + " Wirkstoffe hinzugefügt (Kombipräparat).");
    else if (!added && dup) toast("Bereits in der Liste.");
  }
  function addById(id) { addByIds([id]); }

  // ---- PZN: gerätelokale Zuordnung (kein Register, keine erfundenen Daten) ----
  function linkPZN(pzn, ids) {
    var valid = (ids || []).map(function (x) { return parseInt(x, 10); })
      .filter(function (id) { return !isNaN(id) && MS.medById(id); });
    if (!pzn || !valid.length) return;
    pznMap[pzn] = valid; lsSet(LS_PZN, pznMap);
  }
  function renderPending() {
    var b = el("pznPending");
    if (!b) return;
    if (!pendingPZN) { b.hidden = true; b.innerHTML = ""; return; }
    b.hidden = false;
    b.innerHTML = '<div class="pzn-txt"><b>PZN ' + esc(pendingPZN) + '</b> erkannt – dieser Nummer ist noch ' +
      'kein Präparat zugeordnet. Suchen Sie unten das passende Präparat und tippen Sie es an; ' +
      'die Zuordnung wird <b>nur auf diesem Gerät</b> gespeichert.</div>' +
      '<button type="button" class="btn ghost small" id="pznCancel">Verwerfen</button>';
    var c = el("pznCancel"); if (c) c.onclick = function () { pendingPZN = null; renderPending(); };
  }
  // Zentraler Einstieg: roher Barcode-/Eingabetext -> PZN -> auto-add oder Zuordnungswunsch.
  function handlePZN(rawText) {
    var r = MS.pzn.parse(rawText);
    if (!r) { toast("Keine gültige PZN erkannt. Bitte 8-stellige PZN prüfen."); return false; }
    var pzn = r.pzn;
    var known = pznMap[pzn];
    if (known && known.length && known.some(function (id) { return MS.medById(id); })) {
      pendingPZN = null; renderPending();
      addByIds(known);
      var nm = known.map(function (id) { var m = MS.medById(id); return m ? m.name : null; })
        .filter(Boolean).join(" + ");
      toast("PZN " + pzn + " erkannt → " + nm + ".");
      setTab("manual");
      return true;
    }
    pendingPZN = pzn; renderPending();
    setTab("manual");
    setTimeout(function () { var q = el("q"); if (q) q.focus(); }, 40);
    return true;
  }
  function removeId(id) {
    id = parseInt(id, 10);
    selected = selected.filter(function (x) { return x !== id; });
    lsSet(LS_SEL, selected); renderChips(); maybeRerun();
  }
  function clearSel() {
    selected = []; lsSet(LS_SEL, selected); renderChips();
    resultsShown = false; el("results").hidden = true; el("results").innerHTML = "";
  }
  function renderChips() {
    var card = el("selCard"), chips = el("chips"), n = el("selN");
    n.textContent = selected.length;
    if (!selected.length) { card.hidden = true; chips.innerHTML = ""; return; }
    card.hidden = false;
    chips.innerHTML = selected.map(function (id) {
      var m = MS.medById(id); if (!m) return "";
      return '<span class="chip">' + esc(m.name) +
        '<small>' + esc(m.activeIngredient) + '</small>' +
        '<button class="x" data-id="' + id + '" aria-label="Entfernen">×</button></span>';
    }).join("");
  }

  // ---- Manuelle Suche + Autocomplete ----------------------------------------
  var acItems = [], acActive = -1;
  function renderAC(list) {
    var ac = el("ac");
    acItems = list; acActive = list.length ? 0 : -1;
    if (!list.length) { ac.hidden = true; ac.innerHTML = ""; return; }
    ac.innerHTML = list.map(function (p, i) {
      var combo = p.ids && p.ids.length > 1;
      var tag = combo ? ' <span class="ac-combo">Kombi</span>' : '';
      return '<button type="button" data-idx="' + i + '" class="' + (i === 0 ? "active" : "") + '">' +
        '<div>' + esc(p.name) + tag + '</div>' +
        '<div class="ing">' + esc(p.sub) + (p.category ? " · " + esc(p.category) : "") + '</div></button>';
    }).join("");
    ac.hidden = false;
  }
  function closeAC() { var ac = el("ac"); ac.hidden = true; ac.innerHTML = ""; acItems = []; acActive = -1; }
  function moveAC(d) {
    if (!acItems.length) return;
    acActive = (acActive + d + acItems.length) % acItems.length;
    var btns = el("ac").querySelectorAll("button");
    btns.forEach(function (b, i) { b.classList.toggle("active", i === acActive); });
    if (btns[acActive]) btns[acActive].scrollIntoView({ block: "nearest" });
  }
  function commitAC() {
    var p = (acActive >= 0 && acItems[acActive]) ? acItems[acActive] : acItems[0];
    if (p) addByIds(p.ids);
    el("q").value = ""; closeAC();
  }

  // ---- Patientenprofil -------------------------------------------------------
  function renderToggles() {
    el("toggles").innerHTML = MS.RISK_CATEGORIES.map(function (c) {
      var on = profile.indexOf(c.key) !== -1;
      return '<button type="button" class="toggle" data-key="' + c.key + '" aria-pressed="' + on + '">' +
        '<span class="dot"></span>' + esc(c.label) + '</button>';
    }).join("");
  }
  function toggleProfile(key) {
    var i = profile.indexOf(key);
    if (i === -1) profile.push(key); else profile.splice(i, 1);
    lsSet(LS_PROF, profile); renderToggles(); maybeRerun();
  }

  // ---- OCR (Tesseract, faul geladen) ----------------------------------------
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = TESS_CDN; s.async = true;
      s.onload = res; s.onerror = function () { rej(new Error("CDN")); };
      document.head.appendChild(s);
    });
  }
  function showOCR(on) { el("ocrbox").hidden = !on; }
  function setBar(pct, msg) { el("ocrbar").style.width = pct + "%"; if (msg) el("ocrmsg").textContent = msg; }

  async function runOCR(file) {
    var thumb = el("thumb");
    try { thumb.src = URL.createObjectURL(file); thumb.hidden = false; } catch (e) {}
    showOCR(true); setBar(3, "Sprachpaket wird geladen …");
    var worker = null;
    try {
      await loadTesseract();
      setBar(8, "Texterkennung startet …");
      worker = await window.Tesseract.createWorker("deu", 1, {
        logger: function (m) {
          if (m.status === "recognizing text") setBar(10 + Math.round(m.progress * 88), "Text wird erkannt … " + Math.round(m.progress * 100) + "%");
        }
      });
      var out = await worker.recognize(file);
      await worker.terminate(); worker = null;
      setBar(100, "Abgleich mit Datenbank …");
      var text = (out && out.data && out.data.text) || "";
      var found = MS.detect(text);
      var toAdd = [];
      found.forEach(function (f) {
        (f.ids && f.ids.length ? f.ids : [f.medId]).forEach(function (id) { if (toAdd.indexOf(id) === -1) toAdd.push(id); });
      });
      var added = 0;
      toAdd.forEach(function (id) { if (selected.indexOf(id) === -1 && MS.medById(id)) { selected.push(id); added++; } });
      if (added) { lsSet(LS_SEL, selected); renderChips(); maybeRerun(); }
      setTimeout(function () { showOCR(false); }, 700);
      if (added) toast(added + " Medikament" + (added > 1 ? "e" : "") + " erkannt und hinzugefügt.");
      else if (found.length) toast("Erkannte Medikamente sind bereits in der Liste.");
      else toast("Kein bekanntes Medikament erkannt – bitte über die Suche hinzufügen.");
      // zurück zur manuellen Ansicht, damit man prüfen/ergänzen kann
      setTab("manual");
    } catch (e) {
      if (worker) { try { await worker.terminate(); } catch (x) {} }
      showOCR(false);
      toast("Texterkennung nicht möglich (Internet nötig). Bitte die Suche nutzen.");
    }
  }

  // ---- Live-Kamera-Scan (Barcode / PZN / Data-Matrix) -----------------------
  // Bevorzugt die native BarcodeDetector-API (Android-Chrome/Edge), fällt sonst
  // auf ZXing (lazy per CDN, nur online) zurück. Das Kamerabild wird ausschließlich
  // auf dem Gerät verarbeitet – kein Upload.
  var scanStream = null, scanRAF = null, scanDetector = null, scanReader = null, scanning = false;

  function loadZXing() {
    if (window.ZXing) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = ZXING_CDN; s.async = true;
      s.onload = res; s.onerror = function () { rej(new Error("CDN")); };
      document.head.appendChild(s);
    });
  }
  function onScanHit(r) {
    stopScan();
    try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) {}
    handlePZN("PZN " + r.pzn);
  }
  async function startScan() {
    if (scanning) return;
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      toast("Kamera wird von diesem Browser nicht unterstützt. Bitte PZN manuell eingeben."); return;
    }
    scanning = true;
    el("scanStart").hidden = true; el("scanview").hidden = false;
    var native = ("BarcodeDetector" in window);
    if (native) {
      try {
        scanDetector = new window.BarcodeDetector({
          formats: ["code_39", "ean_13", "ean_8", "data_matrix", "code_128", "itf", "qr_code"]
        });
      } catch (e) { scanDetector = null; native = false; }
    }
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    } catch (e) {
      scanning = false; el("scanview").hidden = true; el("scanStart").hidden = false;
      toast("Kamerazugriff nicht möglich. Bitte erlauben oder PZN manuell eingeben."); return;
    }
    var vid = el("scanvid");
    vid.srcObject = scanStream; try { await vid.play(); } catch (e) {}
    if (scanDetector) scanLoopNative();
    else scanLoopZXing();
  }
  function scanLoopNative() {
    var vid = el("scanvid");
    var tick = function () {
      if (!scanning) return;
      scanDetector.detect(vid).then(function (codes) {
        if (!scanning) return;
        for (var i = 0; codes && i < codes.length; i++) {
          var r = MS.pzn.parse(codes[i].rawValue || "");
          if (r) { onScanHit(r); return; }
        }
        scanRAF = requestAnimationFrame(tick);
      }).catch(function () { if (scanning) scanRAF = requestAnimationFrame(tick); });
    };
    scanRAF = requestAnimationFrame(tick);
  }
  async function scanLoopZXing() {
    try { await loadZXing(); }
    catch (e) { stopScan(); toast("Barcode-Scanner konnte nicht geladen werden (Internet nötig). Bitte PZN manuell eingeben."); return; }
    try {
      var Z = window.ZXing;
      scanReader = new Z.BrowserMultiFormatReader();
      scanReader.decodeFromVideoElement(el("scanvid"), function (result) {
        if (result && scanning) { var r = MS.pzn.parse(result.getText ? result.getText() : String(result)); if (r) onScanHit(r); }
      });
    } catch (e) { stopScan(); toast("Scanner-Fehler. Bitte PZN manuell eingeben."); }
  }
  function stopScan() {
    scanning = false;
    if (scanRAF) { cancelAnimationFrame(scanRAF); scanRAF = null; }
    if (scanReader) { try { scanReader.reset(); } catch (e) {} scanReader = null; }
    if (scanStream) { try { scanStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} scanStream = null; }
    var vid = el("scanvid"); if (vid) { try { vid.pause(); vid.srcObject = null; } catch (e) {} }
    scanDetector = null;
    var v = el("scanview"), b = el("scanStart");
    if (v) v.hidden = true; if (b) b.hidden = false;
  }

  // ---- Tabs -----------------------------------------------------------------
  function setTab(which) {
    var man = which === "manual";
    el("tab-manual").setAttribute("aria-selected", man);
    el("tab-scan").setAttribute("aria-selected", !man);
    el("pane-manual").hidden = !man;
    el("pane-scan").hidden = man;
    if (man) { stopScan(); setTimeout(function () { el("q").focus(); }, 30); }
  }

  // ---- Analyse + Ergebnis-Rendering -----------------------------------------
  function maybeRerun() { if (resultsShown && selected.length) analyze(); else if (resultsShown && !selected.length) { el("results").hidden = true; resultsShown = false; } }

  function analyze() {
    if (!ready) { toast("Datenbank lädt noch …"); return; }
    if (!selected.length) { toast("Bitte zuerst Medikamente hinzufügen."); return; }
    var r = MS.analyze(selected, profile);
    renderResults(r);
    resultsShown = true;
    var res = el("results");
    res.hidden = false;
    res.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function card(sevObj, title, o) {
    var cls = "sev" + (sevObj.rank || 0);
    var h = '<div class="res ' + cls + '">';
    h += '<div class="head"><div class="ttl">' + esc(title) + '</div>';
    h += '<span class="badge">' + esc(sevObj.label) + '</span></div>';
    if (o.pair) h += '<div class="pair">' + o.pair + '</div>';
    if (o.medtags) h += '<div class="medtags">' + o.medtags + '</div>';
    if (o.desc) h += '<div class="desc">' + esc(o.desc) + '</div>';
    if (o.sys) h += '<div class="sys">Betroffene Systeme: ' + esc(o.sys) + '</div>';
    if (o.rec) h += '<div class="rec"><b>Empfehlung:</b> ' + esc(o.rec) + '</div>';
    h += '</div>';
    return h;
  }
  function splitNames(s) { return String(s || "").split(/\s*[,;+/]\s*/).filter(Boolean); }

  function renderResults(r) {
    var iN = r.interactions.length, cN = r.complex.length, rN = r.risks.length;
    var worst = 0;
    r.interactions.concat(r.complex, r.risks).forEach(function (x) { if (x.sev.rank > worst) worst = x.sev.rank; });

    var h = '<div class="card">';
    h += '<h2>Ergebnis <button class="btn ghost small" id="pdfBtn" style="margin-left:auto;padding:8px 12px">⬇ PDF-Bericht</button></h2>';
    h += '<div class="stats">' +
      stat(selected.length, "Medikamente") +
      stat(iN, "Wechselwirkungen") +
      stat(cN, "Mehrfach") +
      stat(rN, "Risiken") + '</div>';

    if (iN + cN + rN === 0) {
      h += '<div class="ok-note" style="margin-top:12px">✓ In der hinterlegten Datenbank wurden keine Wechselwirkungen oder Risiken zu dieser Kombination gefunden. Das ist <u>keine</u> Garantie der Unbedenklichkeit – besprechen Sie Ihre Medikation mit Arzt/Apotheke.</div>';
    }
    h += '</div>';

    if (iN) {
      h += '<div class="card"><h2>Wechselwirkungen <span class="n">' + iN + '</span></h2>';
      r.interactions.forEach(function (it) {
        h += card(it.sev, it.title, {
          pair: esc(it.drug1) + '<span class="arrow">+</span>' + esc(it.drug2),
          desc: it.description
        });
      });
      h += '</div>';
    }
    if (cN) {
      h += '<div class="card"><h2>Mehrfach-Wechselwirkungen <span class="n">' + cN + '</span></h2>';
      r.complex.forEach(function (c) {
        var tags = splitNames(c.drugNames).map(function (nm) { return '<span class="medtag">' + esc(nm) + '</span>'; }).join("");
        h += card(c.sev, c.title, { medtags: tags, desc: c.description, sys: c.affectedSystems, rec: c.recommendation });
      });
      h += '</div>';
    }
    if (rN) {
      h += '<div class="card"><h2>Individuelle Patientenrisiken <span class="n">' + rN + '</span></h2>';
      r.risks.forEach(function (rk) {
        var pair = '<b>' + esc(rk.medName) + '</b>' + (rk.categoryLabel ? ' <span class="arrow">·</span>' + esc(rk.categoryLabel) : "");
        var desc = rk.riskCondition ? (rk.riskCondition + " – " + (rk.description || "")) : rk.description;
        h += card(rk.sev, rk.title, { pair: pair, desc: desc, rec: rk.recommendation });
      });
      h += '</div>';
    }

    h += '<div class="disclaimer" role="note" style="margin-top:6px"><b>⚠ Hinweis:</b> Diese Auswertung basiert auf einer hinterlegten Referenzdatenbank und ersetzt keine ärztliche oder pharmazeutische Beratung. Angaben können unvollständig sein.</div>';

    el("results").innerHTML = h;
    var pdf = el("pdfBtn"); if (pdf) pdf.onclick = function () { makePDF(r); };
  }
  function stat(n, label) { return '<div class="stat"><b>' + n + '</b><span>' + esc(label) + '</span></div>'; }

  // ---- PDF-Bericht (jsPDF, WinAnsi-sicher) ----------------------------------
  function pdfSafe(s) {
    return String(s == null ? "" : s)
      .replace(/≥/g, ">=").replace(/≤/g, "<=")
      .replace(/[→↔⟷⟶⇄]/g, "->")
      .replace(/[⚠⬇]/g, "").replace(/ /g, " ")
      .replace(/[^\x00-\xFF]/g, "");
  }
  var SEVRGB = { 0: [117, 117, 117], 1: [56, 142, 60], 2: [245, 124, 0], 3: [229, 57, 53], 4: [183, 28, 28] };
  function makePDF(r) {
    if (!window.jspdf || !window.jspdf.jsPDF) { toast("PDF-Bibliothek nicht geladen."); return; }
    var doc = new window.jspdf.jsPDF({ unit: "pt", format: "a4" });
    var PW = doc.internal.pageSize.getWidth(), PH = doc.internal.pageSize.getHeight();
    var M = 40, CW = PW - 2 * M, y = 0, page = 1;

    function foot() {
      doc.setFontSize(7.5); doc.setTextColor(150);
      doc.text("MediScan – Informationswerkzeug, kein Ersatz für ärztliche Beratung.", M, PH - 24);
      doc.text("Seite " + page, PW - M, PH - 24, { align: "right" });
    }
    function newPage() { foot(); doc.addPage(); page++; y = M; }
    function ensure(hh) { if (y + hh > PH - 40) newPage(); }
    function line(txt, size, style, rgb, gap) {
      doc.setFont("helvetica", style || "normal"); doc.setFontSize(size);
      doc.setTextColor(rgb ? rgb[0] : 40, rgb ? rgb[1] : 40, rgb ? rgb[2] : 40);
      var parts = doc.splitTextToSize(pdfSafe(txt), CW);
      for (var i = 0; i < parts.length; i++) { ensure(size + 3); doc.text(parts[i], M, y + size); y += size + 3; }
      if (gap) y += gap;
    }

    // Kopf
    doc.setFillColor(0, 105, 92); doc.rect(0, 0, PW, 84, "F");
    doc.setTextColor(255); doc.setFont("helvetica", "bold"); doc.setFontSize(20);
    doc.text("MediScan", M, 40);
    doc.setFont("helvetica", "normal"); doc.setFontSize(12);
    doc.text("Wechselwirkungs-Analyse", M, 60);
    var now = new Date();
    var ds = pad(now.getDate()) + "." + pad(now.getMonth() + 1) + "." + now.getFullYear() + " " + pad(now.getHours()) + ":" + pad(now.getMinutes());
    doc.setFontSize(9); doc.text("Erstellt am " + ds, PW - M, 40, { align: "right" });
    y = 104;

    // Medikamente
    line("Analysierte Medikamente (" + selected.length + ")", 12, "bold", [0, 77, 64], 2);
    selected.forEach(function (id) { var m = MS.medById(id); if (m) line("• " + m.name + "  (" + m.activeIngredient + ")", 10, "normal", [40, 40, 40]); });
    if (profile.length) {
      var labs = profile.map(function (k) { var c = MS.RISK_CATEGORIES.filter(function (x) { return x.key === k; })[0]; return c ? c.label : k; });
      y += 4; line("Patientenprofil: " + labs.join(", "), 10, "italic", [90, 90, 90]);
    }
    y += 6;

    function section(title, items, render) {
      if (!items.length) return;
      ensure(30);
      doc.setDrawColor(219, 232, 230); doc.line(M, y, M + CW, y); y += 12;
      line(title + " (" + items.length + ")", 13, "bold", [0, 77, 64], 4);
      items.forEach(render);
      y += 4;
    }
    function block(sevObj, title, pairTxt, descTxt, recTxt, sysTxt) {
      var rgb = SEVRGB[sevObj.rank || 0];
      ensure(46);
      var top = y;
      // Farbbalken links
      doc.setFillColor(rgb[0], rgb[1], rgb[2]); doc.rect(M, y + 1, 3.5, 12, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(30, 30, 30);
      var tParts = doc.splitTextToSize(pdfSafe(title), CW - 90);
      doc.text(tParts, M + 10, y + 11);
      // Badge rechts
      doc.setFontSize(8); doc.setTextColor(rgb[0], rgb[1], rgb[2]);
      doc.text(pdfSafe(sevObj.label.toUpperCase()), M + CW, y + 11, { align: "right" });
      y += tParts.length * 13 + 3;
      if (pairTxt) line(pairTxt, 9.5, "bold", [0, 77, 64]);
      if (descTxt) line(descTxt, 9.5, "normal", [51, 64, 62]);
      if (sysTxt) line("Betroffene Systeme: " + sysTxt, 8.5, "italic", [110, 110, 110]);
      if (recTxt) line("Empfehlung: " + recTxt, 9.5, "normal", [0, 90, 80]);
      y += 8;
      // dünne Trennlinie
      doc.setDrawColor(235, 242, 240); ensure(2); doc.line(M + 10, y - 4, M + CW, y - 4);
    }

    section("Wechselwirkungen", r.interactions, function (it) {
      block(it.sev, it.title, it.drug1 + " + " + it.drug2, it.description, null, null);
    });
    section("Mehrfach-Wechselwirkungen", r.complex, function (c) {
      block(c.sev, c.title, splitNames(c.drugNames).join(" + "), c.description, c.recommendation, c.affectedSystems);
    });
    section("Individuelle Patientenrisiken", r.risks, function (rk) {
      var pair = rk.medName + (rk.categoryLabel ? " (" + rk.categoryLabel + ")" : "");
      var desc = rk.riskCondition ? (rk.riskCondition + " - " + (rk.description || "")) : rk.description;
      block(rk.sev, rk.title, pair, desc, rk.recommendation, null);
    });

    if (r.interactions.length + r.complex.length + r.risks.length === 0) {
      line("In der hinterlegten Datenbank wurden keine Wechselwirkungen oder Risiken zu dieser Kombination gefunden. Dies ist keine Garantie der Unbedenklichkeit.", 10, "normal", [40, 40, 40], 6);
    }

    ensure(60);
    doc.setFillColor(255, 248, 225); doc.setDrawColor(255, 224, 130);
    doc.roundedRect(M, y, CW, 44, 6, 6, "FD");
    doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(140, 90, 0);
    doc.text("Wichtiger Hinweis", M + 12, y + 16);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(90, 70, 20);
    doc.text(doc.splitTextToSize("MediScan dient ausschließlich der Information und ersetzt keine ärztliche oder pharmazeutische Beratung. Treffen Sie keine Therapieentscheidung allein aufgrund dieses Berichts.", CW - 24), M + 12, y + 30);
    y += 52;
    foot();

    var fn = "MediScan_Analyse_" + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + "_" + pad(now.getHours()) + pad(now.getMinutes()) + ".pdf";
    doc.save(fn);
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  // ---- Verdrahtung ----------------------------------------------------------
  function wire() {
    el("tab-manual").addEventListener("click", function () { setTab("manual"); });
    el("tab-scan").addEventListener("click", function () { setTab("scan"); });

    var q = el("q");
    q.addEventListener("input", function () { renderAC(MS.search(q.value, 12)); });
    q.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); moveAC(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveAC(-1); }
      else if (e.key === "Enter") { e.preventDefault(); if (acItems.length) commitAC(); }
      else if (e.key === "Escape") { closeAC(); }
    });
    el("ac").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-idx]");
      if (b) { var p = acItems[parseInt(b.getAttribute("data-idx"), 10)]; if (p) addByIds(p.ids); q.value = ""; closeAC(); q.focus(); }
    });
    document.addEventListener("click", function (e) {
      if (!el("ac").hidden && !e.target.closest("#pane-manual .field")) closeAC();
    });

    el("chips").addEventListener("click", function (e) {
      var b = e.target.closest("button.x[data-id]"); if (b) removeId(b.getAttribute("data-id"));
    });
    el("clearBtn").addEventListener("click", clearSel);

    el("toggles").addEventListener("click", function (e) {
      var b = e.target.closest("button.toggle[data-key]"); if (b) toggleProfile(b.getAttribute("data-key"));
    });

    el("file").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0]; if (f) runOCR(f);
    });

    // PZN: manuelle Eingabe + Prüfen
    var pzn = el("pzn");
    if (pzn) {
      var doPzn = function () { var v = pzn.value; if (!v.trim()) return; if (handlePZN(v)) pzn.value = ""; };
      el("pznBtn").addEventListener("click", doPzn);
      pzn.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); doPzn(); } });
    }
    // PZN: Kamera-Scan
    var ss = el("scanStart"); if (ss) ss.addEventListener("click", startScan);
    var sp = el("scanStop"); if (sp) sp.addEventListener("click", stopScan);
    // Kamera bei Tab-/Seitenwechsel oder Verstecken stoppen (Akku/Datenschutz).
    document.addEventListener("visibilitychange", function () { if (document.hidden) stopScan(); });
    window.addEventListener("pagehide", stopScan);

    el("analyzeBtn").addEventListener("click", analyze);
  }

  // ---- Start ----------------------------------------------------------------
  function boot() {
    if (!MS) { toast("Fehler: Engine nicht geladen."); return; }
    profile = lsGet(LS_PROF, []) || [];
    pznMap = lsGet(LS_PZN, {}) || {};
    renderToggles();
    wire();
    var btn = el("analyzeBtn"); btn.disabled = true; btn.textContent = "Datenbank wird geladen …";
    MS.load(DB_URL).then(function () {
      ready = true;
      var meta = MS.meta();
      // gespeicherte Auswahl auf noch existierende IDs filtern
      selected = (lsGet(LS_SEL, []) || []).map(function (x) { return parseInt(x, 10); }).filter(function (id) { return !!MS.medById(id); });
      lsSet(LS_SEL, selected);
      renderChips();
      btn.disabled = false; btn.textContent = "Wechselwirkungen prüfen";
      setTab("manual");
    }).catch(function (err) {
      btn.textContent = "Datenbank nicht verfügbar";
      toast("Datenbank konnte nicht geladen werden. Bitte Seite neu laden.");
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
