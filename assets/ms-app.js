/* MediScan – UI-Controller (framework-frei).
 * Verdrahtet app.html mit window.MediScan (Engine) + jsPDF-Bericht + Tesseract-OCR.
 * Speichert Auswahl/Profil lokal (localStorage). Keine erfundenen klinischen Daten.
 */
(function () {
  "use strict";
  var MS = window.MediScan;
  var DB_URL = "assets/data/mediscan-db.json";
  var FDA_URL = "assets/data/mediscan-fda.json";   // separate, öffentliche FDA-Datenebene (lazy)
  var LS_SEL = "ms.sel", LS_PROF = "ms.profile", LS_PZN = "ms.pzn", LS_PLANS = "ms.plans";
  var LS_LAST = "ms.last", LS_PLAIN = "ms.plain";
  var TESS_CDN = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  var ZXING_CDN = "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js";

  // ---- kleine Helfer --------------------------------------------------------
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // Inline-Linien-Icons (Feather-Stil, offline, currentColor) – rein optisch, ersetzt Emoji.
  function svgIcon(name, extra) {
    var P = {
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
      calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
      bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
      share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/>',
      file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
      user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
      lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
      download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>'
    };
    return '<svg class="ico' + (extra ? " " + extra : "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || "") + '</svg>';
  }
  // ISO-Datum -> deutsches Format; Tausenderpunkte; Datengrundlage-Zeile aus MS.meta()
  function deDate(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || "")); return m ? (m[3] + "." + m[2] + "." + m[1]) : String(iso || ""); }
  function deNum(n) { return String(n == null ? "" : n).replace(/\B(?=(\d{3})+(?!\d))/g, "."); }
  function dbMetaText() {
    var m = (MS && MS.meta) ? MS.meta() : null; if (!m) return "";
    var p = [];
    if (m.generated) p.push("Stand " + deDate(m.generated));
    if (m.version) p.push("Version " + m.version);
    if (m.counts && m.counts.medications) p.push(deNum(m.counts.medications) + " Präparate");
    if (m.counts && m.counts.interactions) p.push(deNum(m.counts.interactions) + " Wechselwirkungen");
    return p.join(" · ");
  }
  function lsGet(k, def) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  // Mehrere Personen (z. B. „Ich", „Mutter") auf einem Gerät: Auswahl, Profil,
  // Pläne und letzte Prüfung liegen je Person unter eigenem Schlüssel. Die erste
  // Person nutzt die bisherigen Schlüssel ohne Suffix (bestehende Daten bleiben).
  var LS_PERSONS = "ms.persons";
  var persons = lsGet(LS_PERSONS, null);
  if (!persons || !persons.list || !persons.list.length) persons = { list: [{ id: "p0", name: "Ich" }], cur: "p0" };
  function K(base, pid) { pid = pid || persons.cur; return pid === "p0" ? base : base + "@" + pid; }
  function curPerson() { for (var i = 0; i < persons.list.length; i++) if (persons.list[i].id === persons.cur) return persons.list[i]; return persons.list[0]; }
  var toastT = null;
  // toast(msg) – kurze Meldung. toast(msg, {label, onAction}) – mit Aktionsknopf
  // (z. B. „Rückgängig"), bleibt dann länger (6 s) stehen.
  function toast(msg, action) {
    var t = el("ms-toast");
    if (!t) { t = document.createElement("div"); t.id = "ms-toast"; t.className = "toast"; t.setAttribute("role", "status"); t.setAttribute("aria-live", "polite"); document.body.appendChild(t); }
    t.innerHTML = "";
    var span = document.createElement("span"); span.textContent = msg; t.appendChild(span);
    if (action && action.label && typeof action.onAction === "function") {
      var b = document.createElement("button");
      b.type = "button"; b.className = "toast-act"; b.textContent = action.label;
      b.onclick = function () { t.style.opacity = "0"; t.style.pointerEvents = "none"; clearTimeout(toastT); action.onAction(); };
      t.appendChild(b);
    }
    t.style.transition = ""; t.style.opacity = "1"; t.style.pointerEvents = "";
    clearTimeout(toastT); toastT = setTimeout(function () { t.style.transition = "opacity .4s"; t.style.opacity = "0"; t.style.pointerEvents = "none"; }, action ? 6000 : 2600);
  }

  // Eigene, barrierearme Dialoge statt window.prompt/confirm (die auf Handys
  // unschön aussehen und in installierten PWAs teils blockiert sind).
  // Liefert ein Promise: ask → String|null, confirm → true|false.
  function msDialog(opts) {
    return new Promise(function (resolve) {
      var d = document.createElement("dialog");
      if (typeof d.showModal !== "function") {                 // sehr alte Browser → Fallback
        if (opts.input != null) resolve(window.prompt(opts.title, opts.input));
        else resolve(window.confirm(opts.title + (opts.text ? "\n\n" + opts.text : "")));
        return;
      }
      d.className = "msdlg";
      var h = '<form method="dialog" class="msdlg-f">' +
        '<h3 class="msdlg-t">' + esc(opts.title) + '</h3>' +
        (opts.text ? '<p class="msdlg-x">' + esc(opts.text) + '</p>' : '') +
        (opts.input != null ? '<input type="' + (opts.password ? "password" : "text") + '" class="msdlg-in" maxlength="' + (opts.password ? 200 : 80) + '"' + (opts.password ? ' autocomplete="' + (opts.password === "new" ? "new-password" : "current-password") + '"' : '') + ' value="' + esc(opts.input) + '" aria-label="' + esc(opts.title) + '">' : '') +
        '<div class="msdlg-b">' +
        '<button type="button" class="btn ghost small" value="cancel">' + esc(opts.cancel || "Abbrechen") + '</button>' +
        '<button type="submit" class="btn small ' + (opts.danger ? "danger-solid" : "cyan") + '" value="ok">' + esc(opts.ok || "OK") + '</button>' +
        '</div></form>';
      d.innerHTML = h;
      document.body.appendChild(d);
      var inp = d.querySelector(".msdlg-in"), done = false;
      function finish(v) {
        if (done) return; done = true;
        try { d.close(); } catch (e) {}
        setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 0);
        resolve(v);
      }
      d.querySelector('button[value="cancel"]').onclick = function () { finish(opts.input != null ? null : false); };
      d.querySelector("form").addEventListener("submit", function (e) {
        e.preventDefault(); finish(opts.input != null ? (inp ? inp.value : "") : true);
      });
      d.addEventListener("cancel", function (e) { e.preventDefault(); finish(opts.input != null ? null : false); });
      d.addEventListener("click", function (e) { if (e.target === d) finish(opts.input != null ? null : false); });
      d.showModal();
      if (inp) { inp.focus(); try { inp.select(); } catch (e) {} }
    });
  }
  function askText(title, def, okLabel) { return msDialog({ title: title, input: def || "", ok: okLabel || "Speichern" }); }
  function askConfirm(title, text, okLabel, danger) { return msDialog({ title: title, text: text, ok: okLabel || "OK", danger: !!danger }); }

  // ---- Zustand --------------------------------------------------------------
  var selected = [];          // Med-IDs (Zahlen)
  var profile = [];           // category-keys
  var resultsShown = false;
  var ready = false;
  var pznMap = {};            // gerätelokal gelernt: PZN(String) -> [medId,…]
  var pendingPZN = null;      // erkannte, noch nicht zugeordnete PZN
  var plans = [];             // [{id,name,created,medIds:[…],times:[…],notify:bool}]
  var openPlan = null;        // id des aktuell aufgeklappten Erinnerungs-Editors
  var notifyTimers = [];      // aktive setTimeout-Handles der In-App-Erinnerungen
  var fdaData = null;         // { meta, items:{ "<medId>": {generic,brand,text}|null } } – öffentliche FDA-Ebene
  var fdaPromise = null;      // Lade-Promise (nur einmal, lazy)

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
    if (added) { lsSet(K(LS_SEL), selected); renderChips(); maybeRerun(); }
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

  // Fügt gescannte Med-IDs hinzu (ohne PZN-Zuordnungslogik) und liefert die Zahl
  // neu hinzugekommener. Persistiert + rendert die Chips, analysiert aber nicht.
  function addScanned(ids) {
    var added = 0;
    (ids || []).forEach(function (raw) {
      var id = parseInt(raw, 10);
      if (isNaN(id) || !MS.medById(id)) return;
      if (selected.indexOf(id) === -1) { selected.push(id); added++; }
    });
    if (added) { lsSet(K(LS_SEL), selected); renderChips(); }
    return added;
  }
  // Nach einem Scan (Medikationsplan / OCR / bekannte PZN) die Wechselwirkungen
  // IMMER zeigen, sobald Medikamente vorhanden sind – auch beim allerersten Scan.
  // (maybeRerun() tat das nur, wenn zuvor schon einmal analysiert wurde → genau
  // deshalb „scannt, zeigt aber die Wechselwirkung nicht".)
  function analyzeIfReady() { if (ready && selected.length) analyze(); }

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
      if (!resultsShown) analyzeIfReady();   // erster Scan: addByIds→maybeRerun analysiert (noch) nicht
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
    lsSet(K(LS_SEL), selected); renderChips(); maybeRerun();
  }
  function clearSel() {
    var before = selected.slice(), wasShown = resultsShown;
    selected = []; lsSet(K(LS_SEL), selected); renderChips();
    pendingPZN = null; renderPending();
    resultsShown = false; el("results").hidden = true; el("results").innerHTML = "";
    if (before.length) toast("Liste geleert (" + before.length + ").", { label: "Rückgängig", onAction: function () {
      selected = before.filter(function (id) { return !!MS.medById(id); });
      lsSet(K(LS_SEL), selected); renderChips();
      if (wasShown) analyze();
    } });
  }
  // Prüf-Button zeigt die Anzahl der Medikamente und ist ohne Auswahl gedimmt.
  function updateAnalyzeBtn() {
    var b = el("analyzeBtn"); if (!b || !ready) return;
    b.textContent = selected.length ? ("Wechselwirkungen prüfen (" + selected.length + ")") : "Wechselwirkungen prüfen";
    b.classList.toggle("idle", !selected.length);
  }
  function renderChips() {
    var card = el("selCard"), chips = el("chips"), n = el("selN");
    n.textContent = selected.length;
    updateAnalyzeBtn();
    var ex = el("exampleBox"); if (ex) ex.hidden = !!selected.length || !ready;
    if (!selected.length) { card.hidden = true; chips.innerHTML = ""; return; }
    card.hidden = false;
    chips.innerHTML = selected.map(function (id) {
      var m = MS.medById(id); if (!m) return "";
      // Wirkstoff nur zeigen, wenn er sich vom Namen unterscheidet (bei Generika
      // ist name === activeIngredient → sonst stünde dasselbe Wort doppelt).
      var ing = m.activeIngredient || "";
      var sub = (ing && ing.toLowerCase() !== String(m.name || "").toLowerCase())
        ? '<small>' + esc(ing) + '</small>' : '';
      return '<span class="chip">' + esc(m.name) + sub +
        '<button class="x" data-id="' + id + '" aria-label="Entfernen">×</button></span>';
    }).join("");
  }

  // ---- Pläne & Einnahme-Erinnerungen (gerätelokal) --------------------------
  // Pläne = benannte Schnappschüsse der Auswahl. Erinnerungen ehrlich getrennt:
  // Der ZUVERLÄSSIGE Weg ist der Kalender-Export (.ics) – die Termine feuern aus
  // dem echten Kalender des Nutzers, komplett offline und bei geschlossener App.
  // Die In-App-Erinnerung funktioniert nur, solange die App/der Tab offen ist
  // (kein Server, keine Hintergrund-Pushes – das wäre Phase 2/SaaS). Nichts
  // verlässt das Gerät.
  function savePlans() { lsSet(K(LS_PLANS), plans); }
  function planId() { return "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function findPlan(id) { for (var i = 0; i < plans.length; i++) if (plans[i].id === id) return plans[i]; return null; }
  function planMedIds(plan) {
    return (plan.medIds || []).map(function (x) { return parseInt(x, 10); })
      .filter(function (id) { return !isNaN(id) && MS.medById(id); });
  }
  function planMedNames(plan) { return planMedIds(plan).map(function (id) { return MS.medById(id).name; }); }

  function savePlanFromSelection() {
    if (!selected.length) { toast("Bitte zuerst Medikamente hinzufügen."); return; }
    var def = MS.medById(selected[0]) ? MS.medById(selected[0]).name : "Mein Plan";
    if (selected.length > 1) def += " +" + (selected.length - 1);
    var ids = selected.slice();
    askText("Name für diesen Plan", def).then(function (name) {
      if (name === null) return;
      name = (name || "").trim() || def;
      plans.push({ id: planId(), name: name, created: Date.now(), medIds: ids, times: [], notify: false });
      savePlans(); renderPlans();
      toast("Plan „" + name + "“ gespeichert (nur auf diesem Gerät).");
    });
  }
  function loadPlan(id) {
    var p = findPlan(id); if (!p) return;
    selected = planMedIds(p); lsSet(K(LS_SEL), selected);
    renderChips(); maybeRerun();
    toast("Plan „" + p.name + "“ geladen (" + selected.length + ").");
    var sc = el("selCard"); if (sc && sc.scrollIntoView) sc.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function deletePlan(id) {
    var p = findPlan(id); if (!p) return;
    askConfirm("Plan löschen?", "„" + p.name + "“ wird von diesem Gerät entfernt.", "Löschen", true).then(function (ok) {
      if (!ok) return;
      var idx = plans.indexOf(p);
      plans = plans.filter(function (x) { return x.id !== id; });
      if (openPlan === id) openPlan = null;
      savePlans(); renderPlans(); scheduleAllReminders();
      toast("Plan „" + p.name + "“ gelöscht.", { label: "Rückgängig", onAction: function () {
        if (findPlan(p.id)) return;
        plans.splice(Math.min(Math.max(idx, 0), plans.length), 0, p);
        savePlans(); renderPlans(); scheduleAllReminders();
      } });
    });
  }
  function renamePlan(id) {
    var p = findPlan(id); if (!p) return;
    askText("Plan umbenennen", p.name).then(function (name) {
      if (name === null) return;
      p.name = (name || "").trim() || p.name; savePlans(); renderPlans();
    });
  }
  function addTime(id, val) {
    var p = findPlan(id); if (!p) return;
    var v = MS.ics.validTime(val);
    if (!v) { toast("Bitte eine gültige Uhrzeit wählen (z. B. 08:00)."); return; }
    p.times = p.times || [];
    if (p.times.indexOf(v) !== -1) { toast("Diese Zeit ist bereits eingetragen."); return; }
    p.times.push(v); p.times.sort();
    savePlans(); renderPlans(); scheduleAllReminders();
  }
  function removeTime(id, t) {
    var p = findPlan(id); if (!p) return;
    p.times = (p.times || []).filter(function (x) { return x !== t; });
    if (!p.times.length) p.notify = false;
    savePlans(); renderPlans(); scheduleAllReminders();
  }
  function toggleNotify(id) {
    var p = findPlan(id); if (!p) return;
    if (p.notify) { p.notify = false; savePlans(); renderPlans(); scheduleAllReminders(); return; }
    if (!(p.times && p.times.length)) { toast("Bitte zuerst eine Einnahmezeit hinzufügen."); return; }
    if (!("Notification" in window)) { toast("Dieser Browser unterstützt keine Benachrichtigungen. Bitte den Kalender-Export (.ics) nutzen."); return; }
    var enable = function () { p.notify = true; savePlans(); renderPlans(); scheduleAllReminders(); toast("In-App-Erinnerung aktiv – nur solange die App geöffnet ist."); };
    if (Notification.permission === "granted") { enable(); return; }
    if (Notification.permission === "denied") { toast("Benachrichtigungen sind im Browser blockiert. Bitte erlauben oder .ics nutzen."); return; }
    try {
      Notification.requestPermission().then(function (perm) {
        if (perm === "granted") enable();
        else toast("Ohne Erlaubnis keine In-App-Erinnerung. Der Kalender-Export (.ics) funktioniert weiterhin.");
      }).catch(function () {});
    } catch (e) {}
  }

  function download(filename, text, mime) {
    try {
      var blob = new Blob([text], { type: (mime || "text/plain") + ";charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(function () { try { document.body.removeChild(a); } catch (e) {} URL.revokeObjectURL(url); }, 1500);
      return true;
    } catch (e) { toast("Download nicht möglich."); return false; }
  }
  function exportICS(id) {
    var p = findPlan(id); if (!p) return;
    var ics = MS.ics.build(p, planMedNames(p), new Date());
    if (!ics) { toast("Bitte zuerst mindestens eine Einnahmezeit hinzufügen."); return; }
    var safe = (p.name || "Plan").replace(/[^0-9A-Za-zäöüÄÖÜß-]+/g, "_").slice(0, 40) || "Plan";
    if (download("MediScan_Erinnerung_" + safe + ".ics", ics, "text/calendar")) {
      toast("Kalender-Datei erstellt. In Ihrem Kalender importieren – die Erinnerung feuert dann zuverlässig.");
    }
  }

  // In-App-Erinnerungen (nur Vordergrund, best effort) ------------------------
  function clearReminders() { notifyTimers.forEach(function (t) { clearTimeout(t); }); notifyTimers = []; }
  function nextDelay(hhmm) {                    // ms bis zum nächsten Auftreten von HH:MM
    var m = /^(\d{2}):(\d{2})$/.exec(hhmm); if (!m) return -1;
    var now = new Date();
    var t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +m[1], +m[2], 0, 0);
    if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
    return t.getTime() - now.getTime();
  }
  function fireReminder(plan, hhmm) {
    var names = planMedNames(plan);
    var body = names.length ? names.join(", ") : "Medikamente laut Plan";
    var title = "Medikamente einnehmen – " + plan.name;
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then(function (reg) {
          reg.showNotification(title, { body: body, tag: "ms-" + plan.id + "-" + hhmm, icon: "assets/icons/icon-192.png", badge: "assets/icons/favicon-32.png", renotify: true });
        }).catch(function () { try { new Notification(title, { body: body }); } catch (e) {} });
      } else { new Notification(title, { body: body }); }
    } catch (e) {}
    armTime(plan, hhmm);                         // für den Folgetag neu scharf schalten
  }
  function armTime(plan, hhmm) {
    var d = nextDelay(hhmm); if (d < 0) return;
    notifyTimers.push(setTimeout(function () {   // sehr lange Timeouts sind unzuverlässig -> max ~24h
      var live = findPlanAny(plan.id);
      if (live && live.notify && (live.times || []).indexOf(hhmm) !== -1) fireReminder(live, hhmm);
    }, Math.min(d, 24 * 3600 * 1000)));
  }
  function scheduleAllReminders() {
    clearReminders();
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    allPlans().forEach(function (p) { if (p.notify) (p.times || []).forEach(function (t) { armTime(p, t); }); });
  }
  // Erinnerungen gelten für ALLE Personen, nicht nur die gerade angezeigte.
  function allPlans() {
    var out = plans.slice();
    persons.list.forEach(function (pe) { if (pe.id !== persons.cur) out = out.concat(lsGet(K(LS_PLANS, pe.id), []) || []); });
    return out;
  }
  function findPlanAny(id) { var a = allPlans(); for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i]; return null; }

  // Dosierung je Plan: p.doses = { medId: { s: Stärke, m, mi, a, n } } – freie
  // Eingabe des Nutzers (wie verordnet), keine Vorschläge aus der App.
  var DOSE_SLOTS = [["m", "Mo", "morgens"], ["mi", "Mi", "mittags"], ["a", "Ab", "abends"], ["n", "Na", "zur Nacht"]];
  function setDose(pid, mid, f, v) {
    var p = findPlan(pid); if (!p) return;
    p.doses = p.doses || {};
    var d = p.doses[mid] = p.doses[mid] || {};
    v = String(v || "").trim().slice(0, f === "s" ? 24 : 5);
    if (v) d[f] = v; else delete d[f];
    if (!Object.keys(d).length) delete p.doses[mid];
    savePlans();
  }

  // Medikationsplan als PDF – angelehnt an den bundeseinheitlichen Plan (BMP),
  // aber ausdrücklich KEIN offizieller BMP (kein Barcode, nicht ärztlich erstellt).
  function makeMedPlanPDF(id) {
    var p = findPlan(id); if (!p) return;
    if (!window.jspdf || !window.jspdf.jsPDF) { toast("PDF-Bibliothek nicht geladen."); return; }
    var ids = planMedIds(p);
    if (!ids.length) { toast("Dieser Plan enthält keine Medikamente."); return; }
    var doc = new window.jspdf.jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
    var PW = doc.internal.pageSize.getWidth(), PH = doc.internal.pageSize.getHeight();
    var M = 36, CW = PW - 2 * M, y, page = 1;
    var now = new Date(), ds = pad(now.getDate()) + "." + pad(now.getMonth() + 1) + "." + now.getFullYear();
    // Spalten: Wirkstoff/Präparat | Wirkstoff(e) | Stärke | Mo | Mi | Ab | Na | Hinweise
    var cols = [{ t: "Medikament", w: 0.22 }, { t: "Wirkstoff / Gruppe", w: 0.24 }, { t: "Stärke", w: 0.12 },
                { t: "Mo", w: 0.05, c: 1 }, { t: "Mi", w: 0.05, c: 1 }, { t: "Ab", w: 0.05, c: 1 }, { t: "Na", w: 0.05, c: 1 },
                { t: "Hinweise (handschriftlich)", w: 0.22 }];
    var x = M; cols.forEach(function (c) { c.x = x; c.pw = c.w * CW; x += c.pw; });
    function foot() {
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(120);
      doc.text(pdfSafe("Selbst erstellt mit MediScan – kein bundeseinheitlicher Medikationsplan (BMP). Dosierung wie vom Nutzer eingetragen; maßgeblich ist die ärztliche Verordnung."), M, PH - 20);
      doc.text("Seite " + page, PW - M, PH - 20, { align: "right" });
    }
    function head() {
      doc.setFillColor(0, 105, 92); doc.rect(0, 0, PW, 62, "F");
      doc.setTextColor(255); doc.setFont("helvetica", "bold"); doc.setFontSize(17);
      doc.text("Medikationsplan", M, 30);
      doc.setFont("helvetica", "normal"); doc.setFontSize(10);
      doc.text(pdfSafe("für: " + curPerson().name + "   ·   Plan: " + p.name), M, 48);
      doc.text("Stand: " + ds, PW - M, 30, { align: "right" });
      y = 80;
      doc.setFillColor(232, 242, 240); doc.rect(M, y, CW, 20, "F");
      doc.setTextColor(0, 77, 64); doc.setFont("helvetica", "bold"); doc.setFontSize(9);
      cols.forEach(function (c) { doc.text(pdfSafe(c.t), c.c ? c.x + c.pw / 2 : c.x + 5, y + 13, c.c ? { align: "center" } : undefined); });
      y += 20;
    }
    head();
    doc.setDrawColor(200);
    ids.forEach(function (mid, i) {
      var m = MS.medById(mid), d = (p.doses && p.doses[mid]) || {};
      var cells = [m.name, [m.activeIngredient || "", m.category || ""].filter(Boolean).join(" · "), d.s || "", d.m || "", d.mi || "", d.a || "", d.n || "", ""];
      doc.setFont("helvetica", "normal"); doc.setFontSize(9.5);
      var lines = cells.map(function (t, k) { return doc.splitTextToSize(pdfSafe(t), cols[k].pw - 10); });
      var hh = Math.max(26, 8 + 12 * Math.max.apply(null, lines.map(function (l) { return l.length; })));
      if (y + hh > PH - 36) { foot(); doc.addPage(); page++; head(); doc.setDrawColor(200); }
      if (i % 2) { doc.setFillColor(248, 250, 250); doc.rect(M, y, CW, hh, "F"); }
      doc.setTextColor(30);
      lines.forEach(function (l, k) {
        var c = cols[k];
        doc.setFont("helvetica", k === 0 ? "bold" : "normal");
        l.forEach(function (ln, j) { doc.text(ln, c.c ? c.x + c.pw / 2 : c.x + 5, y + 15 + j * 12, c.c ? { align: "center" } : undefined); });
      });
      doc.line(M, y + hh, M + CW, y + hh);
      y += hh;
    });
    cols.slice(1).forEach(function (c) { doc.line(c.x, 80, c.x, y); });
    doc.rect(M, 80, CW, y - 80);
    y += 16;
    if (p.times && p.times.length) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(60);
      doc.text(pdfSafe("Erinnerungszeiten: " + p.times.join(", ") + " Uhr"), M, y);
    }
    foot();
    var safe = (p.name || "Plan").replace(/[^0-9A-Za-zäöüÄÖÜß-]+/g, "_").slice(0, 40) || "Plan";
    try { doc.save("Medikationsplan_" + safe + ".pdf"); toast("Medikationsplan erstellt."); } catch (e) { toast("PDF konnte nicht erstellt werden."); }
  }

  function renderPlans() {
    var card = el("plansCard"), list = el("planList"), n = el("planN");
    if (!card || !list) return;
    if (n) n.textContent = plans.length;
    if (!plans.length) {
      // Dauerhaft sichtbar: illustrierter Leerzustand mit erklärendem Hinweis
      // (rein optisch, keine neue Funktion – der Weg bleibt „oben auswählen → speichern").
      card.hidden = false;
      list.innerHTML = '<div class="plans-empty">' +
        '<svg class="plans-empty-art" viewBox="0 0 120 96" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect class="pe-a" x="26" y="14" width="66" height="74" rx="9" stroke-width="3"/>' +
        '<rect class="pe-a" x="45" y="8" width="28" height="14" rx="5" stroke-width="3"/>' +
        '<path class="pe-b" d="M40 42h28M40 54h34M40 66h20" stroke-width="3"/>' +
        '<circle class="pe-c" cx="90" cy="72" r="15" stroke-width="3"/>' +
        '<path class="pe-c" d="M90 66v12M84 72h12" stroke-width="3"/>' +
        '</svg>' +
        '<p class="pe-lead">Noch keine gespeicherten Pläne</p>' +
        '<p class="small muted pe-sub">Wählen Sie oben Ihre Medikamente aus und tippen Sie auf <b>„Als Plan speichern"</b> – so sichern Sie eine Liste für später und können Einnahme-Erinnerungen einrichten.</p>' +
        '</div>';
      return;
    }
    card.hidden = false;
    var notif = ("Notification" in window) ? Notification.permission : "unsupported";
    list.innerHTML = plans.map(function (p) {
      var names = planMedNames(p);
      var preview = names.slice(0, 3).join(", ") + (names.length > 3 ? " +" + (names.length - 3) : "");
      var open = openPlan === p.id;
      var h = '<div class="mplan">';
      h += '<div class="mplan-hd"><div class="mplan-nm"><b>' + esc(p.name) + '</b> <span class="n">' + names.length + '</span>' +
        '<div class="mplan-prev small muted">' + esc(preview || "—") + '</div></div>';
      h += '<div class="mplan-bt">' +
        '<button type="button" class="btn small" data-act="load" data-id="' + esc(p.id) + '">Laden</button>' +
        '<button type="button" class="btn ghost small" data-act="toggle" data-id="' + esc(p.id) + '">' + (open ? "Schließen" : (svgIcon("clock") + "Einnahme")) + '</button>' +
        '<button type="button" class="btn ghost small" data-act="rename" data-id="' + esc(p.id) + '">Umbenennen</button>' +
        '<button type="button" class="btn ghost small danger" data-act="del" data-id="' + esc(p.id) + '">Löschen</button>' +
        '</div></div>';
      if (open) {
        h += '<div class="mplan-rem">';
        h += '<div class="dose-hd"><b class="small">Dosierung</b><span class="small muted"> – Stärke und Stück je Tageszeit, wie verordnet (optional)</span></div>';
        h += '<div class="dose-tbl" role="table" aria-label="Dosierung">' +
          '<div class="dose-row dose-head" role="row"><span role="columnheader">Medikament</span><span role="columnheader">Stärke</span>' +
          DOSE_SLOTS.map(function (sl) { return '<span role="columnheader" title="' + sl[2] + '">' + sl[1] + '</span>'; }).join("") + '</div>';
        planMedIds(p).forEach(function (mid) {
          var d = (p.doses && p.doses[mid]) || {};
          var at = ' data-pid="' + esc(p.id) + '" data-mid="' + mid + '"';
          h += '<div class="dose-row" role="row"><span class="dose-nm" role="cell">' + esc(MS.medById(mid).name) + '</span>' +
            '<span role="cell"><input class="dose-in dose-s"' + at + ' data-f="s" maxlength="24" placeholder="z. B. 100 mg" value="' + esc(d.s || "") + '" aria-label="Stärke ' + esc(MS.medById(mid).name) + '"></span>' +
            DOSE_SLOTS.map(function (sl) {
              return '<span role="cell"><input class="dose-in dose-n"' + at + ' data-f="' + sl[0] + '" maxlength="5" placeholder="–" value="' + esc(d[sl[0]] || "") + '" aria-label="' + sl[2] + ' ' + esc(MS.medById(mid).name) + '"></span>';
            }).join("") + '</div>';
        });
        h += '</div>';
        h += '<div class="rem-actions"><button type="button" class="btn ghost small" data-act="medpdf" data-id="' + esc(p.id) + '">' + svgIcon("file") + 'Medikationsplan (PDF)</button></div>';
        h += '<div class="dose-hd"><b class="small">Erinnerung</b></div>';
        h += '<div class="rem-times">' + ((p.times && p.times.length) ? p.times.map(function (t) {
          return '<span class="timechip">' + esc(t) + '<button type="button" class="x" data-act="rmtime" data-id="' + esc(p.id) + '" data-t="' + esc(t) + '" aria-label="Zeit entfernen">×</button></span>';
        }).join("") : '<span class="small muted">Noch keine Einnahmezeit.</span>') + '</div>';
        h += '<div class="rem-add"><input type="time" class="tin" id="tin_' + esc(p.id) + '" value="08:00" aria-label="Einnahmezeit"><button type="button" class="btn ghost small" data-act="addtime" data-id="' + esc(p.id) + '">+ Zeit</button></div>';
        h += '<div class="rem-actions">' +
          '<button type="button" class="btn cyan small" data-act="ics" data-id="' + esc(p.id) + '">' + svgIcon("calendar") + 'Kalender-Datei (.ics)</button>' +
          '<button type="button" class="btn ' + (p.notify ? "cyan" : "ghost") + ' small" data-act="notify" data-id="' + esc(p.id) + '">' + svgIcon("bell") + (p.notify ? "In-App-Erinnerung: an" : "In-App-Erinnerung") + '</button>' +
          '</div>';
        var note = '<b>Kalender (.ics):</b> zuverlässig – die Erinnerung kommt aus Ihrem Kalender, auch offline und bei geschlossener App. <b>In-App:</b> nur, solange diese App geöffnet ist.';
        if (notif === "denied") note += ' Benachrichtigungen sind im Browser blockiert.';
        else if (notif === "unsupported") note += ' Ihr Browser unterstützt keine In-App-Benachrichtigungen – bitte .ics nutzen.';
        h += '<p class="small muted rem-note">' + note + '</p></div>';
      }
      h += '</div>';
      return h;
    }).join("");
  }

  // ---- Personen ---------------------------------------------------------------
  function savePersons() { lsSet(LS_PERSONS, persons); }
  function renderPersons() {
    var sel = el("personSel"); if (!sel) return;
    sel.innerHTML = persons.list.map(function (pe) {
      return '<option value="' + esc(pe.id) + '"' + (pe.id === persons.cur ? " selected" : "") + '>' + esc(pe.name) + '</option>';
    }).join("");
    var del = el("personDel"); if (del) del.hidden = persons.list.length < 2;
  }
  function switchPerson(id, quiet) {
    if (!id || id === persons.cur) return;
    persons.cur = id; savePersons();
    stopSpeak();
    selected = (lsGet(K(LS_SEL), []) || []).map(function (x) { return parseInt(x, 10); }).filter(function (i) { return !!MS.medById(i); });
    profile = lsGet(K(LS_PROF), []) || [];
    plans = lsGet(K(LS_PLANS), []) || [];
    openPlan = null;
    var res = el("results"); if (res) { res.hidden = true; res.innerHTML = ""; }
    resultsShown = false;
    renderPersons(); renderToggles(); renderChips(); renderPlans(); scheduleAllReminders();
    var ex = el("exampleBox"); if (ex) ex.hidden = !!selected.length;
    if (!quiet) toast("Person: " + curPerson().name);
  }
  function addPerson() {
    askText("Name der Person", "").then(function (name) {
      if (name === null) return;
      name = (name || "").trim(); if (!name) return;
      var id = "p" + Date.now().toString(36);
      persons.list.push({ id: id, name: name.slice(0, 40) }); savePersons();
      switchPerson(id);
    });
  }
  function renamePerson() {
    var pe = curPerson();
    askText("Person umbenennen", pe.name).then(function (name) {
      if (name === null) return;
      pe.name = ((name || "").trim() || pe.name).slice(0, 40); savePersons(); renderPersons();
    });
  }
  function deletePerson() {
    if (persons.list.length < 2) return;
    var pe = curPerson();
    askConfirm("Person entfernen?", "Auswahl, Profil und Pläne von „" + pe.name + "“ werden von diesem Gerät gelöscht.", "Entfernen", true).then(function (ok) {
      if (!ok) return;
      [LS_SEL, LS_PROF, LS_PLANS, LS_LAST].forEach(function (b) {
        if (pe.id !== "p0") { try { localStorage.removeItem(K(b, pe.id)); } catch (e) {} }
        else lsSet(b, b === LS_LAST ? null : []);
      });
      persons.list = persons.list.filter(function (x) { return x.id !== pe.id; });
      persons.cur = null; switchPerson(persons.list[0].id, true);
      toast("„" + pe.name + "“ entfernt.");
    });
  }

  // ---- Verschlüsselte Sicherung (WebCrypto: PBKDF2-SHA-256 + AES-GCM) ----------
  // Enthält alle MediScan-Daten dieses Geräts außer dem Lizenzschlüssel. Das
  // Passwort verlässt das Gerät nie; ohne Passwort ist die Datei nicht lesbar.
  var BK_ITER = 250000;
  function b64(buf) { var b = new Uint8Array(buf), s = ""; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  function unb64(str) { var s = atob(str), b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
  function bkKey(pw, salt, iter) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveKey"]).then(function (base) {
      return crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt, iterations: iter, hash: "SHA-256" }, base,
        { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    });
  }
  function backupKeys() {
    var out = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf("ms.") === 0 && k !== "ms.lic" && k.indexOf("ms.install") !== 0) out[k] = localStorage.getItem(k);
    }
    return out;
  }
  function exportBackup() {
    if (!(window.crypto && crypto.subtle && window.TextEncoder)) { toast("Verschlüsselung wird von diesem Browser nicht unterstützt."); return; }
    msDialog({ title: "Passwort für die Sicherung", text: "Mindestens 8 Zeichen. Ohne dieses Passwort lässt sich die Datei nicht wiederherstellen – bitte gut merken.", input: "", password: "new", ok: "Weiter" }).then(function (pw) {
      if (pw === null) return;
      if ((pw || "").length < 8) { toast("Das Passwort braucht mindestens 8 Zeichen."); return; }
      return msDialog({ title: "Passwort wiederholen", input: "", password: "new", ok: "Sicherung erstellen" }).then(function (pw2) {
        if (pw2 === null) return;
        if (pw2 !== pw) { toast("Die Passwörter stimmen nicht überein."); return; }
        var salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
        var plain = new TextEncoder().encode(JSON.stringify({ app: "MediScan", at: new Date().toISOString(), data: backupKeys() }));
        return bkKey(pw, salt, BK_ITER).then(function (key) {
          return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, plain);
        }).then(function (ct) {
          var file = { format: "mediscan-backup", v: 1, kdf: "PBKDF2-SHA256", iter: BK_ITER, cipher: "AES-GCM", salt: b64(salt), iv: b64(iv), data: b64(ct) };
          var d = new Date();
          if (download("MediScan_Sicherung_" + d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + ".msbak", JSON.stringify(file), "application/json"))
            toast("Sicherung erstellt (verschlüsselt).");
        });
      });
    }).catch(function () { toast("Sicherung fehlgeschlagen."); });
  }
  function importBackup(f) {
    if (!f) return;
    if (!(window.crypto && crypto.subtle && window.TextDecoder)) { toast("Verschlüsselung wird von diesem Browser nicht unterstützt."); return; }
    if (f.size > 5 * 1024 * 1024) { toast("Datei ist zu groß für eine MediScan-Sicherung."); return; }
    var rd = new FileReader();
    rd.onload = function () {
      var file; try { file = JSON.parse(rd.result); } catch (e) { file = null; }
      if (!file || file.format !== "mediscan-backup" || !file.salt || !file.iv || !file.data) { toast("Keine gültige MediScan-Sicherung."); return; }
      var iter = Math.min(Math.max(parseInt(file.iter, 10) || BK_ITER, 100000), 2000000);
      msDialog({ title: "Passwort der Sicherung", input: "", password: "cur", ok: "Entschlüsseln" }).then(function (pw) {
        if (pw === null) return;
        return bkKey(pw, unb64(file.salt), iter).then(function (key) {
          return crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(file.iv) }, key, unb64(file.data));
        }).then(function (buf) {
          var obj = JSON.parse(new TextDecoder().decode(buf));
          var data = obj && obj.data; if (!data || typeof data !== "object") throw new Error("leer");
          var n = Object.keys(data).filter(function (k) { return k.indexOf("ms.") === 0 && k !== "ms.lic"; }).length;
          return askConfirm("Sicherung einspielen?", "Die aktuellen MediScan-Daten auf diesem Gerät werden durch die Sicherung vom " + deDate(obj.at) + " ersetzt (" + n + " Einträge).", "Einspielen", true).then(function (ok) {
            if (!ok) return;
            Object.keys(backupKeys()).forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
            Object.keys(data).forEach(function (k) {
              if (k.indexOf("ms.") === 0 && k !== "ms.lic" && typeof data[k] === "string") { try { localStorage.setItem(k, data[k]); } catch (e) {} }
            });
            toast("Sicherung eingespielt – App wird neu geladen.");
            setTimeout(function () { location.reload(); }, 900);
          });
        }, function () { toast("Falsches Passwort oder beschädigte Datei."); });
      });
    };
    rd.onerror = function () { toast("Datei konnte nicht gelesen werden."); };
    rd.readAsText(f);
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
      // Über eine Marke/Synonym gefunden? Dann zeigen, dass die Eingabe erkannt
      // wurde (Wirkstoff bleibt Haupteintrag) – außer der Treffername ist die Marke.
      var via = (p.brand && p.brand.toLowerCase() !== String(p.name || "").toLowerCase())
        ? ' <span class="ac-via">· Treffer für „' + esc(p.brand) + '"</span>' : '';
      return '<button type="button" data-idx="' + i + '" class="' + (i === 0 ? "active" : "") + '">' +
        '<div>' + esc(p.name) + tag + '</div>' +
        '<div class="ing">' + esc(p.sub) + (p.category ? " · " + esc(p.category) : "") + via + '</div></button>';
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
    lsSet(K(LS_PROF), profile); renderToggles(); maybeRerun();
  }

  // ---- OCR (Tesseract, faul geladen) ----------------------------------------
  // Tesseract-Script laden – mit Wiederholung. Ein einzelner CDN-/Netzaussetzer
  // beim Scriptabruf ist die Hauptursache für „gar nichts erkannt": ohne Script
  // wirft runOCR sofort. crossOrigin=anonymous liefert eine saubere CORS-Antwort,
  // die der Service-Worker cachen kann → weitere Scans laufen offline.
  function injectTesseractScript() {
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = TESS_CDN; s.async = true; s.crossOrigin = "anonymous";
      s.onload = function () { res(); };
      s.onerror = function () { try { s.remove(); } catch (e) {} rej(new Error("CDN")); };
      document.head.appendChild(s);
    });
  }
  async function loadTesseract() {
    if (window.Tesseract) return;
    var lastErr = null;
    for (var attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(function (r) { setTimeout(r, 400 * attempt); });
      try { await injectTesseractScript(); } catch (e) { lastErr = e; }
      if (window.Tesseract) return;
    }
    throw lastErr || new Error("Tesseract nicht ladbar");
  }

  // OCR-Worker aufbauen (lädt worker.min.js + WASM-Core + deu.traineddata vom
  // CDN) – ebenfalls mit Wiederholung, denn auch diese Abrufe können vereinzelt
  // scheitern. Wörterbuch AUS schon bei der Initialisierung: load_system_dawg/
  // load_freq_dawg sind INIT-ONLY und werden per setParameters in Tesseract v5
  // still ignoriert (Warnung „can only be set during initialization") – daher als
  // 4. Argument (config) an createWorker. Nach dem ersten Erfolg cacht der
  // Service-Worker die Teile → folgende Scans starten offline.
  async function startOCRWorker() {
    var lastErr = null;
    for (var attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(function (r) { setTimeout(r, 500 * attempt); });
      var w = null;
      try {
        w = await window.Tesseract.createWorker("deu", 1, {
          logger: function (m) {
            if (m.status === "recognizing text") setBar(12 + Math.round(m.progress * 86), "Text wird erkannt … " + Math.round(m.progress * 100) + "%");
          }
        }, {
          load_system_dawg: "0",
          load_freq_dawg: "0"
        });
        return w;
      } catch (e) {
        lastErr = e;
        if (w) { try { await w.terminate(); } catch (x) {} }
      }
    }
    throw lastErr || new Error("OCR-Worker nicht startbar");
  }

  // Vorwärmen der OCR-Kette. Wird beim ANTIPPEN von „Foto aufnehmen"/„Aus
  // Galerie …" ausgelöst – also parallel zum OS-Bildpicker, der den Nutzer
  // mehrere Sekunden kostet. In dieser Zeit werden Skript + Worker + WASM-Core
  // + ~15 MB deu.traineddata in den dauerhaften OCR-Cache geladen. Dadurch hängt
  // AUCH der ERSTE Scan einer Sitzung nicht mehr an einem Just-in-time-CDN-Abruf
  // im Moment der Texterkennung – dem einzigen verbliebenen Rest-Ausfallpunkt
  // nach dem SW-Cache-Fix. Rein additiv: der Scan-Pfad (decodeImageFile →
  // runOCR) bleibt UNVERÄNDERT und findet die Teile bereits im Cache (schneller
  // + robuster). Best-effort – jeder Fehler wird verschluckt, der reguläre Scan
  // hat weiterhin seine eigenen 3 Wiederholungen. Der Wegwerf-Worker dient nur
  // dem Befüllen des Caches und wird sofort wieder freigegeben.
  var ocrWarmed = false;
  function warmOCR() {
    if (ocrWarmed) return;
    ocrWarmed = true;
    loadTesseract().then(function () {
      return startOCRWorker();
    }).then(function (w) {
      try { w.terminate(); } catch (e) {}
    }).catch(function () {
      ocrWarmed = false; // beim nächsten Antippen erneut versuchen
    });
  }

  function showOCR(on) { el("ocrbox").hidden = !on; }
  function setBar(pct, msg) { el("ocrbar").style.width = pct + "%"; if (msg) el("ocrmsg").textContent = msg; }
  // Zeigt (bei Nichttreffer) den tatsächlich erkannten Rohtext an, damit der
  // Nutzer sieht, was gelesen wurde, und gezielt über die Suche nachhelfen kann.
  function showRaw(text) {
    var box = el("ocrraw"); if (!box) return;
    var clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) { box.hidden = true; box.textContent = ""; return; }
    if (clean.length > 180) clean = clean.slice(0, 180) + " …";
    box.textContent = "Erkannter Text: " + clean;
    box.hidden = false;
  }

  // ---- Bild fürs OCR aufbereiten --------------------------------------------
  // Handy-Fotos sind riesig (12 MP+), oft farbstichig und ungleich beleuchtet –
  // suboptimal für Tesseract. Wir skalieren auf eine sinnvolle Kantenlänge
  // herunter, wandeln in Graustufen und spreizen den Kontrast auf das 2.–98.
  // Perzentil (robust gegen Glanzlichter auf Blister/Folie). Das hebt die
  // Trefferquote auf echten Medikamentenschachteln deutlich. Fail-safe: schlägt
  // ein Schritt fehl (kein Canvas o. Ä.), kommt die Originaldatei unverändert
  // zurück – der Scan bricht nie an der Aufbereitung.
  function loadDrawable(file) {
    if (typeof createImageBitmap === "function") {
      return createImageBitmap(file).then(function (bmp) {
        return { img: bmp, cleanup: function () { try { bmp.close && bmp.close(); } catch (e) {} } };
      }).catch(function () { return loadImgEl(file); });
    }
    return loadImgEl(file);
  }
  function loadImgEl(file) {
    return new Promise(function (res, rej) {
      var u = URL.createObjectURL(file), im = new Image();
      im.onload = function () { res({ img: im, cleanup: function () { try { URL.revokeObjectURL(u); } catch (e) {} } }); };
      im.onerror = function () { try { URL.revokeObjectURL(u); } catch (e) {} rej(new Error("img")); };
      im.src = u;
    });
  }
  async function preprocessForOCR(file) {
    var dr = null;
    try {
      dr = await loadDrawable(file);
      var img = dr.img, W = img.width || img.naturalWidth, H = img.height || img.naturalHeight;
      if (!W || !H) return file;
      var LONG = 1800, scale = Math.min(1, LONG / Math.max(W, H));
      var w = Math.max(1, Math.round(W * scale)), h = Math.max(1, Math.round(H * scale));
      var cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      var ctx = cv.getContext("2d", { willReadFrequently: true });
      if (!ctx) return file;
      ctx.drawImage(img, 0, 0, w, h);
      dr.cleanup(); dr = null;
      var imgData = ctx.getImageData(0, 0, w, h), d = imgData.data, n = d.length, i;
      // 1) Graustufe (Luma) + Histogramm
      var gray = new Uint8ClampedArray(n >> 2), hist = new Uint32Array(256), p = 0, g;
      for (i = 0; i < n; i += 4) {
        g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
        gray[p++] = g; hist[g]++;
      }
      // 2) Kontrast auf 2.–98. Perzentil strecken
      var total = gray.length, lo = 0, hi = 255, acc = 0;
      for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= total * 0.02) { lo = i; break; } }
      acc = 0;
      for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= total * 0.98) { hi = i; break; } }
      if (hi <= lo) { lo = 0; hi = 255; }
      var span = hi - lo, lut = new Uint8ClampedArray(256);
      for (i = 0; i < 256; i++) lut[i] = i <= lo ? 0 : i >= hi ? 255 : Math.round((i - lo) * 255 / span);
      p = 0;
      for (i = 0; i < n; i += 4) { var v = lut[gray[p++]]; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
      ctx.putImageData(imgData, 0, 0);
      return cv;
    } catch (e) {
      return file;
    } finally {
      if (dr) dr.cleanup();
    }
  }

  async function runOCR(file) {
    var thumb = el("thumb");
    try {
      // Vorheriges Vorschaubild freigeben (sonst bleibt jedes Foto bis zum Neuladen im Speicher).
      if (thumb.src && thumb.src.indexOf("blob:") === 0) URL.revokeObjectURL(thumb.src);
      thumb.src = URL.createObjectURL(file); thumb.hidden = false;
    } catch (e) {}
    showRaw("");
    showOCR(true); setBar(3, "Bild wird aufbereitet …");
    var worker = null;
    try {
      var input = await preprocessForOCR(file);
      setBar(6, "Sprachpaket wird geladen …");
      await loadTesseract();
      setBar(10, "Texterkennung startet …");
      worker = await startOCRWorker();
      // Laufzeit-Parameter (NICHT init-only): Layout = ein zusammenhängender
      // Textblock (Packungsaufdruck / Planzeile), Wort-Zwischenräume erhalten.
      // (Wörterbuch AUS passiert bereits in startOCRWorker bei der Init.)
      try {
        await worker.setParameters({
          tessedit_pageseg_mode: "6",
          preserve_interword_spaces: "1"
        });
      } catch (e) { /* ältere Tesseract-Version ohne setParameters → Default */ }
      var out = await worker.recognize(input);
      await worker.terminate(); worker = null;
      setBar(100, "Abgleich mit Datenbank …");
      var text = (out && out.data && out.data.text) || "";
      var found = MS.detect(text);
      var toAdd = [];
      found.forEach(function (f) {
        (f.ids && f.ids.length ? f.ids : [f.medId]).forEach(function (id) { if (toAdd.indexOf(id) === -1) toAdd.push(id); });
      });
      var added = addScanned(toAdd);
      if (added) analyzeIfReady();   // Wechselwirkungen sofort zeigen – auch beim ersten Scan
      setTimeout(function () { showOCR(false); }, 700);
      if (added) { showRaw(""); toast(added + " Medikament" + (added > 1 ? "e" : "") + " erkannt und hinzugefügt."); }
      else if (found.length) { showRaw(""); toast("Erkannte Medikamente sind bereits in der Liste."); }
      else {
        showRaw(text);   // nichts erkannt → gelesenen Text zeigen, damit man gezielt nachsuchen kann
        toast("Kein bekanntes Medikament erkannt – bitte über die Suche prüfen.");
      }
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

  // ---- Foto-Barcode aus Kamera ODER Galerie ---------------------------------
  // Nimmt EIN Standbild entgegen – frisch über die native Kamera-App (Input mit
  // capture="environment") oder ein bereits vorhandenes Bild aus der Galerie
  // (Input ohne capture) – und liest Barcode/PZN daraus. Braucht KEIN
  // getUserMedia und keinen Web-Berechtigungsdialog – deshalb funktioniert es
  // auch dann, wenn Android den Live-Kamerazugriff wegen einer Bildschirm-
  // Einblendung anderer Apps blockiert ("Diese Website darf nicht nach deiner
  // Berechtigung fragen"). Die Kamera-App hat ihre Berechtigung bereits; das
  // Bild wird ausschließlich auf dem Gerät verarbeitet – kein Upload.
  function onPhotoHit(r) {
    try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) {}
    handlePZN("PZN " + r.pzn);
  }
  // Zentraler Einstieg für JEDEN gelesenen Code-Inhalt (Foto ODER Live-Kamera).
  // Reihenfolge ist entscheidend:
  //   1) Ist es ein Medikationsplan (BMP-Data-Matrix, „<MP …>" / attributierte
  //      Elemente)? Dann die aufgedruckten Wirkstoff-/Handelsnamen direkt aus dem
  //      Payload ernten und über MS.detect() den DB-IDs zuordnen. KEINE PZN raten
  //      – der Data-Matrix-Inhalt ist die verlässliche Quelle (besser als OCR).
  //   2) Sonst als einzelne PZN behandeln (Strichcode auf einer Packung).
  // Nur so „scannt die App den Plan und zeigt die Wechselwirkung automatisch".
  function handleScanPayload(raw, live) {
    var names = (MS.bmp && MS.bmp.text) ? MS.bmp.text(raw) : "";
    if (names) {
      if (live) stopScan();
      var found = MS.detect(names) || [];
      var ids = [];
      found.forEach(function (f) {
        (f.ids && f.ids.length ? f.ids : [f.medId]).forEach(function (id) {
          if (ids.indexOf(id) === -1) ids.push(id);
        });
      });
      var added = addScanned(ids);
      try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) {}
      if (added) toast(added + " Medikament" + (added > 1 ? "e" : "") + " aus dem Medikationsplan erkannt.");
      else if (found.length) toast("Medikamente aus dem Plan sind bereits in der Liste.");
      else toast("Medikationsplan erkannt, aber keine bekannten Wirkstoffe in der Datenbank gefunden.");
      setTab("manual");
      analyzeIfReady();   // Wechselwirkungen sofort zeigen – auch beim ersten Scan
      return true;
    }
    var r = MS.pzn.parse(raw);
    if (r) { if (live) onScanHit(r); else onPhotoHit(r); return true; }
    return false;
  }
  async function decodeImageFile(file) {
    if (!file) return false;
    toast("Barcode wird gelesen …");
    var url = null; try { url = URL.createObjectURL(file); } catch (e) {}
    // 1) Native BarcodeDetector auf dem Standbild (offline, Android-Chrome/Edge).
    if (("BarcodeDetector" in window) && typeof createImageBitmap === "function") {
      try {
        var det = new window.BarcodeDetector({
          formats: ["code_39", "ean_13", "ean_8", "data_matrix", "code_128", "itf", "qr_code"]
        });
        var bmp = await createImageBitmap(file);
        var codes = await det.detect(bmp);
        try { if (bmp && bmp.close) bmp.close(); } catch (e) {}
        for (var i = 0; codes && i < codes.length; i++) {
          if (handleScanPayload(codes[i].rawValue || "")) {
            if (url) { try { URL.revokeObjectURL(url); } catch (e) {} }
            return true;
          }
        }
      } catch (e) { /* kein Treffer -> ZXing versuchen */ }
    }
    // 2) ZXing-Fallback (lazy per CDN, nur online).
    var reader = null;
    try {
      await loadZXing();
      reader = new window.ZXing.BrowserMultiFormatReader();
      var result = url ? await reader.decodeFromImageUrl(url) : null;
      if (result) {
        var raw = result.getText ? result.getText() : String(result);
        if (handleScanPayload(raw)) { try { reader.reset(); } catch (e) {} if (url) { try { URL.revokeObjectURL(url); } catch (e) {} } return true; }
      }
    } catch (e) { /* kein Code gefunden / offline */ }
    if (reader) { try { reader.reset(); } catch (e) {} }
    if (url) { try { URL.revokeObjectURL(url); } catch (e) {} }
    // Kein 1D-/2D-Code lesbar → denselben Schnappschuss per Texterkennung auf den
    // aufgedruckten Präparatenamen prüfen. So liest EIN Scan alles: PZN-Strichcode,
    // Data-Matrix und – als Rückfall – den Namen.
    toast("Kein Code erkannt – der Name wird per Texterkennung gelesen …");
    return runOCR(file);
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
      var nm = (e && e.name) || "";
      if (nm === "NotAllowedError" || nm === "SecurityError") {
        toast("Live-Kamera blockiert – häufig durch eine Bildschirm-Einblendung anderer Apps (Blaulichtfilter, Bildschirm-Dimmer, Chat-Blasen). Tippen Sie oben auf „Barcode / PZN fotografieren“ – das umgeht die Sperre.");
      } else if (nm === "NotReadableError" || nm === "AbortError") {
        toast("Kamera ist gerade von einer anderen App belegt. Bitte diese schließen – oder oben „Barcode / PZN fotografieren“ nutzen.");
      } else if (nm === "NotFoundError" || nm === "OverconstrainedError") {
        toast("Keine passende Kamera gefunden. Bitte oben „Barcode / PZN fotografieren“ nutzen oder die PZN eintippen.");
      } else {
        toast("Live-Kamera nicht möglich. Bitte oben „Barcode / PZN fotografieren“ nutzen oder die PZN eintippen.");
      }
      return;
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
          if (handleScanPayload(codes[i].rawValue || "", true)) return;
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
        if (result && scanning) handleScanPayload(result.getText ? result.getText() : String(result), true);
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

  // ---- „Tabs" entfernt ------------------------------------------------------
  // Suche UND Foto-Buttons stehen jetzt gleichzeitig auf der Seite (kein
  // Umschalter mehr). setTab bleibt als sanfter No-Op erhalten, damit die
  // bestehenden Aufrufer (setTab("manual") nach dem Hinzufügen/Reset/Boot)
  // unverändert funktionieren: es beendet nur eine evtl. laufende Live-Kamera
  // und setzt den Fokus zurück ins Suchfeld. Es blendet nichts mehr aus.
  function setTab(which) {
    stopScan();                       // No-Op ohne Live-Kamera-DOM
    if (which === "manual") {
      setTimeout(function () { var q = el("q"); if (q) q.focus(); }, 30);
    }
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
    // Tastatur-/Screenreader-Fokus auf die frische Ergebnis-Überschrift setzen
    // (preventScroll, damit das sanfte Scrollen nicht überschrieben wird).
    var hd = el("resHeading");
    if (hd && hd.focus) { try { hd.focus({ preventScroll: true }); } catch (e) { try { hd.focus(); } catch (x) {} } }
  }

  // Beschreibungstexte der DB sind in Abschnitte gegliedert („MECHANISMUS: …",
  // „KLINISCHE FOLGEN: …", „MASSNAHMEN: …"). Wir sortieren NUR um – kein Wort
  // wird erfunden oder umformuliert:
  //   „Was kann passieren?" ← KLINISCHE FOLGEN / KLINISCHES BILD
  //   „Was ist zu tun?"     ← MASSNAHMEN
  //   „Warum diese Warnung?" (aufklappbar) ← MECHANISMUS und alle übrigen Abschnitte
  var SEC_HAPPEN = { "KLINISCHE FOLGEN": 1, "KLINISCHES BILD": 1 };
  var SEC_TODO = { "MASSNAHMEN": 1 };
  function splitSections(text) {
    var out = { lead: [], happen: [], todo: [], why: [] };
    String(text || "").split(/\n\s*\n/).forEach(function (para) {
      para = para.trim(); if (!para) return;
      var m = /^([A-ZÄÖÜ][A-ZÄÖÜß0-9 \-\/&().]{2,40}):\s*([\s\S]*)$/.exec(para);
      if (!m) { out.lead.push(para); return; }
      var head = m[1].trim(), body = m[2].trim();
      if (SEC_HAPPEN[head]) out.happen.push(body);
      else if (SEC_TODO[head]) out.todo.push(body);
      else out.why.push({ head: head, body: body });
    });
    return out;
  }
  // Glyphen je Stufe – zusätzlich zur Farbe (farbenblind-tauglich):
  // 1 i · 2 ! · 3 !! · 4 × ; Doppelungen „=".
  // „ZEITLICHER VERLAUF" → „Zeitlicher Verlauf"; Kürzel wie FDA/EMA/COPD bleiben.
  function prettyHead(hd) {
    return hd.split(/([\s\-\/]+)/).map(function (w) {
      if (/^[A-Z]{2,4}$/.test(w) && !/^(BEI|DER|DIE|DAS|UND|ALS)$/.test(w)) return w;
      return w.charAt(0) + w.slice(1).toLowerCase();
    }).join("");
  }
  function sevGlyph(rank) { return rank >= 4 ? "×" : rank === 3 ? "!!" : rank === 2 ? "!" : rank === 1 ? "i" : ""; }
  function card(sevObj, title, o) {
    var rank = sevObj.rank || 0;
    var cls = o.cls || ("sev" + rank);
    // Schweregrad-Ring (rein optisch): Füllgrad = rank/4.
    var C = 100.53;                                              // Umfang 2·π·16
    var off = (C * (1 - Math.max(0, Math.min(4, rank)) / 4)).toFixed(2);
    var glyph = o.glyph != null ? o.glyph : sevGlyph(rank);
    var h = '<div class="res ' + cls + '"' + (o.key ? ' data-key="' + esc(o.key) + '"' : '') + '>';
    h += '<div class="head"><div class="ttl">' + (o.isNew ? '<span class="newtag">Neu</span>' : '') + esc(title) + '</div>';
    h += '<div class="sevmark">' +
      '<svg class="sevring" viewBox="0 0 40 40" aria-hidden="true" style="--ring-c:' + C + ';--ring-o:' + off + '">' +
      '<circle class="sevring-bg" cx="20" cy="20" r="16"/>' +
      '<circle class="sevring-fg" cx="20" cy="20" r="16" transform="rotate(-90 20 20)"/>' +
      '<text class="sevring-gl" x="20" y="20">' + esc(glyph) + '</text>' +
      '</svg>' +
      '<span class="sevmark-lb">' + esc(o.label || sevObj.label) + '</span></div></div>';
    if (o.pair) h += '<div class="pair">' + o.pair + '</div>';
    if (o.medtags) h += '<div class="medtags">' + o.medtags + '</div>';
    if (o.desc) {
      var sec = splitSections(o.desc);
      if (sec.lead.length) h += '<div class="desc">' + esc(sec.lead.join("\n\n")) + '</div>';
      if (sec.happen.length) h += '<div class="sec sec-happen"><div class="sec-h">Was kann passieren?</div><div class="sec-b">' + esc(sec.happen.join("\n\n")) + '</div></div>';
      if (sec.todo.length) h += '<div class="sec sec-todo"><div class="sec-h">Was ist zu tun?</div><div class="sec-b">' + esc(sec.todo.join("\n\n")) + '</div></div>';
      if (sec.why.length) {
        h += '<details class="why"><summary>Warum diese Warnung?</summary>';
        sec.why.forEach(function (w) {
          var hd = w.head === "MECHANISMUS" ? "Wie es dazu kommt (Mechanismus)" : prettyHead(w.head);
          h += '<div class="why-p"><b>' + esc(hd) + ':</b> ' + esc(w.body) + '</div>';
        });
        h += '</details>';
      }
    }
    if (o.sys) h += '<div class="sys">Betroffene Systeme: ' + esc(o.sys) + '</div>';
    if (o.rec) h += '<div class="rec"><b>Empfehlung:</b> ' + esc(o.rec) + '</div>';
    h += '</div>';
    return h;
  }
  function splitNames(s) { return String(s || "").split(/\s*[,;+/]\s*/).filter(Boolean); }

  // ---- Öffentliche FDA-Datenebene (lazy, separat) ---------------------------
  // Lädt die 0,6-MB-Datei mediscan-fda.json erst bei Bedarf (erste Analyse) und cached sie.
  function loadFDA() {
    if (fdaData) return Promise.resolve(fdaData);
    if (fdaPromise) return fdaPromise;
    fdaPromise = fetch(FDA_URL).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (j) { fdaData = j; return j; }).catch(function (e) {
      fdaPromise = null;           // Fehlschlag (z. B. offline & nicht gecached) → späterer Neuversuch möglich
      throw e;
    });
    return fdaPromise;
  }

  // Baut aus der aktuellen Auswahl den ergänzenden FDA-Block in #fdaPanel.
  // Bewusst: nur wörtliche Original-Angaben der US-FDA, KEINE eigene Bewertung/Schweregrade.
  function ensureFDA() {
    var host = el("fdaPanel");
    if (!host) return;
    var ids = selected.slice();
    loadFDA().then(function (j) {
      var items = (j && j.items) || {}, meta = (j && j.meta) || {};
      var rows = ids.map(function (id) {
        var rec = items[String(id)];
        if (!rec || !rec.text) return null;
        var m = MS.medById(id);
        return { name: m ? m.name : ("#" + id), ingr: m ? m.activeIngredient : "", rec: rec };
      }).filter(Boolean);
      if (!rows.length) { host.hidden = true; host.innerHTML = ""; return; }
      var hh = '<div class="card fda-card">';
      hh += '<h2>Ergänzend: US-FDA-Fachinformation <span class="n">' + rows.length + '</span></h2>';
      hh += '<p class="fda-src">Öffentliche Original-Angaben der US-Arzneimittelbehörde <b>FDA</b> – <b>englischsprachig</b> und <b>unverändert</b>. Ergänzende Quelle: von MediScan <u>nicht</u> bewertet oder in Schweregrade übersetzt; kann von deutschen Fachinformationen abweichen.</p>';
      rows.forEach(function (row) {
        hh += '<details class="fda-item"><summary>' + esc(row.name) +
          (row.ingr ? ' <span class="fda-ingr">' + esc(row.ingr) + '</span>' : '') + '</summary>';
        hh += '<div class="fda-text">' + esc(row.rec.text) + '</div>';
        var brand = (row.rec.brand && row.rec.brand.length) ? row.rec.brand.join(", ") : "";
        hh += '<div class="fda-cite">Quelle: openFDA drug/label · Abschnitt „' + esc(meta.field || "drug_interactions") +
          '" · Public Domain (U.S. Government work)' + (brand ? ' · FDA-Label: ' + esc(brand) : '') + '</div>';
        hh += '</details>';
      });
      hh += '<div class="fda-foot">Datenstand ' + esc(meta.retrieved || "") + ' · ' + esc(meta.source || "openFDA") + '</div>';
      hh += '</div>';
      host.innerHTML = hh;
      host.hidden = false;
    }).catch(function () {
      host.hidden = true; host.innerHTML = "";   // offline & nicht gecached → still verbergen, kein Fehler-Lärm
    });
  }

  function renderResults(r) {
    var iN = r.interactions.length, cN = r.complex.length, rN = r.risks.length;
    var dups = r.duplicates || [], dN = dups.length;
    // Höchste gefundene Einstufung (ganzes sev-Objekt) – speist das Ergebnis-Banner.
    var worstSev = null;
    r.interactions.concat(r.complex, r.risks).forEach(function (x) { if (!worstSev || x.sev.rank > worstSev.rank) worstSev = x.sev; });

    // Vergleich mit der letzten Prüfung: Schlüssel je Karte (Art|Titel|Medikament).
    // Nur sinnvoll, wenn sich die Auswahl mit der letzten überschneidet.
    var items = [];
    dups.forEach(function (d) { items.push({ k: "d|" + d.title + "|" + (d.names || []).join(","), t: d.title }); });
    r.interactions.forEach(function (it) { items.push({ k: "i|" + it.title + "|" + it.drug1 + "|" + it.drug2, t: it.title + " (" + it.drug1 + " + " + it.drug2 + ")" }); });
    r.complex.forEach(function (c) { items.push({ k: "c|" + c.title, t: c.title }); });
    r.risks.forEach(function (rk) { items.push({ k: "r|" + rk.title + "|" + rk.medName, t: rk.title + " (" + rk.medName + ")" }); });
    var last = lsGet(K(LS_LAST), null), prevKeys = null;
    if (last && last.keys && last.ids && last.ids.some(function (id) { return selected.indexOf(id) !== -1; })) {
      prevKeys = {}; last.keys.forEach(function (x) { prevKeys[x.k] = x.t; });
    }
    var nowKeys = {}; items.forEach(function (x) { nowKeys[x.k] = 1; });
    var isNew = function (k) { return !!prevKeys && !(k in prevKeys); };
    var gone = prevKeys ? Object.keys(prevKeys).filter(function (k) { return !nowKeys[k]; }).map(function (k) { return prevKeys[k]; }) : [];
    lsSet(K(LS_LAST), { ids: selected.slice(), keys: items.slice(0, 300), at: Date.now() });
    var ki = 0;
    function nextKey() { return items[ki++].k; }

    // Profil leer? Zeigen, welche Profil-Hinweise es zu dieser Auswahl gäbe
    // (nur Anzahl + Kategorie-Namen aus der DB, keine Inhalte).
    var profHint = "";
    if (!profile.length) {
      var allR = MS.analyze(selected, MS.RISK_CATEGORIES.map(function (c) { return c.key; })).risks;
      if (allR.length) {
        var cats = [];
        allR.forEach(function (x) { if (x.categoryLabel && cats.indexOf(x.categoryLabel) === -1) cats.push(x.categoryLabel); });
        profHint = '<div class="prof-hint"><span>Zu Ihrer Auswahl gibt es <b>' + allR.length + (allR.length === 1 ? ' Hinweis' : ' Hinweise') +
          '</b> für bestimmte Personengruppen' + (cats.length ? ' (' + esc(cats.slice(0, 5).join(", ")) + (cats.length > 5 ? ' …' : '') + ')' : '') +
          '. Geben Sie im Profil an, was auf Sie zutrifft.</span><button class="btn ghost small" id="toProfileBtn" type="button">Zum Profil</button></div>';
      }
    }

    var h = '<div class="card">';
    h += '<div class="res-head">'
      + '<h2 id="resHeading" tabindex="-1">Ergebnis</h2>'
      + '<div class="res-actions">'
      + '<button class="btn ghost small" id="plainBtn" type="button" aria-pressed="' + (plainOn() ? 'true' : 'false') + '">Einfache Ansicht</button>'
      + (window.speechSynthesis ? '<button class="btn ghost small" id="speakBtn" type="button">Vorlesen</button>' : '')
      + '<button class="btn ghost small" id="shareBtn" type="button">' + svgIcon("share") + 'Für Arzt/Apotheke</button>'
      + '<button class="btn ghost small" id="pdfBtn" type="button">' + svgIcon("download") + 'PDF-Bericht</button>'
      + '</div></div>';
    // Gesamt-Banner: berichtet nur, was die Referenzdatenbank enthält (keine eigene
    // klinische Bewertung – Label kommt unverändert aus der Engine).
    if (worstSev && iN + cN + rN > 0) {
      var totalN = iN + cN + rN;
      h += '<div class="verdict sev' + (worstSev.rank || 0) + '">' +
        '<span class="vicon" aria-hidden="true"></span>' +
        '<div class="vtx"><b>Höchste Einstufung: ' + esc(worstSev.label) + '</b>' +
        '<span>' + totalN + (totalN === 1 ? ' Eintrag' : ' Einträge') + ' in der Referenzdatenbank – Details unten. Besprechen Sie Auffälligkeiten mit Arzt oder Apotheke.</span></div></div>';
    }
    h += '<div class="stats">' +
      stat(selected.length, "Medikamente") +
      stat(iN, "Wechselwirkungen") +
      stat(cN, "Mehrfach") +
      stat(rN, "Risiken") + '</div>';
    if (gone.length) {
      h += '<div class="gone-note"><b>Seit der letzten Prüfung entfallen:</b> ' + esc(gone.slice(0, 6).join("; ")) + (gone.length > 6 ? ' … (+' + (gone.length - 6) + ')' : '') + '</div>';
    }
    h += profHint;

    if (iN + cN + rN + dN === 0) {
      h += '<div class="ok-note" style="margin-top:12px"><svg class="ico ico-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg><span>In der hinterlegten Datenbank wurden keine Wechselwirkungen, Risiken oder Doppelungen zu dieser Kombination gefunden. Das ist <u>keine</u> Garantie der Unbedenklichkeit – besprechen Sie Ihre Medikation mit Arzt/Apotheke.</span></div>';
    }
    h += '</div>';

    // Therapeutische Doppelungen: struktureller Hinweis (gleicher Wirkstoff /
    // gleiche Wirkstoffgruppe). Bewusst NICHT im klinischen Ergebnis-Banner oben
    // (keine erfundene Schweregrad-Bewertung), sondern als eigener, klar
    // gekennzeichneter Block direkt unter der Übersicht.
    if (dN) {
      h += '<div class="card"><h2>Mögliche Doppelungen <span class="n">' + dN + '</span></h2>';
      h += '<p class="small muted" style="margin:-2px 0 10px">Struktureller Hinweis aus den Stammdaten – gleicher Wirkstoff bzw. gleiche Wirkstoffgruppe. Keine klinische Bewertung; ob eine Doppelung gewollt ist, klären Sie bitte mit Arzt oder Apotheke.</p>';
      dups.forEach(function (d) {
        var tags = (d.names || []).map(function (nm) { return '<span class="medtag">' + esc(nm) + '</span>'; }).join("");
        var k = nextKey();
        h += card(d.sev, d.title, { medtags: tags, desc: d.description, glyph: "=", cls: d.type === "class" ? "sevinfo" : null, key: k, isNew: isNew(k) });
      });
      h += '</div>';
    }

    if (iN) {
      h += '<div class="card"><h2>Wechselwirkungen <span class="n">' + iN + '</span></h2>';
      r.interactions.forEach(function (it) {
        var k = nextKey();
        h += card(it.sev, it.title, {
          pair: esc(it.drug1) + '<span class="arrow">+</span>' + esc(it.drug2),
          desc: it.description, key: k, isNew: isNew(k)
        });
      });
      h += '</div>';
    }
    if (cN) {
      h += '<div class="card"><h2>Mehrfach-Wechselwirkungen <span class="n">' + cN + '</span></h2>';
      r.complex.forEach(function (c) {
        var tags = splitNames(c.drugNames).map(function (nm) { return '<span class="medtag">' + esc(nm) + '</span>'; }).join("");
        var k = nextKey();
        h += card(c.sev, c.title, { medtags: tags, desc: c.description, sys: c.affectedSystems, rec: c.recommendation, key: k, isNew: isNew(k) });
      });
      h += '</div>';
    }
    if (rN) {
      h += '<div class="card"><h2>Individuelle Patientenrisiken <span class="n">' + rN + '</span></h2>';
      r.risks.forEach(function (rk) {
        var pair = '<b>' + esc(rk.medName) + '</b>' + (rk.categoryLabel ? ' <span class="arrow">·</span>' + esc(rk.categoryLabel) : "") +
          (rk.riskCondition ? ' <span class="arrow">·</span>' + esc(rk.riskCondition) : "");
        var k = nextKey();
        h += card(rk.sev, rk.title, { pair: pair, desc: rk.description, rec: rk.recommendation, key: k, isNew: isNew(k) });
      });
      h += '</div>';
    }

    // Platzhalter für die ergänzende, öffentliche FDA-Ebene (wird lazy befüllt).
    h += '<section id="fdaPanel" class="fda-wrap" hidden></section>';

    var metaTxt = dbMetaText();
    h += '<div class="disclaimer" role="note" style="margin-top:6px"><b>⚠ Hinweis:</b> Diese Auswertung basiert auf einer kuratierten Referenzdatenbank (keine amtliche Arzneimitteldatenbank) und ersetzt keine ärztliche oder pharmazeutische Beratung. Angaben können unvollständig sein.'
      + (metaTxt ? '<br><span class="datasource">Datengrundlage: ' + esc(metaTxt) + '</span>' : '')
      + '</div>';

    el("results").innerHTML = h;
    animateCounts(el("results"));
    var pdf = el("pdfBtn");
    if (pdf) pdf.onclick = function () { loadFDA().then(function () { makePDF(r); }, function () { makePDF(r); }); };
    // „Für Arzt/Apotheke" teilen: bevorzugt die PDF-Datei über die Web-Share-API,
    // sonst nur Text, sonst in die Zwischenablage. Bewusst OHNE loadFDA-Umweg, damit
    // die Nutzergeste für navigator.share erhalten bleibt (ein await verliert sie).
    var sh = el("shareBtn");
    if (sh) {
      var canShare = !!navigator.share || !!(navigator.clipboard && navigator.clipboard.writeText);
      if (!canShare) sh.hidden = true;
      else sh.onclick = function () { shareReport(r); };
    }
    var tp = el("toProfileBtn");
    if (tp) tp.onclick = function () {
      var pc = el("profileCard");
      if (pc) { pc.scrollIntoView({ behavior: "smooth", block: "start" }); var f = pc.querySelector("button, input"); if (f) setTimeout(function () { try { f.focus({ preventScroll: true }); } catch (e) {} }, 400); }
    };
    var pb = el("plainBtn");
    if (pb) pb.onclick = function () {
      var on = !plainOn(); lsSet(LS_PLAIN, on); applyPlain();
      pb.setAttribute("aria-pressed", on ? "true" : "false");
    };
    var sp = el("speakBtn");
    if (sp) sp.onclick = function () { toggleSpeak(sp); };
    stopSpeak();
    ensureFDA();
  }
  // ---- Einfache Ansicht (größere Schrift, ohne Hintergrund-Details) ---------
  function plainOn() { return !!lsGet(LS_PLAIN, false); }
  function applyPlain() { document.body.classList.toggle("plain", plainOn()); }
  // ---- Vorlesen (Web Speech API, lokal im Browser) --------------------------
  // Liest Überschrift, Einstufung und die Abschnitte „Was kann passieren?" /
  // „Was ist zu tun?" – ausschließlich der angezeigte DB-Text.
  var speaking = false;
  function stopSpeak() {
    speaking = false;
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
    var b = el("speakBtn"); if (b) b.textContent = "Vorlesen";
  }
  function toggleSpeak(btn) {
    if (speaking) { stopSpeak(); return; }
    var root = el("results"); if (!root) return;
    var parts = [];
    var v = root.querySelector(".verdict .vtx b"); if (v) parts.push(v.textContent);
    var ok = root.querySelector(".ok-note span"); if (ok) parts.push(ok.textContent);
    var cards = root.querySelectorAll(".res");
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i], t = c.querySelector(".ttl"), lb = c.querySelector(".sevmark-lb"), pr = c.querySelector(".pair");
      var txt = (t ? t.textContent.replace(/^Neu/, "") : "") + (lb ? ". " + lb.textContent : "") + (pr ? ". " + pr.textContent.replace(/·/g, ",") : "") + ".";
      var lead = c.querySelector(".desc"); if (lead) txt += " " + lead.textContent;
      var secs = c.querySelectorAll(".sec");
      for (var j = 0; j < secs.length; j++) txt += " " + secs[j].querySelector(".sec-h").textContent + " " + secs[j].querySelector(".sec-b").textContent;
      var rec = c.querySelector(".rec"); if (rec) txt += " " + rec.textContent;
      parts.push(txt);
    }
    if (!parts.length) return;
    var synth = window.speechSynthesis;
    synth.cancel();
    speaking = true; btn.textContent = "Stopp";
    var voices = synth.getVoices ? synth.getVoices() : [];
    var de = voices.filter(function (x) { return /^de/i.test(x.lang); })[0];
    parts.forEach(function (p, idx) {
      var u = new SpeechSynthesisUtterance(p);
      u.lang = "de-DE"; if (de) u.voice = de; u.rate = 0.95;
      if (idx === parts.length - 1) u.onend = u.onerror = function () { if (speaking) stopSpeak(); };
      synth.speak(u);
    });
  }
  function stat(n, label) { return '<div class="stat"><b data-to="' + (n || 0) + '">' + n + '</b><span>' + esc(label) + '</span></div>'; }
  // Zahlen im Ergebnis kurz hochzählen (rein optisch; setzt bei reduzierter Bewegung sofort den Endwert).
  function animateCounts(root) {
    if (!root) return;
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var els = root.querySelectorAll(".stat b[data-to]"), i;
    for (i = 0; i < els.length; i++) {
      (function (b) {
        var to = parseInt(b.getAttribute("data-to"), 10) || 0;
        if (reduce || to <= 0 || !window.requestAnimationFrame) { b.textContent = to; return; }
        var dur = Math.min(900, 340 + to * 45), t0 = 0;
        b.textContent = "0";
        function tick(now) {
          if (!t0) t0 = now;
          var p = Math.min(1, (now - t0) / dur);
          b.textContent = Math.round((1 - Math.pow(1 - p, 3)) * to);
          if (p < 1) requestAnimationFrame(tick); else b.textContent = to;
        }
        requestAnimationFrame(tick);
      })(els[i]);
    }
  }

  // ---- PDF-Bericht (jsPDF, WinAnsi-sicher) ----------------------------------
  // Zeichen außerhalb Latin-1 vor dem Abschneiden umschreiben, statt sie still zu
  // verlieren: sonst wurde aus „β1-Blocker" „1-Blocker", aus „μ-Opioid" „-Opioid"
  // und Gedankenstriche/Anführungszeichen/Aufzählungspunkte fehlten im PDF.
  var PDF_MAP = { "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "κ": "kappa", "ω": "omega",
                  "μ": "\u00B5", "–": "-", "—": "-", "„": '"', "“": '"', "”": '"', "‚": "'", "‘": "'", "’": "'",
                  "…": "...", "•": "-" };
  function pdfSafe(s) {
    return String(s == null ? "" : s)
      .replace(/≥/g, ">=").replace(/≤/g, "<=")
      .replace(/[→↔⟷⟶⇄]/g, "->")
      .replace(/[⚠⬇]/g, "").replace(/ /g, " ")
      .replace(/[αβγδκωμ–—„“”‚‘’…•]/g, function (c) { return PDF_MAP[c]; })
      .replace(/[^\x00-\xFF]/g, "");
  }
  var SEVRGB = { 0: [117, 117, 117], 1: [56, 142, 60], 2: [245, 124, 0], 3: [229, 57, 53], 4: [183, 28, 28] };
  // onDoc(doc, fn) optional: statt zu speichern das fertige jsPDF-Dokument herausgeben
  // (wird vom Teilen-Weg genutzt, um dieselbe PDF als Datei zu verschicken).
  function makePDF(r, onDoc) {
    if (!window.jspdf || !window.jspdf.jsPDF) { toast("PDF-Bibliothek nicht geladen."); return; }
    var doc = new window.jspdf.jsPDF({ unit: "pt", format: "a4" });
    var PW = doc.internal.pageSize.getWidth(), PH = doc.internal.pageSize.getHeight();
    var M = 40, CW = PW - 2 * M, y = 0, page = 1;

    function foot() {
      doc.setFontSize(7.5); doc.setTextColor(150);
      doc.text(pdfSafe("MediScan – Informationswerkzeug, kein Ersatz für ärztliche Beratung."), M, PH - 24);
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
    var metaTxt = dbMetaText();
    if (metaTxt) { y += 4; line("Datengrundlage: kuratierte Referenzdatenbank (keine amtliche Arzneimitteldatenbank) · " + metaTxt, 8.5, "italic", [120, 120, 120]); }
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

    section("Mögliche Doppelungen", r.duplicates || [], function (d) {
      block(d.sev, d.title, (d.names || []).join(" + "), d.description, null, null);
    });
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

    if (r.interactions.length + r.complex.length + r.risks.length + (r.duplicates ? r.duplicates.length : 0) === 0) {
      line("In der hinterlegten Datenbank wurden keine Wechselwirkungen, Risiken oder Doppelungen zu dieser Kombination gefunden. Dies ist keine Garantie der Unbedenklichkeit.", 10, "normal", [40, 40, 40], 6);
    }

    // Ergänzende, öffentliche FDA-Angaben (nur falls bereits geladen; englisch, unverändert).
    if (fdaData && fdaData.items) {
      var fdaRows = selected.map(function (id) {
        var rec = fdaData.items[String(id)];
        if (!rec || !rec.text) return null;
        var m = MS.medById(id); return { name: m ? m.name : ("#" + id), text: rec.text };
      }).filter(Boolean);
      if (fdaRows.length) {
        ensure(30);
        doc.setDrawColor(219, 232, 230); doc.line(M, y, M + CW, y); y += 12;
        line("Ergänzend: US-FDA-Fachinformation (" + fdaRows.length + ")", 13, "bold", [0, 77, 64], 2);
        line("Öffentliche Original-Angaben der US-FDA, englischsprachig und unverändert. Von MediScan nicht bewertet oder in Schweregrade übersetzt; kann von deutschen Fachinfos abweichen.", 8.5, "italic", [110, 110, 110], 4);
        fdaRows.forEach(function (row) {
          ensure(20);
          line(row.name, 10.5, "bold", [0, 90, 80]);
          line(row.text, 9, "normal", [51, 64, 62], 4);
        });
        var fmeta = fdaData.meta || {};
        line("Quelle: " + (fmeta.source || "openFDA drug/label") + " · Public Domain · Datenstand " + (fmeta.retrieved || ""), 8, "italic", [130, 130, 130], 6);
      }
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
    if (typeof onDoc === "function") { onDoc(doc, fn); return; }
    doc.save(fn);
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  // ---- Bericht teilen („Für Arzt/Apotheke") --------------------------------
  // Kompakte Text-Zusammenfassung des Ergebnisses (für Web-Share-Text bzw. als
  // Zwischenablage-Rückfall). Nur, was in der Referenzdatenbank steht – keine Wertung.
  function reportText(r) {
    var L = [];
    L.push("MediScan – Wechselwirkungs-Analyse");
    var mt = dbMetaText(); if (mt) L.push(mt);
    L.push("");
    var meds = selected.map(function (id) { var m = MS.medById(id); return m ? (m.name + " (" + m.activeIngredient + ")") : ("#" + id); });
    L.push("Medikamente (" + meds.length + "):");
    meds.forEach(function (m) { L.push("• " + m); });
    if (profile.length) {
      var labs = profile.map(function (k) { var c = MS.RISK_CATEGORIES.filter(function (x) { return x.key === k; })[0]; return c ? c.label : k; });
      L.push("Patientenprofil: " + labs.join(", "));
    }
    L.push("");
    var iN = r.interactions.length, cN = r.complex.length, rN = r.risks.length, dN = (r.duplicates || []).length;
    var worst = null;
    r.interactions.concat(r.complex, r.risks).forEach(function (x) { if (!worst || x.sev.rank > worst.rank) worst = x.sev; });
    if (worst && iN + cN + rN > 0) L.push("Höchste Einstufung: " + worst.label + " (" + (iN + cN + rN) + (iN + cN + rN === 1 ? " Eintrag" : " Einträge") + ")");
    L.push("Wechselwirkungen: " + iN + " · Mehrfach: " + cN + " · Patientenrisiken: " + rN + " · Mögliche Doppelungen: " + dN);
    L.push("");
    function add(title, items, fmt) {
      if (!items || !items.length) return;
      L.push(title + ":");
      items.forEach(function (it) { L.push("– [" + it.sev.label + "] " + fmt(it)); });
      L.push("");
    }
    add("Mögliche Doppelungen", r.duplicates || [], function (d) { return d.title + " (" + (d.names || []).join(" + ") + ")"; });
    add("Wechselwirkungen", r.interactions, function (it) { return it.drug1 + " + " + it.drug2 + ": " + it.title; });
    add("Mehrfach-Wechselwirkungen", r.complex, function (c) { return splitNames(c.drugNames).join(" + ") + ": " + c.title; });
    add("Individuelle Patientenrisiken", r.risks, function (rk) { return rk.medName + (rk.categoryLabel ? " (" + rk.categoryLabel + ")" : "") + ": " + rk.title; });
    L.push("Hinweis: MediScan ist ein Informationswerkzeug und ersetzt keine ärztliche oder pharmazeutische Beratung.");
    return L.join("\n");
  }
  function copyReport(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast("Bericht in die Zwischenablage kopiert."); },
        function () { toast("Teilen wird von diesem Gerät nicht unterstützt."); });
    } else { toast("Teilen wird von diesem Gerät nicht unterstützt."); }
  }
  function shareTextOrCopy(title, text) {
    if (navigator.share) {
      navigator.share({ title: title, text: text }).catch(function (e) {
        if (e && e.name === "AbortError") return;   // Nutzer hat abgebrochen
        copyReport(text);
      });
    } else { copyReport(text); }
  }
  function shareReport(r) {
    var title = "MediScan – Wechselwirkungs-Analyse";
    var text = reportText(r);
    // 1) Bevorzugt die PDF-Datei teilen (bestes Ergebnis für Praxis/Apotheke).
    if (navigator.share && navigator.canShare && window.File) {
      makePDF(r, function (doc, fn) {
        try {
          var file = new File([doc.output("blob")], fn, { type: "application/pdf" });
          if (navigator.canShare({ files: [file] })) {
            navigator.share({ files: [file], title: title, text: text }).catch(function (e) {
              if (e && e.name === "AbortError") return;
              shareTextOrCopy(title, text);
            });
            return;
          }
        } catch (e) {}
        shareTextOrCopy(title, text);   // Datei-Freigabe nicht möglich → Text
      });
      return;
    }
    // 2) Kein Datei-Share → Text teilen bzw. kopieren.
    shareTextOrCopy(title, text);
  }

  // ---- Verdrahtung ----------------------------------------------------------
  function wire() {
    // (Die früheren Tab-Buttons #tab-manual/#tab-scan gibt es nicht mehr –
    //  beide Eingabewege sind dauerhaft sichtbar, daher keine Klick-Verdrahtung.)
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

    // Pläne & Erinnerungen
    var spb = el("savePlanBtn"); if (spb) spb.addEventListener("click", savePlanFromSelection);
    var pl = el("planList");
    if (pl) pl.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-act]"); if (!b) return;
      var id = b.getAttribute("data-id"), act = b.getAttribute("data-act");
      if (act === "load") loadPlan(id);
      else if (act === "del") deletePlan(id);
      else if (act === "rename") renamePlan(id);
      else if (act === "toggle") { openPlan = (openPlan === id ? null : id); renderPlans(); }
      else if (act === "addtime") { var tin = el("tin_" + id); addTime(id, tin ? tin.value : ""); }
      else if (act === "rmtime") removeTime(id, b.getAttribute("data-t"));
      else if (act === "ics") exportICS(id);
      else if (act === "notify") toggleNotify(id);
      else if (act === "medpdf") makeMedPlanPDF(id);
    });
    if (pl) pl.addEventListener("change", function (e) {
      var t = e.target; if (!t.classList || !t.classList.contains("dose-in")) return;
      setDose(t.getAttribute("data-pid"), t.getAttribute("data-mid"), t.getAttribute("data-f"), t.value);
    });

    // Personen & Sicherung
    var psel = el("personSel"); if (psel) psel.addEventListener("change", function () { switchPerson(psel.value); });
    var pa = el("personAdd"); if (pa) pa.addEventListener("click", addPerson);
    var pr = el("personRen"); if (pr) pr.addEventListener("click", renamePerson);
    var pd = el("personDel"); if (pd) pd.addEventListener("click", deletePerson);
    var bex = el("backupExport"); if (bex) bex.addEventListener("click", exportBackup);
    var bim = el("backupImport"), bf = el("backupFile");
    if (bim && bf) {
      bim.addEventListener("click", function () { try { bf.click(); } catch (x) {} });
      bf.addEventListener("change", function (e) { var f = e.target.files && e.target.files[0]; try { e.target.value = ""; } catch (x) {} importBackup(f); });
    }

    el("toggles").addEventListener("click", function (e) {
      var b = e.target.closest("button.toggle[data-key]"); if (b) toggleProfile(b.getAttribute("data-key"));
    });

    // Zwei Wege in denselben Decoder (umgehen die Live-Berechtigungssperre):
    //  • „Foto aufnehmen"  → Input #barfileCam mit capture="environment" (Kamera)
    //  • „Aus Galerie …"   → Input #barfileGal ohne capture (vorhandenes Bild)
    // Beide werden per .click() aus einer echten Nutzergeste geöffnet – das
    // funktioniert auch bei display:none und auf Samsung Internet (ein <label for=>
    // auf einen `hidden`-Input tut das dort nicht). Ein <button> feuert click auch
    // per Enter/Leertaste (A11y). Ein einzelner Input kann beides NICHT zuverlässig:
    // moderne Android-Versionen zwingen accept="image/*" ohne capture in den Foto-
    // Picker (nur Galerie) – deshalb zwei getrennte Inputs.
    function wirePhotoInput(btnId, inputId) {
      var btn = el(btnId), inp = el(inputId);
      if (!btn || !inp) return;
      btn.addEventListener("click", function () { warmOCR(); try { inp.click(); } catch (x) {} });
      inp.addEventListener("change", function (e) {
        var f = e.target.files && e.target.files[0];
        try { e.target.value = ""; } catch (x) {} // dasselbe Motiv erneut wählen erlauben
        if (f) decodeImageFile(f);
      });
    }
    wirePhotoInput("scanCamBtn", "barfileCam");   // Kamera
    wirePhotoInput("scanGalBtn", "barfileGal");   // Galerie

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
    // Beispiel für Erstnutzer: zwei häufige Schmerzmittel (Treffer kommen aus der DB-Suche).
    var exb = el("exampleBtn");
    if (exb) exb.addEventListener("click", function () {
      var ids = [];
      ["Aspirin", "Ibuprofen"].forEach(function (n) { var hit = MS.search(n, 1)[0]; if (hit) ids = ids.concat(hit.ids); });
      if (!ids.length) { toast("Beispiel nicht gefunden."); return; }
      addByIds(ids); analyze();
    });
  }

  // ---- Start ----------------------------------------------------------------
  function boot() {
    if (!MS) { toast("Fehler: Engine nicht geladen."); return; }
    applyPlain();
    profile = lsGet(K(LS_PROF), []) || [];
    pznMap = lsGet(LS_PZN, {}) || {};
    plans = lsGet(K(LS_PLANS), []) || [];
    renderPersons();
    renderToggles();
    wire();
    var btn = el("analyzeBtn"); btn.disabled = true; btn.textContent = "Datenbank wird geladen …";
    MS.load(DB_URL).then(function () {
      ready = true;
      var meta = MS.meta();
      // gespeicherte Auswahl auf noch existierende IDs filtern
      selected = (lsGet(K(LS_SEL), []) || []).map(function (x) { return parseInt(x, 10); }).filter(function (id) { return !!MS.medById(id); });
      lsSet(K(LS_SEL), selected);
      renderChips();
      renderPlans(); scheduleAllReminders();
      btn.disabled = false; updateAnalyzeBtn();
      var ex = el("exampleBox"); if (ex) ex.hidden = !!selected.length;
      setTab("manual");
    }).catch(function (err) {
      btn.textContent = "Datenbank nicht verfügbar";
      toast("Datenbank konnte nicht geladen werden. Bitte Seite neu laden.");
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
