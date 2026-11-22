/*
 * core.js - the counting logic that does NOT need OpenCV or the page.
 * It is a line-by-line port of cell_detection.py + viability.py so the
 * phone app gives the same results as the Streamlit app.
 *
 * Works in the browser (window.Core) and in Node (module.exports) so it can
 * be tested.
 *
 * UPGRADE (Avishkar): marked "NEW" below.
 *   - yeast mode (same blue-stain live/dead rule as pollen, for methylene blue)
 *   - concentration() accepts the side of the counted square (1 mm or 0.2 mm)
 *   - calibration (um per pixel) from the counting square, size statistics
 *   - image quality checks, insight lines, growth curve maths, validation maths
 */
(function (root) {
  "use strict";

  const Core = {};

  // ---------- counting square ----------

  Core.clampSquare = function (sq, W, H, minSize) {
    minSize = minSize || 20;
    let x = Math.trunc(sq[0]), y = Math.trunc(sq[1]);
    let w = Math.trunc(sq[2]), h = Math.trunc(sq[3]);
    x = Math.max(0, Math.min(x, W - minSize));
    y = Math.max(0, Math.min(y, H - minSize));
    w = Math.max(minSize, Math.min(w, W - x));
    h = Math.max(minSize, Math.min(h, H - y));
    return [x, y, w, h];
  };

  Core.squareFromPercent = function (W, H, left, top, width, height) {
    return Core.clampSquare(
      [W * left / 100, H * top / 100, W * width / 100, H * height / 100],
      W, H
    );
  };

  // ---------- small helpers ----------

  function median(values) {
    const a = Float64Array.from(values);
    a.sort();
    const n = a.length;
    if (n === 0) return 0;
    return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }

  // ---------- colour measurements (RGBA pixel data, like canvas ImageData) ----------

  // Blueness of the slide background: median of 100*ln(B/R) over the brighter
  // half of the pixels (where there are no cells).
  Core.backgroundBlueness = function (rgba, W, H) {
    const n = W * H;
    const bright = new Float64Array(n);
    const logRatio = new Float64Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const R = rgba[p], G = rgba[p + 1], B = rgba[p + 2];
      bright[i] = (R + G + B) / 3;
      logRatio[i] = 100 * Math.log((B + 1) / (R + 1));
    }
    const med = median(bright);
    const sel = [];
    for (let i = 0; i < n; i++) if (bright[i] >= med) sel.push(logRatio[i]);
    return median(sel);
  };

  // 100*ln(meanB / meanR) inside the inner 70 % of a circle. Mirrors viability.py:
  // the circle is shrunk by one pixel (3x3 cross erosion) so the blurred cell
  // edge is ignored.
  Core.cellBlueness = function (rgba, W, H, cx, cy, r) {
    const ccx = Math.trunc(cx), ccy = Math.trunc(cy);
    const R0 = Math.trunc(0.7 * r);
    const R2 = R0 * R0;

    // bounding box of the circle, clipped to the image (like the Python patch)
    const bx0 = Math.max(0, ccx - R0), bx1 = Math.min(W - 1, ccx + R0);
    const by0 = Math.max(0, ccy - R0), by1 = Math.min(H - 1, ccy + R0);

    function inside(x, y) {
      if (x < bx0 || x > bx1 || y < by0 || y > by1) return true;   // border: not eroded
      const dx = x - ccx, dy = y - ccy;
      return dx * dx + dy * dy <= R2;
    }

    function mean(erode) {
      let sumB = 0, sumR = 0, count = 0;
      for (let y = by0; y <= by1; y++) {
        for (let x = bx0; x <= bx1; x++) {
          const dx = x - ccx, dy = y - ccy;
          if (dx * dx + dy * dy > R2) continue;
          if (erode && !(inside(x - 1, y) && inside(x + 1, y) && inside(x, y - 1) && inside(x, y + 1))) continue;
          const p = (y * W + x) * 4;
          sumR += rgba[p];
          sumB += rgba[p + 2];
          count++;
        }
      }
      return count ? { b: sumB / count, r: sumR / count } : null;
    }

    const m = mean(true) || mean(false);
    if (!m) return 0;
    return 100 * Math.log((m.b + 1) / (m.r + 1));
  };

  // ---------- circle clean-up ----------

  // Hough returns the strongest circles first; drop circles that overlap a
  // stronger one.
  Core.dedupeCircles = function (circles) {
    const kept = [];
    for (const c of circles) {
      let ok = true;
      for (const k of kept) {
        if (Math.hypot(c.x - k.x, c.y - k.y) < 0.7 * Math.max(c.r, k.r)) { ok = false; break; }
      }
      if (ok) kept.push(c);
    }
    return kept;
  };

  // Hemocytometer border rule: cells touching the RIGHT or BOTTOM edge of the
  // counting square are ignored (left / top are counted).
  Core.touchesRightBottom = function (c, W, H) {
    return c.x + c.r > W - 1 || c.y + c.r > H - 1;
  };

  // ---------- the whole counting step after circle detection ----------
  /*
   * circles : [{x, y, r}] in crop coordinates (as returned by Hough)
   * rgba    : crop pixel data, W x H
   * opts    : { mode: "rbc" | "pollen" | "yeast", margin: number }
   */
  Core.process = function (circles, rgba, W, H, opts) {
    const mode = opts.mode || "rbc";
    const margin = opts.margin == null ? 10 : opts.margin;

    const kept = Core.dedupeCircles(circles);
    const stainRule = Core.isStainMode(mode);                 // NEW: yeast uses the stain rule too
    const bgRef = stainRule ? Core.backgroundBlueness(rgba, W, H) : 0;

    const objects = [];
    const excluded = [];
    let live = 0, dead = 0;

    for (const c of kept) {
      if (Core.touchesRightBottom(c, W, H)) {
        excluded.push(c);
        continue;
      }
      let label = "live";
      let blue = 0;
      if (stainRule) {
        blue = Core.cellBlueness(rgba, W, H, c.x, c.y, c.r) - bgRef;
        label = blue >= margin ? "dead" : "live";
      }
      if (label === "dead") dead++; else live++;
      objects.push({ id: objects.length + 1, x: c.x, y: c.y, r: c.r, blueness: blue, label: label });
    }

    const total = live + dead;
    return {
      objects: objects,
      excluded: excluded,
      live: live,
      dead: dead,
      total: total,
      viability: total ? 100 * live / total : 0,
      bgRef: bgRef
    };
  };

  // NEW: modes that use the blue-stain live/dead rule (pollen stain, methylene blue for yeast)
  Core.isStainMode = function (mode) { return mode === "pollen" || mode === "yeast"; };

  // cells/mL = (count / squares) / volume of one counted square x dilution
  // squareSideMm = 1 (large square, 0.1 uL, the original formula x 10^4) or 0.2 (small square).
  // Default of 1 gives exactly the same numbers as before.
  Core.concentration = function (total, squares, dilution, squareSideMm) {
    const side = squareSideMm || 1;
    const volumeMl = side * side * 0.1 / 1000;      // mm x mm x 0.1 mm depth, in mL
    return (total / Math.max(squares, 1)) / volumeMl * dilution;
  };

  Core.toCSV = function (rows, columns) {
    const esc = v => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [columns.join(",")];
    for (const r of rows) lines.push(columns.map(c => esc(r[c])).join(","));
    return lines.join("\n") + "\n";
  };

  // =====================================================================
  // NEW: calibration and size statistics
  // =====================================================================

  // micrometres per pixel, assuming the green box is aligned with ONE counted square
  Core.umPerPx = function (boxWidthPx, squareSideMm) {
    return (squareSideMm || 1) * 1000 / boxWidthPx;
  };

  Core.sizeStats = function (objects, umPerPx) {
    const d = objects.map(o => 2 * o.r * umPerPx);
    const n = d.length;
    const mean = n ? d.reduce((a, b) => a + b, 0) / n : 0;
    const sd = n > 1 ? Math.sqrt(d.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1)) : 0;
    return { n: n, meanUm: mean, sdUm: sd, diametersUm: d };
  };

  Core.histogramBins = function (values, bins) {
    bins = bins || 8;
    if (!values.length) return { edges: [], counts: [] };
    const lo = Math.min.apply(null, values), hi = Math.max.apply(null, values);
    const width = (hi - lo) / bins || 1;
    const counts = new Array(bins).fill(0);
    for (const v of values) counts[Math.min(Math.floor((v - lo) / width), bins - 1)]++;
    const edges = [];
    for (let i = 0; i <= bins; i++) edges.push(lo + i * width);
    return { edges: edges, counts: counts };
  };

  // =====================================================================
  // NEW: image quality checks
  // =====================================================================

  // variance of the Laplacian on the grey image (higher = sharper). Tune the threshold on your photos.
  Core.blurScore = function (rgba, W, H) {
    const g = new Float32Array(W * H);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    let sum = 0, sumSq = 0, n = 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const v = g[i - 1] + g[i + 1] + g[i - W] + g[i + W] - 4 * g[i];
        sum += v; sumSq += v * v; n++;
      }
    }
    if (!n) return 0;
    const mean = sum / n;
    return sumSq / n - mean * mean;
  };

  // share of counted cells that touch a neighbour (a proxy for clumping)
  Core.touchingFraction = function (objects) {
    if (!objects.length) return 0;
    let touching = 0;
    for (let i = 0; i < objects.length; i++) {
      for (let j = 0; j < objects.length; j++) {
        if (i === j) continue;
        const a = objects[i], b = objects[j];
        if (Math.hypot(a.x - b.x, a.y - b.y) < 1.1 * (a.r + b.r)) { touching++; break; }
      }
    }
    return touching / objects.length;
  };

  // =====================================================================
  // NEW: growth curve maths
  // =====================================================================

  function slope(pts) {
    const n = pts.length;
    const mx = pts.reduce((a, p) => a + p[0], 0) / n;
    const my = pts.reduce((a, p) => a + p[1], 0) / n;
    let num = 0, den = 0;
    for (const p of pts) { num += (p[0] - mx) * (p[1] - my); den += (p[0] - mx) * (p[0] - mx); }
    return den ? num / den : 0;
  }

  // win = [startIndex, endIndex] (inclusive) of the exponential stretch; default = steepest 3-point stretch
  Core.doublingTime = function (times, counts, win) {
    const pts = [];
    for (let i = 0; i < times.length; i++) if (counts[i] > 0) pts.push([times[i], Math.log(counts[i])]);
    if (pts.length < 3) return null;
    let k;
    if (win) k = slope(pts.slice(win[0], win[1] + 1));
    else {
      k = -Infinity;
      for (let i = 0; i + 2 < pts.length; i++) k = Math.max(k, slope(pts.slice(i, i + 3)));
    }
    return k > 0 ? Math.log(2) / k : null;
  };

  // returns an array of "lag" | "exponential" | "stationary", one per time point
  Core.detectPhase = function (times, counts, threshold) {
    threshold = threshold == null ? 0.3 : threshold;
    const rates = [];
    for (let i = 1; i < counts.length; i++) {
      const dt = times[i] - times[i - 1];
      rates.push(counts[i] > 0 && counts[i - 1] > 0 && dt > 0 ? Math.log(counts[i] / counts[i - 1]) / dt : 0);
    }
    const maxRate = rates.length ? Math.max.apply(null, rates) : 0;
    if (maxRate <= 0) return counts.map(() => "lag");
    const peak = rates.indexOf(maxRate);
    const cut = threshold * maxRate;
    const labels = ["lag"];
    rates.forEach((r, i) => labels.push(r >= cut ? "exponential" : (i < peak ? "lag" : "stationary")));
    return labels;
  };

  // =====================================================================
  // NEW: validation (app counts vs manual counts)
  // =====================================================================
  Core.validate = function (app, manual) {
    const n = app.length;
    if (n !== manual.length || n < 3) return null;
    const pct = [];
    for (let i = 0; i < n; i++) if (manual[i]) pct.push(100 * Math.abs(app[i] - manual[i]) / manual[i]);
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const ma = mean(app), mm = mean(manual);
    let num = 0, da = 0, dm = 0;
    for (let i = 0; i < n; i++) { num += (app[i] - ma) * (manual[i] - mm); da += (app[i] - ma) ** 2; dm += (manual[i] - mm) ** 2; }
    const r = da && dm ? num / Math.sqrt(da * dm) : NaN;
    const diffs = app.map((a, i) => a - manual[i]);
    const bias = mean(diffs);
    const sd = Math.sqrt(diffs.reduce((a, d) => a + (d - bias) * (d - bias), 0) / (n - 1));
    return { n: n, mape: mean(pct), r: r, r2: r * r, bias: bias, loa: [bias - 1.96 * sd, bias + 1.96 * sd] };
  };

  // =====================================================================
  // NEW: insight lines ("What this means"), at most 3 per report
  // =====================================================================
  // TUNE THESE on your own photos, and cite a source for every reference range.
  Core.CFG = {
    minCells: 50, maxCells: 500,        // standard hemocytometer guidance is higher; tune to your counting
    blurMin: 30,                        // variance of Laplacian; tune on your photos
    touchMax: 0.35,                     // share of cells touching a neighbour
    yeastViabHigh: 90, yeastViabMod: 70,
    yeastSizeUm: [3, 10],
    rbcSizeUm: [6, 8], rbcSdMaxUm: 1.0, // cite your textbook or paper
    pollenViabHigh: 70, pollenSizeTol: 0.15
  };

  Core.FOOTER = "For education and research use only. Not a medical diagnosis.";

  function qualityLine(q) {
    const C = Core.CFG;
    if (q.blurScore != null && q.blurScore < C.blurMin)
      return "The image is slightly blurry, so the count may be off. Retake it with the focus adjusted.";
    if (q.touchingFraction != null && q.touchingFraction > C.touchMax)
      return "Many cells are touching, so some may be counted as one. Dilute the sample and try again.";
    if (q.nCells < C.minCells)
      return "Only " + q.nCells + " cells were counted, so the result is less reliable. Use a more concentrated sample or count more squares.";
    if (q.nCells > C.maxCells)
      return "There are too many cells to count accurately. Dilute the sample further.";
    return null;
  }
  Core.qualityLine = qualityLine;

  /*
   * sample : "rbc" | "pollen" | "yeast"
   * q      : { blurScore, touchingFraction, nCells }
   * stats  : { meanUm, sdUm }
   * o      : { viability, phase, doublingH, pollenRefMeanUm }
   */
  Core.insightLines = function (sample, q, stats, o) {
    o = o || {};
    const C = Core.CFG;
    const lines = [];
    const ql = qualityLine(q);
    if (ql) lines.push(ql);
    const hasSize = !!(stats && isFinite(stats.meanUm) && stats.n > 0);   // sizes need calibration
    const m = hasSize ? stats.meanUm : 0, sd = hasSize ? stats.sdUm : 0;

    if (sample === "yeast") {
      if (o.viability != null) {
        const v = Math.round(o.viability);
        if (o.viability >= C.yeastViabHigh) lines.push("Most cells are alive (" + v + "%), which points to a healthy culture.");
        else if (o.viability >= C.yeastViabMod) lines.push("Viability is moderate (" + v + "%). Check the age and conditions of the culture.");
        else lines.push("Viability is low (" + v + "%). The culture may be old, stressed, or contaminated.");
      }
      if (hasSize && m >= C.yeastSizeUm[0] && m <= C.yeastSizeUm[1])
        lines.push("Cell size (" + m.toFixed(1) + " \u00B5m) is in the typical range for yeast.");
      if (o.phase === "lag") lines.push("The culture is still adjusting. Counts should start rising soon.");
      else if (o.phase === "exponential" && o.doublingH)
        lines.push("The culture is in its exponential phase, with a doubling time of " + o.doublingH.toFixed(1) + " h.");
      else if (o.phase === "stationary") lines.push("Growth has levelled off, which usually means nutrients are running low.");
    } else if (sample === "rbc") {
      const lo = C.rbcSizeUm[0], hi = C.rbcSizeUm[1];
      if (!hasSize) { /* no calibration, no size notes */ }
      else if (m >= lo && m <= hi)
        lines.push("Average cell size (" + m.toFixed(1) + " \u00B5m) is within the range usually seen for human red blood cells (about " + lo + " to " + hi + " \u00B5m).");
      else
        lines.push("Average cell size (" + m.toFixed(1) + " \u00B5m) is outside the usual range. This could come from sample handling. Please check with a lab professional.");
      if (hasSize && sd > C.rbcSdMaxUm) lines.push("Cell sizes vary more than usual (SD " + sd.toFixed(1) + " \u00B5m). Check how the sample was prepared.");
    } else if (sample === "pollen") {
      if (o.viability != null) {
        const v = Math.round(o.viability);
        if (o.viability >= C.pollenViabHigh) lines.push(v + "% of pollen grains are viable, which suggests good fertility.");
        else lines.push("Viability is low (" + v + "%). The pollen may be old, stressed, or collected at the wrong stage.");
      }
      if (hasSize && o.pollenRefMeanUm) {
        if (Math.abs(m - o.pollenRefMeanUm) / o.pollenRefMeanUm <= C.pollenSizeTol)
          lines.push("Average grain size (" + m.toFixed(1) + " \u00B5m) matches your periwinkle reference.");
        else lines.push("Average grain size (" + m.toFixed(1) + " \u00B5m) differs from your reference. The sample may be mixed or immature.");
      }
    }
    return lines.slice(0, 3);
  };

  if (typeof module !== "undefined" && module.exports) module.exports = Core;
  else root.Core = Core;

})(typeof self !== "undefined" ? self : this);
