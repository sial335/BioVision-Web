/*
 * app.js - the page: photo input, counting square, OpenCV.js circle detection,
 * results, saved history and CSV export. All counting rules live in core.js.
 *
 * UPGRADE (Avishkar), marked NEW:
 *   - counted-square size (1 mm / 0.2 mm) so cells/mL is calculated correctly
 *   - tap to remove or add a cell (human check of the automatic count)
 *   - accuracy check: app count vs manual count, with graphs for the poster
 *   - growth curve with doubling time (from saved readings of one experiment)
 *   - one-page report (image or Save as PDF)
 *   - yeast kept as an optional (beta) mode
 * The new panels are created by this file, so index.html needs no changes.
 * Needs the matching core.js and report.js (report.js loads by itself).
 */
(function () {
  "use strict";

  const $ = id => document.getElementById(id);

  const MAX_SIDE = 1600;                 // phone photos are shrunk to this size (same as the Streamlit app)
  const DEFAULTS = {                     // same starting values as cell_detection.py / viability.py
    rbc:    { minR: 8,  maxR: 16, sens: 18 },
    pollen: { minR: 24, maxR: 44, sens: 26 },
    yeast:  { minR: 6,  maxR: 14, sens: 18 }     // NEW: provisional, tune on real yeast photos
  };
  const STORE_KEY = "cellcounter_history_v1";
  const PREF_KEY = "cellcounter_prefs_v1";       // NEW

  let mode = "rbc";
  let cvReady = false;
  let hasImage = false;
  let lastResult = null;
  let showDemoGrowth = false;                    // NEW
  const srcCanvas = document.createElement("canvas");   // full (resized) photo

  const isStain = () => Core.isStainMode(mode);

  // made-up data, only for the "demo curve" button (always labelled as demo)
  const DEMO_GROWTH = { times: [0, 1, 2, 3, 4, 5, 6, 7],
                        counts: [1.0e5, 1.1e5, 1.8e5, 3.5e5, 7.0e5, 1.3e6, 1.9e6, 2.0e6] };

  // ---------------------------------------------------------------
  // OpenCV.js loading (works with the classic and the Promise build)
  // ---------------------------------------------------------------
  function markReady() {
    cvReady = true;
    $("status").textContent = "Ready (offline)";
    $("status").className = "badge ok";
  }

  function waitForCv() {
    const t0 = Date.now();
    (function poll() {
      if (typeof cv !== "undefined" && cv) {
        if (cv.Mat) { markReady(); return; }
        if (typeof cv.then === "function") {
          cv.then(function (m) { window.cv = m; markReady(); });   // callback returns nothing on purpose
          return;
        }
        cv.onRuntimeInitialized = markReady;
        return;
      }
      if (Date.now() - t0 > 90000) {
        $("status").textContent = "OpenCV did not load";
        $("status").className = "badge bad";
        return;
      }
      setTimeout(poll, 150);
    })();
  }

  // ---------------------------------------------------------------
  // small UI helpers
  // ---------------------------------------------------------------
  function msg(text) { $("msg").textContent = text; }

  function bindRange(id, outId) {
    const el = $(id), out = $(outId);
    const upd = () => { out.textContent = el.value; };
    el.addEventListener("input", upd);
    upd();
  }

  function currentSquare() {
    return Core.squareFromPercent(
      srcCanvas.width, srcCanvas.height,
      +$("left").value, +$("top").value, +$("width").value, +$("height").value
    );
  }

  function drawView() {
    if (!hasImage) return;
    const c = $("view");
    c.width = srcCanvas.width;
    c.height = srcCanvas.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(srcCanvas, 0, 0);
    const [x, y, w, h] = currentSquare();
    ctx.lineWidth = Math.max(3, c.width / 250);
    ctx.strokeStyle = "#00e676";
    ctx.strokeRect(x, y, w, h);
  }

  function applyMode(newMode) {
    mode = newMode;
    const d = DEFAULTS[mode];
    $("minR").value = d.minR; $("maxR").value = d.maxR; $("sens").value = d.sens;
    ["minR", "maxR", "sens"].forEach(id => $(id).dispatchEvent(new Event("input")));
    document.querySelectorAll(".pollenOnly").forEach(el => { el.hidden = !isStain(); });
    $("results").hidden = true;
    lastResult = null;
  }

  // ---------------------------------------------------------------
  // photo loading
  // ---------------------------------------------------------------
  async function loadFile(file) {
    if (!file) return;
    msg("Loading photo\u2026");
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      try { bmp = await createImageBitmap(file); }
      catch (e2) { msg("Could not read this photo."); return; }
    }
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    srcCanvas.width = Math.round(bmp.width * scale);
    srcCanvas.height = Math.round(bmp.height * scale);
    srcCanvas.getContext("2d").drawImage(bmp, 0, 0, srcCanvas.width, srcCanvas.height);
    if (bmp.close) bmp.close();

    hasImage = true;
    $("viewSection").hidden = false;
    $("results").hidden = true;
    drawView();
    msg("Photo loaded. Position the green box, then press Count cells.");
    $("viewSection").scrollIntoView({ behavior: "smooth" });
  }

  // ---------------------------------------------------------------
  // detection (OpenCV.js) + counting (core.js)
  // ---------------------------------------------------------------
  function houghCircles(imageData, minR, maxR, sens) {
    const src = cv.matFromImageData(imageData);
    const gray = new cv.Mat();
    const circles = new cv.Mat();
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(7, 7), 0, 0, cv.BORDER_DEFAULT);
      const minDist = Math.max(8, Math.trunc(1.6 * minR));
      cv.HoughCircles(gray, circles, cv.HOUGH_GRADIENT, 1.2, minDist, 60, sens,
                      Math.trunc(minR), Math.trunc(maxR));
      const d = circles.data32F, out = [];
      for (let i = 0; i < circles.cols; i++) {
        out.push({ x: d[i * 3], y: d[i * 3 + 1], r: d[i * 3 + 2] });
      }
      return out;
    } finally {
      src.delete(); gray.delete(); circles.delete();
    }
  }

  function runCount() {
    if (!hasImage) { msg("Take or choose a photo first."); return; }
    if (!cvReady) { msg("OpenCV is still loading, try again in a moment."); return; }

    const btn = $("btnCount");
    btn.disabled = true; btn.textContent = "Counting\u2026";

    // let the button repaint before the heavy work
    setTimeout(function () {
      try {
        const [x, y, w, h] = currentSquare();
        const crop = srcCanvas.getContext("2d").getImageData(x, y, w, h);
        const minR = +$("minR").value, maxR = +$("maxR").value, sens = +$("sens").value;

        const circles = houghCircles(crop, minR, Math.max(maxR, minR + 1), sens);
        const res = Core.process(circles, crop.data, w, h, { mode: mode, margin: +$("margin").value });

        lastResult = {
          res: res, crop: crop, square: [x, y, w, h],
          params: { minR: minR, maxR: maxR, sens: sens },
          blur: Core.blurScore(crop.data, w, h),          // NEW
          autoTotal: res.total,                           // NEW: the app's own count, before any tap corrections
          added: 0, removed: 0
        };
        drawOutput();
        updateMetrics();
        $("results").hidden = false;
        $("results").scrollIntoView({ behavior: "smooth" });
      } catch (e) {
        msg("Counting failed: " + (e && e.message ? e.message : e));
      } finally {
        btn.disabled = false; btn.textContent = "Count cells";
      }
    }, 30);
  }

  // draws the cropped photo with the rings (called again after every tap correction)
  function drawOutput() {
    const lr = lastResult, res = lr.res, crop = lr.crop;
    const out = $("out");
    out.width = crop.width; out.height = crop.height;
    const ctx = out.getContext("2d");
    ctx.putImageData(crop, 0, 0);

    const lw = Math.max(2, out.width / 300);
    function ring(c, colour, width) {
      ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, 2 * Math.PI);
      ctx.lineWidth = width; ctx.strokeStyle = colour; ctx.stroke();
    }
    res.excluded.forEach(c => ring(c, "#ffeb3b", Math.max(1, lw / 2)));
    res.objects.forEach(o => ring(o, o.manual ? "#00b0ff" : (o.label === "dead" ? "#ff1744" : "#00e676"), lw));
  }

  function recount(res) {
    res.live = res.objects.filter(o => o.label !== "dead").length;
    res.dead = res.objects.filter(o => o.label === "dead").length;
    res.total = res.live + res.dead;
    res.viability = res.total ? 100 * res.live / res.total : 0;
  }

  // numbers under the picture; called after counting, after taps, and when the inputs change
  function updateMetrics() {
    const lr = lastResult;
    if (!lr) return;
    const res = lr.res;
    $("mTotal").textContent = res.total;
    $("mLive").textContent = res.live;
    $("mDead").textContent = res.dead;
    $("mViab").textContent = res.viability.toFixed(1) + "%";

    const squares = Math.max(1, +$("squares").value || 1);
    const dilution = Math.max(1, +$("dilution").value || 1);
    const side = +$("xSide").value || 1;                                  // NEW
    const conc = Core.concentration(res.total, squares, dilution, side);
    $("conc").textContent = "Concentration: " + Math.round(conc).toLocaleString() +
      " cells/mL (count / squares / volume of one " + side + " mm square x dilution). " +
      "Ignored at right/bottom border: " + res.excluded.length + ".";

    const calibrate = $("xCalib").checked;                                // NEW
    lr.umPerPx = calibrate ? Core.umPerPx(lr.square[2], side) : null;
    lr.stats = calibrate && res.objects.length ? Core.sizeStats(res.objects, lr.umPerPx) : null;
    lr.quality = { blurScore: lr.blur, touchingFraction: Core.touchingFraction(res.objects), nCells: res.total };
    lr.conc = conc; lr.squares = squares; lr.dilution = dilution; lr.side = side;

    const note = Core.qualityLine(lr.quality);
    $("xEditInfo").textContent = "Automatic count: " + lr.autoTotal + ". Added by tap: " + lr.added +
      ", removed by tap: " + lr.removed + "." + (note ? " Note: " + note : "");
  }

  // tap on the result picture: remove the circle you tap, or add a cell where there is none
  function onOutputTap(ev) {
    const lr = lastResult;
    if (!lr) return;
    const out = $("out"), rect = out.getBoundingClientRect();
    const x = (ev.clientX - rect.left) * out.width / rect.width;
    const y = (ev.clientY - rect.top) * out.height / rect.height;
    const objs = lr.res.objects;
    let idx = -1, best = Infinity;
    objs.forEach((o, i) => {
      const d = Math.hypot(o.x - x, o.y - y);
      if (d <= o.r * 1.3 && d < best) { best = d; idx = i; }
    });
    if (idx >= 0) {
      objs.splice(idx, 1); lr.removed++;
    } else {
      const radii = objs.map(o => o.r).sort((a, b) => a - b);
      const r = radii.length ? radii[Math.floor(radii.length / 2)] : (+$("minR").value + +$("maxR").value) / 2;
      objs.push({ id: objs.length + 1, x: x, y: y, r: r, blueness: 0, label: "live", manual: true });
      lr.added++;
    }
    recount(lr.res);
    drawOutput();
    updateMetrics();
  }

  // ---------------------------------------------------------------
  // saved results + CSV export (stored on this device only)
  // ---------------------------------------------------------------
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); }
    catch (e) { return []; }
  }
  function storeHistory(list) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); return true; }
    catch (e) { msg("Could not save on this device (storage blocked)."); return false; }
  }
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); }
    catch (e) { return {}; }
  }
  function savePrefs() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({
        side: $("xSide").value, calib: $("xCalib").checked, exp: $("xExp").value
      }));
    } catch (e) { /* ignore */ }
  }

  function renderHistory() {
    const list = loadHistory();
    $("historySection").hidden = list.length === 0;
    const box = $("history");
    box.textContent = "";
    list.slice().reverse().forEach(function (r) {
      const d = document.createElement("div");
      d.className = "item";
      d.textContent = r.time + " | " + r.cell_type + " | total " + r.total +
        (r.cell_type === "pollen" || r.cell_type === "yeast" ? " (live " + r.live + ", dead " + r.dead + ", " + r.viability_percent + "%)" : "") +
        (r.manual_count !== "" && r.manual_count != null ? " | manual " + r.manual_count : "") +
        (r.experiment ? " | " + r.experiment + (r.hours !== "" && r.hours != null ? " @ " + r.hours + " h" : "") : "") +
        " | " + r.cells_per_mL + " cells/mL";
      box.appendChild(d);
    });
  }

  function saveResult() {
    if (!lastResult) return;
    const r = lastResult, res = r.res;
    const manual = $("manual").value;
    const hours = $("xHours").value;
    const list = loadHistory();
    list.push({
      time: new Date().toISOString().slice(0, 19).replace("T", " "),
      cell_type: mode,
      total: res.total,
      auto_total: r.autoTotal,                                             // NEW
      edits_added: r.added, edits_removed: r.removed,                      // NEW
      live: isStain() ? res.live : "",
      dead: isStain() ? res.dead : "",
      viability_percent: isStain() ? res.viability.toFixed(1) : "",
      dilution: r.dilution,
      squares: r.squares,
      square_side_mm: r.side,                                              // NEW
      cells_per_mL: Math.round(r.conc),
      manual_count: manual === "" ? "" : +manual,
      experiment: $("xExp").value.trim(),                                  // NEW
      hours: hours === "" ? "" : +hours,                                   // NEW
      um_per_px: r.umPerPx ? +r.umPerPx.toFixed(4) : "",                   // NEW
      mean_diameter_um: r.stats ? +r.stats.meanUm.toFixed(2) : "",         // NEW
      blur_score: Math.round(r.blur),                                      // NEW
      touching_pct: Math.round(100 * r.quality.touchingFraction),          // NEW
      sq_x: r.square[0], sq_y: r.square[1], sq_w: r.square[2], sq_h: r.square[3],
      min_radius: r.params.minR, max_radius: r.params.maxR, sensitivity: r.params.sens,
      blue_margin: isStain() ? +$("margin").value : ""
    });
    if (storeHistory(list)) {
      renderHistory(); refreshGrowth(); refreshAccuracy();
      msg("Saved. Use Export all (CSV) to download every saved result.");
    }
  }

  function exportCSV() {
    const list = loadHistory();
    if (!list.length) { msg("Nothing saved yet."); return; }
    const cols = ["time", "cell_type", "total", "auto_total", "edits_added", "edits_removed",
                  "live", "dead", "viability_percent", "dilution", "squares", "square_side_mm",
                  "cells_per_mL", "manual_count", "experiment", "hours", "um_per_px", "mean_diameter_um",
                  "blur_score", "touching_pct", "sq_x", "sq_y", "sq_w", "sq_h",
                  "min_radius", "max_radius", "sensitivity", "blue_margin"];
    const blob = new Blob([Core.toCSV(list, cols)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cell_counts.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------------------------------------------------------------
  // NEW: growth curve (saved readings that share an experiment name and have a time in hours)
  // ---------------------------------------------------------------
  function growthPoints(expName) {
    if (!expName) return null;
    const byHour = {};
    loadHistory().forEach(function (r) {
      if (r.experiment === expName && r.hours !== "" && r.hours != null && +r.cells_per_mL > 0) {
        (byHour[r.hours] = byHour[r.hours] || []).push(+r.cells_per_mL);
      }
    });
    const hours = Object.keys(byHour).map(Number).sort((a, b) => a - b);
    return {
      times: hours,
      counts: hours.map(h => byHour[h].reduce((a, b) => a + b, 0) / byHour[h].length),   // replicates are averaged
      replicates: hours.map(h => byHour[h].length)
    };
  }

  let growthCanvas = null;
  function refreshGrowth() {
    const box = $("xGrowthBox"), info = $("xGrowthInfo");
    if (!box) return;
    box.textContent = "";
    growthCanvas = null;
    const name = $("xExp").value.trim();
    let g = null, demo = false;
    if (showDemoGrowth) { g = DEMO_GROWTH; demo = true; }
    else {
      const p = growthPoints(name);
      if (p && p.times.length >= 3) g = p;
      else {
        info.textContent = name
          ? "Experiment \"" + name + "\" has " + (p ? p.times.length : 0) + " time point(s). Save at least 3 readings at different times (hours) to draw the curve."
          : "Type an experiment name and a time in hours, then save readings at several times to draw the curve.";
        return;
      }
    }
    if (!window.Report) { info.textContent = "Loading report tools\u2026"; return; }
    const dh = Core.doublingTime(g.times, g.counts);
    const labels = Core.detectPhase(g.times, g.counts);
    info.textContent = (demo ? "DEMO DATA (made up). " : "") + "Latest phase: " + labels[labels.length - 1] +
      (dh ? ". Doubling time about " + dh.toFixed(1) + " h." : ". Doubling time could not be calculated.") +
      " Doubling time makes sense only for a growing culture such as yeast.";
    growthCanvas = Report.buildGrowth({ growth: g, doublingH: dh, demo: demo,
      title: demo ? "Growth curve (demo)" : "Growth curve: " + name });
    growthCanvas.style.maxWidth = "100%";
    box.appendChild(growthCanvas);
  }

  // ---------------------------------------------------------------
  // NEW: accuracy check (app's own count vs your manual count)
  // ---------------------------------------------------------------
  let accuracyCanvas = null;
  function refreshAccuracy() {
    const box = $("xValBox"), text = $("xValText");
    if (!box) return;
    box.textContent = "";
    accuracyCanvas = null;
    const type = $("xValType").value;
    const rows = loadHistory().filter(r => r.cell_type === type && r.manual_count !== "" && r.manual_count != null && +r.manual_count > 0);
    const app = rows.map(r => (r.auto_total !== "" && r.auto_total != null) ? +r.auto_total : +r.total);
    const manual = rows.map(r => +r.manual_count);
    if (rows.length < 3) {
      text.textContent = "Images with a manual count saved for " + type + ": " + rows.length +
        ". Enter your manual count before saving; at least 3 are needed, 20 or more is better.";
      return;
    }
    const s = Core.validate(app, manual);
    text.textContent = "n = " + s.n + " images. Mean absolute error " + s.mape.toFixed(1) + "%, r\u00B2 = " + s.r2.toFixed(3) +
      ", bias " + s.bias.toFixed(1) + " cells (limits of agreement " + s.loa[0].toFixed(1) + " to " + s.loa[1].toFixed(1) +
      "). Uses the app's own count, before any tap corrections.";
    if (!window.Report) return;
    accuracyCanvas = Report.buildValidation({ app: app, manual: manual, stats: s,
      title: "Accuracy (" + type + "): app count vs manual count" });
    accuracyCanvas.style.maxWidth = "100%";
    box.appendChild(accuracyCanvas);
  }

  // ---------------------------------------------------------------
  // NEW: one-page report
  // ---------------------------------------------------------------
  function buildReport() {
    if (!lastResult) { msg("Count a photo first."); return null; }
    if (!window.Report) { msg("Report tools are still loading, try again."); return null; }
    const lr = lastResult, res = lr.res, name = $("xExp").value.trim();
    const p = growthPoints(name);
    const growth = p && p.times.length >= 3 ? { times: p.times, counts: p.counts } : null;
    let phase = null, dh = null;
    if (growth) {
      const labels = Core.detectPhase(growth.times, growth.counts);
      phase = labels[labels.length - 1];
      dh = Core.doublingTime(growth.times, growth.counts);
    }
    const lines = Core.insightLines(mode, lr.quality, lr.stats, {
      viability: isStain() ? res.viability : null,
      phase: mode === "yeast" ? phase : null, doublingH: dh });
    return Report.build({
      sampleType: mode, title: name || "Single count",
      timestamp: new Date().toISOString().slice(0, 16).replace("T", " "),
      concentrationPerMl: lr.conc, total: res.total, viability: isStain() ? res.viability : null,
      stats: lr.stats, quality: lr.quality, annotated: $("out"),
      growth: growth, doublingH: dh, lines: lines,
      dilution: lr.dilution, squares: lr.squares, squareSideMm: lr.side, borderRule: true
    });
  }

  // ---------------------------------------------------------------
  // NEW: panels created from here (no change to index.html needed)
  // ---------------------------------------------------------------
  function buildPanels() {
    const prefs = loadPrefs();
    const panel = document.createElement("section");
    panel.id = "xPanel";
    panel.style.cssText = "margin:12px 0;padding:12px;border:1px solid rgba(128,128,128,.4);border-radius:10px";
    panel.innerHTML =
      '<h3 style="margin:0 0 8px">Accuracy tools and report</h3>' +
      '<p><label>Counted square side: <select id="xSide">' +
      '<option value="1">1 mm (large square)</option><option value="0.2">0.2 mm (small square)</option></select></label><br>' +
      '<small>Cells/mL depends on this. Choose the square your green box covers.</small></p>' +
      '<p><label><input type="checkbox" id="xCalib"> Green box covers exactly one counted square (gives sizes in \u00B5m)</label></p>' +
      '<p><small>Tap a circle in the result picture to remove it, or tap an empty spot to add a cell (blue circle).</small> ' +
      '<button type="button" id="xReset">Reset to automatic count</button></p>' +
      '<p id="xEditInfo"><small></small></p>' +
      '<p><label>Experiment name: <input id="xExp" type="text" placeholder="e.g. Growth run 1"></label> ' +
      '<label>Time (h): <input id="xHours" type="number" min="0" step="0.5" style="width:5em"></label></p>' +
      '<p><button type="button" id="xRepImg">Download report (image)</button> ' +
      '<button type="button" id="xRepPdf">Print / Save as PDF</button></p>';
    $("results").appendChild(panel);

    const extra = document.createElement("div");
    extra.id = "xExtra";
    extra.innerHTML =
      '<section style="margin:12px 0;padding:12px;border:1px solid rgba(128,128,128,.4);border-radius:10px">' +
      '<h3 style="margin:0 0 8px">Growth curve</h3><p id="xGrowthInfo"><small></small></p><div id="xGrowthBox"></div>' +
      '<p><button type="button" id="xDemo">Show / hide demo curve (made-up data)</button> ' +
      '<button type="button" id="xGrowthImg">Download growth graph</button></p></section>' +
      '<section style="margin:12px 0;padding:12px;border:1px solid rgba(128,128,128,.4);border-radius:10px">' +
      '<h3 style="margin:0 0 8px">Accuracy check: app vs manual count</h3>' +
      '<p><label>Cell type: <select id="xValType"><option value="rbc">rbc</option><option value="pollen">pollen</option>' +
      '<option value="yeast">yeast</option></select></label></p>' +
      '<p id="xValText"><small></small></p><div id="xValBox"></div>' +
      '<p><button type="button" id="xValImg">Download accuracy graph</button></p></section>';
    const anchor = $("historySection");
    if (anchor && anchor.insertAdjacentElement) anchor.insertAdjacentElement("afterend", extra);
    else document.body.appendChild(extra);

    if (prefs.side) $("xSide").value = prefs.side;
    $("xCalib").checked = prefs.calib !== false;
    if (prefs.exp) $("xExp").value = prefs.exp;

    ["xSide", "xCalib"].forEach(id => $(id).addEventListener("change", function () { savePrefs(); updateMetrics(); }));
    $("xExp").addEventListener("input", function () { savePrefs(); refreshGrowth(); });
    ["squares", "dilution"].forEach(id => $(id).addEventListener("input", updateMetrics));
    $("out").addEventListener("click", onOutputTap);
    $("xReset").addEventListener("click", runCount);
    $("xRepImg").addEventListener("click", function () { const c = buildReport(); if (c) Report.download(c, "biovision_report.png"); });
    $("xRepPdf").addEventListener("click", function () { const c = buildReport(); if (c) Report.printAsPdf(c); });
    $("xDemo").addEventListener("click", function () { showDemoGrowth = !showDemoGrowth; refreshGrowth(); });
    $("xGrowthImg").addEventListener("click", function () { if (growthCanvas) Report.download(growthCanvas, "growth_curve.png"); else msg("No growth curve to download yet."); });
    $("xValType").addEventListener("change", refreshAccuracy);
    $("xValImg").addEventListener("click", function () { if (accuracyCanvas) Report.download(accuracyCanvas, "accuracy_graph.png"); else msg("No accuracy graph yet (need 3 images with a manual count)."); });
  }

  // adds a "Yeast (beta)" choice next to the existing cell-type choices
  function ensureYeastOption() {
    const radios = document.querySelectorAll("input[name=mode]");
    if (!radios.length) return;
    for (const r of radios) if (r.value === "yeast") return;
    const last = radios[radios.length - 1], label = last.closest("label");
    if (!label) return;
    const copy = label.cloneNode(true);
    const input = copy.querySelector("input");
    input.value = "yeast"; input.checked = false; input.removeAttribute("id");
    Array.from(copy.childNodes).forEach(n => { if (n.nodeType === 3) n.remove(); });
    const span = copy.querySelector("span");
    if (span) span.textContent = "Yeast (beta)"; else copy.appendChild(document.createTextNode(" Yeast (beta)"));
    label.insertAdjacentElement("afterend", copy);
  }

  function loadReportScript() {
    if (window.Report) return;
    const s = document.createElement("script");
    s.src = "report.js";
    s.onload = function () { refreshGrowth(); refreshAccuracy(); };
    s.onerror = function () { msg("report.js could not be loaded (graphs and report are unavailable)."); };
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------
  // wiring
  // ---------------------------------------------------------------
  function init() {
    if (!Core.sizeStats) { msg("Please update core.js together with app.js."); }

    [["left", "oLeft"], ["top", "oTop"], ["width", "oWidth"], ["height", "oHeight"],
     ["minR", "oMinR"], ["maxR", "oMaxR"], ["sens", "oSens"], ["margin", "oMargin"]]
      .forEach(p => bindRange(p[0], p[1]));

    ["left", "top", "width", "height"].forEach(id => $(id).addEventListener("input", drawView));

    ensureYeastOption();
    document.querySelectorAll("input[name=mode]").forEach(el =>
      el.addEventListener("change", () => { if (el.checked) applyMode(el.value); }));

    $("btnCamera").addEventListener("click", () => $("fileCamera").click());
    $("btnGallery").addEventListener("click", () => $("fileGallery").click());
    $("fileCamera").addEventListener("change", e => { loadFile(e.target.files[0]); e.target.value = ""; });
    $("fileGallery").addEventListener("change", e => { loadFile(e.target.files[0]); e.target.value = ""; });

    $("btnCount").addEventListener("click", runCount);
    $("btnSave").addEventListener("click", saveResult);
    $("btnExport").addEventListener("click", exportCSV);
    $("btnClear").addEventListener("click", function () {
      if (confirm("Delete all saved results from this device?")) { storeHistory([]); renderHistory(); refreshGrowth(); refreshAccuracy(); }
    });

    buildPanels();
    applyMode("rbc");
    renderHistory();
    refreshGrowth();
    refreshAccuracy();
    loadReportScript();
    waitForCv();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(function () { /* works without it, just not offline */ });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
