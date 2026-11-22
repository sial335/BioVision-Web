/*
 * report.js - builds the one-page "summary-first" BioVision report on a canvas.
 * No library needed, so it works offline and on Android and iPhone.
 *   const canvas = Report.build({...});
 *   Report.download(canvas, "report.png");   // image
 *   Report.printAsPdf(canvas);               // opens the print dialog -> "Save as PDF"
 * Needs core.js loaded first (uses Core.histogramBins and Core.detectPhase).
 */
(function (root) {
  "use strict";

  const Report = {};
  const W = 1240, H = 1754;                       // A4 at about 150 dpi
  const C = { text: "#2C2C2A", sub: "#5F5E5A", muted: "#888780", card: "#F1EFE8", line: "#D3D1C7",
              blue: "#378ADD", green: "#1D9E75", orange: "#D85A30", red: "#A32D2D",
              infoBg: "#E6F1FB", infoText: "#0C447C" };
  const SUP = { "0": "\u2070", "1": "\u00B9", "2": "\u00B2", "3": "\u00B3", "4": "\u2074", "5": "\u2075",
                "6": "\u2076", "7": "\u2077", "8": "\u2078", "9": "\u2079", "-": "\u207B" };

  function fmtConc(v) {
    if (!(v > 0)) return "0";
    const e = Math.floor(Math.log10(v));
    const m = v / Math.pow(10, e);
    return m.toFixed(1) + " \u00D7 10" + String(e).split("").map(ch => SUP[ch] || ch).join("");
  }
  function fmtShort(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return String(Math.round(v));
  }
  function font(ctx, size, weight, style) {
    ctx.font = (style || "normal") + " " + (weight || "normal") + " " + size + "px sans-serif";
  }
  function text(ctx, s, x, y, size, colour, weight, align, style) {
    font(ctx, size, weight, style);
    ctx.fillStyle = colour;
    ctx.textAlign = align || "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(s, x, y);
  }
  function wrap(ctx, s, maxW) {
    const words = s.split(" "), lines = [];
    let cur = "";
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
    }
    if (cur) lines.push(cur);
    return lines;
  }
  function card(ctx, x, y, w, h, label, value, sub) {
    ctx.fillStyle = C.card; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = C.line; ctx.lineWidth = 1.5; ctx.strokeRect(x, y, w, h);
    text(ctx, label, x + 18, y + 38, 20, C.sub);
    text(ctx, value, x + 18, y + 98, 44, C.text, "bold");
    text(ctx, sub, x + 18, y + 132, 18, C.muted);
  }

  function drawHistogram(ctx, x, y, w, h, diameters, meanUm) {
    text(ctx, "Size distribution", x, y - 16, 24, C.text, "bold");
    const hb = root.Core.histogramBins(diameters, 8);
    const left = 70, bottom = 70, top = 20;
    const px = x + left, pw = w - left - 10, py = y + top, ph = h - bottom - top;
    ctx.strokeStyle = C.muted; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py + ph); ctx.lineTo(px + pw, py + ph); ctx.stroke();
    if (!hb.counts.length) return;
    const maxC = Math.max.apply(null, hb.counts);
    const lo = hb.edges[0], hi = hb.edges[hb.edges.length - 1], span = (hi - lo) || 1;
    const bw = pw / hb.counts.length;
    hb.counts.forEach((c, i) => {
      const bh = ph * c / maxC;
      ctx.fillStyle = C.blue;
      ctx.fillRect(px + i * bw + 3, py + ph - bh, bw - 6, bh);
    });
    const mx = px + pw * (meanUm - lo) / span;
    ctx.setLineDash([8, 6]); ctx.strokeStyle = C.red; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(mx, py); ctx.lineTo(mx, py + ph); ctx.stroke(); ctx.setLineDash([]);
    text(ctx, "mean", mx + 6, py + 16, 18, C.red);
    text(ctx, lo.toFixed(1), px, py + ph + 28, 18, C.sub, "normal", "center");
    text(ctx, hi.toFixed(1), px + pw, py + ph + 28, 18, C.sub, "normal", "center");
    text(ctx, "Diameter (\u00B5m)", px + pw / 2, py + ph + 56, 20, C.sub, "normal", "center");
    text(ctx, String(maxC), px - 10, py + 14, 18, C.sub, "normal", "right");
    text(ctx, "0", px - 10, py + ph, 18, C.sub, "normal", "right");
    ctx.save(); ctx.translate(x + 20, py + ph / 2); ctx.rotate(-Math.PI / 2);
    text(ctx, "Cells", 0, 0, 20, C.sub, "normal", "center"); ctx.restore();
  }

  function drawGrowth(ctx, x, y, w, h, g, doublingH) {
    text(ctx, "Growth curve (shaded: lag / exponential / stationary)", x, y - 16, 24, C.text, "bold");
    const left = 90, bottom = 70, top = 20;
    const px = x + left, pw = w - left - 20, py = y + top, ph = h - bottom - top;
    const t = g.times, n = g.counts;
    const labels = root.Core.detectPhase(t, n);
    const shade = { lag: "#E6F1FB", exponential: "#E1F5EE", stationary: "#FAEEDA" };
    const t0 = t[0], t1 = t[t.length - 1], ts = (t1 - t0) || 1;
    const nmax = Math.max.apply(null, n) * 1.08;
    const X = v => px + pw * (v - t0) / ts, Y = v => py + ph - ph * v / nmax;
    for (let i = 1; i < t.length; i++) {
      ctx.fillStyle = shade[labels[i]];
      ctx.fillRect(X(t[i - 1]), py, X(t[i]) - X(t[i - 1]), ph);
    }
    ctx.strokeStyle = C.muted; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py + ph); ctx.lineTo(px + pw, py + ph); ctx.stroke();
    ctx.strokeStyle = C.blue; ctx.lineWidth = 3.5; ctx.beginPath();
    t.forEach((v, i) => { if (i) ctx.lineTo(X(v), Y(n[i])); else ctx.moveTo(X(v), Y(n[i])); });
    ctx.stroke();
    ctx.fillStyle = C.blue;
    t.forEach((v, i) => { ctx.beginPath(); ctx.arc(X(v), Y(n[i]), 6, 0, 2 * Math.PI); ctx.fill(); });
    t.forEach(v => text(ctx, String(v), X(v), py + ph + 28, 18, C.sub, "normal", "center"));
    text(ctx, "Time (h)", px + pw / 2, py + ph + 58, 20, C.sub, "normal", "center");
    text(ctx, fmtShort(nmax / 1.08), px - 10, py + 14, 18, C.sub, "normal", "right");
    text(ctx, "0", px - 10, py + ph, 18, C.sub, "normal", "right");
    ctx.save(); ctx.translate(x + 22, py + ph / 2); ctx.rotate(-Math.PI / 2);
    text(ctx, "Cells/mL", 0, 0, 20, C.sub, "normal", "center"); ctx.restore();
    if (doublingH) text(ctx, "Doubling time: " + doublingH.toFixed(1) + " h", px + 16, py + 34, 26, C.text, "bold");
  }

  /*
   * o = {
   *   sampleType, title, timestamp (string), demo (bool),
   *   concentrationPerMl, total, viability (number or null),
   *   stats {meanUm, sdUm, diametersUm}, quality {blurScore, touchingFraction, nCells},
   *   annotated (the canvas with the circled cells),
   *   growth {times, counts} or null, lines [strings],
   *   dilution, squares, squareSideMm, borderRule (bool)
   * }
   */
  Report.build = function (o) {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, W, H);
    const M = 74, inner = W - 2 * M;

    text(ctx, "BioVision count report", M, 88, 44, C.text, "bold");
    text(ctx, "Sample type: " + o.sampleType + " \u00B7 " + o.title + " \u00B7 " + o.timestamp, M, 130, 22, C.sub);
    if (o.demo) text(ctx, "DEMO DATA, not a real result", W - M, 88, 24, C.red, "bold", "right");
    ctx.strokeStyle = C.line; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(M, 152); ctx.lineTo(W - M, 152); ctx.stroke();

    const q = o.quality || {};
    const cw = 255, gap = (inner - 4 * cw) / 3, cy = 190, chh = 150;
    card(ctx, M, cy, cw, chh, "Concentration", fmtConc(o.concentrationPerMl), "cells/mL");
    if (o.viability != null) card(ctx, M + (cw + gap), cy, cw, chh, "Viable", o.viability.toFixed(0) + "%", "stain test");
    else card(ctx, M + (cw + gap), cy, cw, chh, "Cells counted", String(o.total), "in this image");
    if (o.stats) card(ctx, M + 2 * (cw + gap), cy, cw, chh, "Mean size", o.stats.meanUm.toFixed(1) + " \u00B5m",
         "\u00B1 " + o.stats.sdUm.toFixed(1) + " SD");
    else card(ctx, M + 2 * (cw + gap), cy, cw, chh, "Mean size", "n/a", "calibration off");
    const problem = root.Core.qualityLine(q);
    card(ctx, M + 3 * (cw + gap), cy, cw, chh, "Image quality", problem ? "Check" : "Good",
         "blur " + Math.round(q.blurScore || 0) + " \u00B7 touching " + Math.round(100 * (q.touchingFraction || 0)) + "%");

    const hasGrowth = !!(o.growth && o.growth.times && o.growth.times.length >= 3);
    const top = 430, blockH = hasGrowth ? 390 : 640;
    const half = (inner - 40) / 2;

    text(ctx, "Annotated image", M, top - 16, 24, C.text, "bold");
    ctx.fillStyle = C.card; ctx.fillRect(M, top, half, blockH);
    if (o.annotated && o.annotated.width) {
      const s = Math.min(half / o.annotated.width, blockH / o.annotated.height);
      const iw = o.annotated.width * s, ih = o.annotated.height * s;
      ctx.drawImage(o.annotated, M + (half - iw) / 2, top + (blockH - ih) / 2, iw, ih);
    }
    text(ctx, "Green = live, red = dead, yellow = ignored at the right/bottom border", M, top + blockH + 28, 18, C.muted);
    if (o.stats && o.stats.diametersUm.length) drawHistogram(ctx, M + half + 40, top, half, blockH, o.stats.diametersUm, o.stats.meanUm);
    else text(ctx, "Sizes are shown when calibration is on.", M + half + 40, top + 40, 22, C.muted);

    let yNext = top + blockH + 90;
    if (hasGrowth) {
      const gh = 330;
      const dh = o.doublingH || root.Core.doublingTime(o.growth.times, o.growth.counts);
      drawGrowth(ctx, M, yNext + 30, inner, gh, o.growth, dh);
      yNext += gh + 80;
    }

    const boxH = 250;
    ctx.fillStyle = C.infoBg; ctx.fillRect(M, yNext, inner, boxH);
    text(ctx, "What this means", M + 28, yNext + 46, 28, C.infoText, "bold");
    let ty = yNext + 92;
    font(ctx, 24, "normal");
    (o.lines && o.lines.length ? o.lines : ["No notes for this sample."]).forEach(line => {
      wrap(ctx, line, inner - 90).forEach((part, i) => {
        text(ctx, (i === 0 ? "\u2022 " : "   ") + part, M + 28, ty, 24, C.infoText);
        ty += 34;
      });
      ty += 8;
    });

    const bits = [];
    if (o.dilution) bits.push("dilution 1:" + o.dilution);
    if (o.squares) bits.push(o.squares + " square(s) counted, side " + (o.squareSideMm || 1) + " mm");
    if (o.borderRule) bits.push("border rule applied");
    text(ctx, "Method: " + bits.join(", ") + ".", M, H - 90, 20, C.sub);
    text(ctx, root.Core.FOOTER, M, H - 55, 20, C.muted, "normal", "left", "italic");
    return cv;
  };


  // ---------- stand-alone growth graph (for the poster) ----------
  // o = { growth: {times, counts}, doublingH, title, demo }
  Report.buildGrowth = function (o) {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = 560;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, W, 560);
    text(ctx, o.title || "Growth curve", 74, 60, 34, C.text, "bold");
    if (o.demo) text(ctx, "DEMO DATA, not a real result", W - 74, 60, 24, C.red, "bold", "right");
    const dh = o.doublingH || root.Core.doublingTime(o.growth.times, o.growth.counts);
    drawGrowth(ctx, 74, 130, W - 148, 380, o.growth, dh);
    return cv;
  };

  function axes(ctx, px, py, pw, ph) {
    ctx.strokeStyle = C.muted; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py + ph); ctx.lineTo(px + pw, py + ph); ctx.stroke();
  }

  // ---------- stand-alone accuracy graph (app vs manual) ----------
  // o = { app: [], manual: [], stats: Core.validate(...), title }
  Report.buildValidation = function (o) {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = 700;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, W, 700);
    const s = o.stats;
    text(ctx, o.title || "Accuracy: app count vs manual count", 74, 56, 34, C.text, "bold");
    text(ctx, "n = " + s.n + " images \u00B7 mean absolute error " + s.mape.toFixed(1) + "% \u00B7 r\u00B2 = " + s.r2.toFixed(3) +
         " \u00B7 bias " + s.bias.toFixed(1) + " cells", 74, 96, 22, C.sub);
    const half = (W - 148 - 60) / 2, py = 190, ph = 380, left = 80;

    // left: agreement plot
    let px = 74 + left, pw = half - left - 10;
    text(ctx, "Agreement", 74, py - 24, 24, C.text, "bold");
    axes(ctx, px, py, pw, ph);
    const mx = Math.max.apply(null, o.app.concat(o.manual)) * 1.08;
    const X = v => px + pw * v / mx, Y = v => py + ph - ph * v / mx;
    ctx.setLineDash([8, 6]); ctx.strokeStyle = C.muted; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(mx), Y(mx)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = C.blue;
    o.manual.forEach((m, i) => { ctx.beginPath(); ctx.arc(X(m), Y(o.app[i]), 8, 0, 2 * Math.PI); ctx.fill(); });
    text(ctx, "Manual count", px + pw / 2, py + ph + 56, 20, C.sub, "normal", "center");
    text(ctx, Math.round(mx).toString(), px + pw, py + ph + 28, 18, C.sub, "normal", "center");
    text(ctx, "0", px, py + ph + 28, 18, C.sub, "normal", "center");
    text(ctx, Math.round(mx).toString(), px - 10, py + 14, 18, C.sub, "normal", "right");
    ctx.save(); ctx.translate(74 + 18, py + ph / 2); ctx.rotate(-Math.PI / 2);
    text(ctx, "App count", 0, 0, 20, C.sub, "normal", "center"); ctx.restore();
    text(ctx, "dashed line = perfect agreement", px + 10, py + 26, 18, C.muted);

    // right: Bland-Altman
    const bx = 74 + half + 60 + left;
    pw = half - left - 10;
    text(ctx, "Bland-Altman (difference vs average)", 74 + half + 60, py - 24, 24, C.text, "bold");
    axes(ctx, bx, py, pw, ph);
    const diffs = o.app.map((a, i) => a - o.manual[i]);
    const means = o.app.map((a, i) => (a + o.manual[i]) / 2);
    const dmax = Math.max(Math.abs(s.loa[0]), Math.abs(s.loa[1]), Math.max.apply(null, diffs.map(Math.abs))) * 1.2 || 1;
    const mmax = Math.max.apply(null, means) * 1.08;
    const BX = v => bx + pw * v / mmax, BY = v => py + ph / 2 - (ph / 2) * v / dmax;
    ctx.lineWidth = 2;
    ctx.strokeStyle = C.muted; ctx.beginPath(); ctx.moveTo(bx, BY(0)); ctx.lineTo(bx + pw, BY(0)); ctx.stroke();
    ctx.strokeStyle = C.blue; ctx.beginPath(); ctx.moveTo(bx, BY(s.bias)); ctx.lineTo(bx + pw, BY(s.bias)); ctx.stroke();
    ctx.setLineDash([8, 6]); ctx.strokeStyle = C.red;
    [s.loa[0], s.loa[1]].forEach(v => { ctx.beginPath(); ctx.moveTo(bx, BY(v)); ctx.lineTo(bx + pw, BY(v)); ctx.stroke(); });
    ctx.setLineDash([]);
    ctx.fillStyle = C.blue;
    means.forEach((m, i) => { ctx.beginPath(); ctx.arc(BX(m), BY(diffs[i]), 8, 0, 2 * Math.PI); ctx.fill(); });
    text(ctx, "bias " + s.bias.toFixed(1), bx + pw - 6, BY(s.bias) - 8, 18, C.blue, "normal", "right");
    text(ctx, "+1.96 SD " + s.loa[1].toFixed(1), bx + pw - 6, BY(s.loa[1]) - 8, 18, C.red, "normal", "right");
    text(ctx, "-1.96 SD " + s.loa[0].toFixed(1), bx + pw - 6, BY(s.loa[0]) + 24, 18, C.red, "normal", "right");
    text(ctx, "Average of app and manual", bx + pw / 2, py + ph + 56, 20, C.sub, "normal", "center");
    ctx.save(); ctx.translate(bx - 62, py + ph / 2); ctx.rotate(-Math.PI / 2);
    text(ctx, "App minus manual", 0, 0, 20, C.sub, "normal", "center"); ctx.restore();
    text(ctx, root.Core.FOOTER, 74, 670, 18, C.muted, "normal", "left", "italic");
    return cv;
  };

  Report.download = function (canvas, filename) {
    canvas.toBlob(function (b) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = filename || "biovision_report.png";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    }, "image/png");
  };

  // Opens the report in a new tab and starts the print dialog; choose "Save as PDF".
  Report.printAsPdf = function (canvas) {
    canvas.toBlob(function (b) {
      const url = URL.createObjectURL(b);
      const w = window.open("", "_blank");
      if (!w) { alert("Please allow pop-ups for this page, or use the image download instead."); return; }
      w.document.write('<!doctype html><html><head><title>BioVision report</title>' +
        '<style>@page{size:A4;margin:0}html,body{margin:0}img{width:100%;display:block}</style></head>' +
        '<body><img src="' + url + '" onload="setTimeout(function(){window.print()},300)"></body></html>');
      w.document.close();
    }, "image/png");
  };

  root.Report = Report;
})(typeof self !== "undefined" ? self : this);
