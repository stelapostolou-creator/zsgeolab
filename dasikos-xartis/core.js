/*  Δασικός χάρτης — γεωμετρικός πυρήνας αντιρρήσεων.
 *
 *  Καθαρή είσοδος/έξοδος (μόνο δεδομένα, καμία επαφή με DOM/αρχεία) ώστε να
 *  μπορεί να αντικατασταθεί αργότερα από WASM χωρίς αλλαγή στα υπόλοιπα.
 *
 *  Τύπος:  Τελικό = (Κύρωση − B) ∪ (Ανάρτηση ∩ (B − O)) ∪ O
 *          O = πολύγωνα αντιρρήσεων, B = το κενό (χωρίς χαρακτηρισμό) που έχει η ΙΔΙΑ η κύρωση
 *          γύρω από την αντίρρηση. Το buffer ΔΕΝ δίνεται από τον χρήστη: βρίσκεται από την κύρωση.
 *          Μόνο αν δεν βρεθεί τέτοιο κενό, πέφτει σε buffer σταθερής απόστασης (fallbackBufferM) με προειδοποίηση.
 *
 *  Ακρίβεια: ακέραιες συντεταγμένες Clipper με αφετηρία κοντά στην περιοχή (έτσι
 *  μένουμε στο γρήγορο εύρος 32-bit της Clipper). Το πλέγμα επιλέγεται ανά υπολογισμό:
 *  0,01 mm όταν η έκταση των δεδομένων το επιτρέπει, αλλιώς 0,1 mm ή 1 mm.
 */
var DasikosCore = (function () {
  'use strict';
  var CL = ClipperLib;
  var SC = 1000;                       // μονάδες Clipper ανά μέτρο (ορίζεται στο compute)
  var ARC_TOL_M = 0.002;               // μέτρα — ανοχή στρογγυλέματος στις γωνίες του buffer
  var DETECT_MARGIN_M = 30;            // μέτρα γύρω από τις αντιρρήσεις όπου ψάχνουμε το κενό της κύρωσης
  var MAX_INT = 9e8;                   // κάτω από το γρήγορο εύρος της Clipper (~1.07e9)

  function toPaths(rings, ox, oy) {
    var out = [];
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i], p = [];
      for (var j = 0; j < r.length; j++) p.push({ X: Math.round((r[j][0] - ox) * SC), Y: Math.round((r[j][1] - oy) * SC) });
      out.push(p);
    }
    return out;
  }
  function fromPaths(paths, ox, oy) {
    var out = [];
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i]; if (p.length < 3) continue;
      var pts = [];
      for (var j = 0; j < p.length; j++) pts.push([p[j].X / SC + ox, p[j].Y / SC + oy]);
      out.push({ pts: pts, hole: !CL.Clipper.Orientation(p) });
    }
    return out;
  }
  function area(paths) { var a = 0; for (var i = 0; i < paths.length; i++) a += CL.Clipper.Area(paths[i]); return a / (SC * SC); }

  function exec(type, subj, clip, subjFill) {
    var c = new CL.Clipper();
    c.StrictlySimple = true;
    if (subj.length) c.AddPaths(subj, CL.PolyType.ptSubject, true);
    if (clip && clip.length) c.AddPaths(clip, CL.PolyType.ptClip, true);
    var sol = new CL.Paths();
    c.Execute(type, sol, subjFill || CL.PolyFillType.pftEvenOdd, CL.PolyFillType.pftNonZero);
    return sol;
  }
  function bboxOfPaths(paths) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < paths.length; i++) for (var j = 0; j < paths[i].length; j++) {
      var p = paths[i][j]; if (p.X < x0) x0 = p.X; if (p.X > x1) x1 = p.X; if (p.Y < y0) y0 = p.Y; if (p.Y > y1) y1 = p.Y;
    }
    return [x0, y0, x1, y1];
  }
  function bboxHit(a, b) { return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]); }
  function bboxOfRings(rings) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < rings.length; i++) for (var j = 0; j < rings[i].length; j++) {
      var p = rings[i][j]; if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    return [x0, y0, x1, y1];
  }

  /*  Περιοχή (bbox, μέτρα) που χρειάζεται να διαβαστεί από τα shapefiles: οι αντιρρήσεις +
   *  περιθώριο για να βρεθεί το κενό (buffer) της κύρωσης. Το UI την περνά στην ανάγνωση.  */
  function readBBox(objections) {
    var all = []; objections.forEach(function (o) { all = all.concat(o.rings); });
    var b = bboxOfRings(all), m = DETECT_MARGIN_M + 5;
    return [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
  }

  function distPtSeg(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t; var qx = ax + t * dx - px, qy = ay + t * dy - py; return Math.sqrt(qx * qx + qy * qy);
  }
  function distToPaths(pt, paths) {
    var m = Infinity;
    for (var i = 0; i < paths.length; i++) { var p = paths[i], n = p.length;
      for (var j = 0; j < n; j++) { var a = p[j], b = p[(j + 1) % n], d = distPtSeg(pt.X, pt.Y, a.X, a.Y, b.X, b.Y); if (d < m) m = d; } }
    return m;
  }

  /*  Βρίσκει το buffer από την ίδια την κύρωση: το κενό (περιοχή χωρίς κανένα πολύγωνο κύρωσης)
   *  που περιέχει την αντίρρηση. Επιστρέφει {B, info} ή null αν δεν βρεθεί αξιόπιστο κενό. */
  function detectBuffer(Ou, kyrosi, ox, oy) {
    var ob = bboxOfPaths(Ou), m = DETECT_MARGIN_M * SC, win = [ob[0] - m, ob[1] - m, ob[2] + m, ob[3] + m];
    var rect = [[{ X: win[0], Y: win[1] }, { X: win[2], Y: win[1] }, { X: win[2], Y: win[3] }, { X: win[0], Y: win[3] }]];
    var polys = [];
    kyrosi.forEach(function (r) {
      var rp = toPaths(r.rings, ox, oy);
      if (bboxHit(bboxOfPaths(rp), win)) polys = polys.concat(exec(CL.ClipType.ctUnion, rp, null, CL.PolyFillType.pftEvenOdd));
    });
    if (!polys.length) return null;
    var Ku = exec(CL.ClipType.ctUnion, polys, null, CL.PolyFillType.pftNonZero);
    var gaps = exec(CL.ClipType.ctDifference, rect, Ku, CL.PolyFillType.pftNonZero);
    var outers = [], holes = [];
    gaps.forEach(function (g) { (CL.Clipper.Orientation(g) ? outers : holes).push(g); });
    var accepted = [];
    outers.forEach(function (g) {
      var gb = bboxOfPaths([g]);
      if (gb[0] <= win[0] + 1 || gb[1] <= win[1] + 1 || gb[2] >= win[2] - 1 || gb[3] >= win[3] - 1) return;   // φτάνει στην άκρη του παραθύρου = έξω από την κύρωση, όχι buffer
      if (area(exec(CL.ClipType.ctIntersection, [g], Ou, CL.PolyFillType.pftNonZero)) <= 0) return;             // δεν αγγίζει τις αντιρρήσεις
      accepted.push(g);
      holes.forEach(function (h) { if (CL.Clipper.PointInPolygon(h[0], g) !== 0) accepted.push(h); });
    });
    if (!accepted.length) return null;
    var B = exec(CL.ClipType.ctUnion, accepted, null, CL.PolyFillType.pftNonZero);
    var outside = area(exec(CL.ClipType.ctDifference, Ou, B, CL.PolyFillType.pftNonZero)), oa = area(Ou);
    if (outside > Math.max(1, 0.02 * oa)) return null;                                                          // η αντίρρηση δεν χωράει στο κενό
    var ds = [];
    B.forEach(function (p) { p.forEach(function (v) { var d = distToPaths(v, Ou); if (d > 0) ds.push(d / SC); }); });
    ds.sort(function (a, b) { return a - b; });
    return { B: B, info: { minM: ds[0] || 0, medM: ds[ds.length >> 1] || 0, maxM: ds[ds.length - 1] || 0 } };
  }

  /*  input: { objections, kyrosi, anartisi }
   *    objections: [{id, cat, rings}]  — rings σε μέτρα (ΕΓΣΑ87), όποια φορά
   *    kyrosi / anartisi: [{id, cat, rings}] — raw δακτύλιοι από shapefile
   *  output: { objections:[piece], kyrosi:[piece], anartisi:[piece], buffer:[ring], stats, warnings }
   *    (input.fallbackBufferM: μόνο αν δεν βρεθεί κενό στην κύρωση)
   *    piece = { id, cat, rings:[{pts:[[x,y]..], hole}] }                    */
  function compute(input) {
    var warnings = [];
    var t0 = Date.now();
    var objs = input.objections;
    if (!objs.length) throw new Error('Δεν υπάρχουν αντιρρήσεις.');
    var bb = readBBox(objs);
    var ox = Math.floor(bb[0]), oy = Math.floor(bb[1]);
    var ext = 0;
    [objs, input.kyrosi, input.anartisi].forEach(function (list) { list.forEach(function (o) { o.rings.forEach(function (r) { r.forEach(function (p) {
      var dx = Math.abs(p[0] - ox), dy = Math.abs(p[1] - oy); if (dx > ext) ext = dx; if (dy > ext) ext = dy; }); }); }); });
    ext += DETECT_MARGIN_M + 10;
    SC = 100000; while (SC > 1000 && ext * SC > MAX_INT) SC /= 10;

    // 1. Κανονικοποίηση κάθε αντίρρησης + αφαίρεση επικαλύψεων μεταξύ τους (όποια προηγείται κερδίζει)
    var prevUnion = [], oPieces = [], oNorm = [];
    objs.forEach(function (o, k) {
      var p = exec(CL.ClipType.ctUnion, toPaths(o.rings, ox, oy), null, CL.PolyFillType.pftNonZero);
      var clean = prevUnion.length ? exec(CL.ClipType.ctDifference, p, prevUnion, CL.PolyFillType.pftNonZero) : p;
      if (prevUnion.length && Math.abs(area(clean) - area(p)) > 1e-6)
        warnings.push('Η αντίρρηση «' + o.id + '» επικαλύπτεται με προηγούμενη αντίρρηση· το κοινό τμήμα δόθηκε στην προηγούμενη.');
      oNorm.push(clean);
      prevUnion = prevUnion.length ? exec(CL.ClipType.ctUnion, prevUnion.concat(clean), null, CL.PolyFillType.pftNonZero) : clean;
      oPieces.push({ id: o.id, cat: o.cat, rings: fromPaths(clean, ox, oy) });
    });
    var Ou = prevUnion;

    // 2. Buffer B και δακτύλιος B − O
    // Το κενό (buffer) βρίσκεται ΞΕΧΩΡΙΣΤΑ για κάθε αντίρρηση· όπου δεν βρεθεί → ίσο buffer + προειδοποίηση
    var fm = input.fallbackBufferM || 2.5, Bparts = [], infos = [], fbIds = [];
    oNorm.forEach(function (on, k) {
      if (!on.length) return;
      var d = detectBuffer(on, input.kyrosi, ox, oy);
      if (d) { Bparts = Bparts.concat(d.B); infos.push(d.info); return; }
      fbIds.push(objs[k].id);
      var co = new CL.ClipperOffset(2, ARC_TOL_M * SC);
      co.AddPaths(on, CL.JoinType.jtRound, CL.EndType.etClosedPolygon);
      var fb = new CL.Paths(); co.Execute(fb, fm * SC); Bparts = Bparts.concat(fb);
    });
    var B = exec(CL.ClipType.ctUnion, Bparts, null, CL.PolyFillType.pftNonZero);
    var bufferInfo = { fallbackIds: fbIds, fallback: fbIds.length > 0, fallbackM: fm, minM: fm, medM: fm, maxM: fm };
    if (infos.length) {
      var meds = infos.map(function (i) { return i.medM; }).sort(function (a, b) { return a - b; });
      bufferInfo.minM = Math.min.apply(null, infos.map(function (i) { return i.minM; }));
      bufferInfo.maxM = Math.max.apply(null, infos.map(function (i) { return i.maxM; }));
      bufferInfo.medM = meds[meds.length >> 1];
    }
    if (fbIds.length) warnings.push('Δεν βρέθηκε το κενό (buffer) μέσα στην κύρωση για: ' + fbIds.join(', ') + ' — χρησιμοποιήθηκε ίσο buffer ' + fm + ' μ. Έλεγξε το αποτέλεσμα.');
    var RING = exec(CL.ClipType.ctDifference, B, Ou, CL.PolyFillType.pftNonZero);
    var Bbox = bboxOfPaths(B), Ringbox = bboxOfPaths(RING);

    // 3. Κύρωση − B  (ό,τι δεν αγγίζει το B περνά αυτούσιο, με τα ίδια vertices)
    var kOut = [], kIn = 0, kOutA = 0, kTouched = 0;
    input.kyrosi.forEach(function (r) {
      var rp = toPaths(r.rings, ox, oy);
      if (!bboxHit(bboxOfPaths(rp), Bbox)) {
        // ESRI: εξωτερικοί δακτύλιοι δεξιόστροφα (Clipper Orientation = false), τρύπες αριστερόστροφα
        kOut.push({ id: r.id, cat: r.cat, rings: r.rings.map(function (ring) {
          var pts = ring.slice(); if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
          return { pts: pts, hole: signedArea(pts) > 0 };
        }) });
        return;
      }
      kTouched++;
      var inside = exec(CL.ClipType.ctUnion, rp, null, CL.PolyFillType.pftEvenOdd);
      var res = exec(CL.ClipType.ctDifference, rp, B, CL.PolyFillType.pftEvenOdd);
      kIn += area(inside); kOutA += area(res);
      if (res.length) kOut.push({ id: r.id, cat: r.cat, rings: fromPaths(res, ox, oy) });
    });

    // 4. Ανάρτηση ∩ (B − O): κρατάμε ΟΛΑ τα κομμάτια, και τα μικρά
    var aOut = [], aArea = 0;
    input.anartisi.forEach(function (r) {
      var rp = toPaths(r.rings, ox, oy);
      if (!bboxHit(bboxOfPaths(rp), Ringbox)) return;
      var res = exec(CL.ClipType.ctIntersection, rp, RING, CL.PolyFillType.pftEvenOdd);
      var pcs = fromPaths(res, ox, oy);
      if (pcs.length) { aOut.push({ id: r.id, cat: r.cat, rings: pcs }); aArea += area(res); }
    });

    var stats = {
      objectionArea: area(Ou),
      bufferArea: area(B),
      ringArea: area(RING),
      kyrosiTouched: kTouched,
      kyrosiRemoved: kIn - kOutA,
      anartisiKept: aArea,
      buffer: bufferInfo,
      gridMm: 1000 / SC,
      ms: Date.now() - t0
    };
    var sanity = area(RING) - aArea;
    if (sanity > 1) warnings.push('Στον δακτύλιο B−O υπάρχουν ' + sanity.toFixed(1) + ' τ.μ. χωρίς πολύγωνο ανάρτησης (ίσως κενό της ανάρτησης, ή η ανάρτηση δεν καλύπτει την περιοχή).');
    var bufRings = fromPaths(B, ox, oy), reg = ptsBBox([].concat.apply([], bufRings.map(function (r) { return r.pts; })));
    var allRings = [];
    [oPieces, aOut, kOut].forEach(function (list) { list.forEach(function (pc) { allRings = allRings.concat(pc.rings); }); });
    stats.nodesAdded = nodeRings(allRings, [reg[0] - 1, reg[1] - 1, reg[2] + 1, reg[3] + 1], 3 / SC);
    return { objections: oPieces, kyrosi: kOut, anartisi: aOut, buffer: bufRings, stats: stats, warnings: warnings };
  }

  function ptsBBox(pts) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < pts.length; i++) { var p = pts[i]; if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    return [x0, y0, x1, y1];
  }

  /*  Κόμβοι (noding): κάθε κομμάτι υπολογίζεται χωριστά, άρα μια κορυφή τομής υπάρχει στο ένα
   *  πολύγωνο αλλά όχι στο γειτονικό που περνά ακριβώς από εκεί (T-junction). Σε πολύ μεγάλο ζουμ
   *  φαίνεται ως «γραμμή που δεν ενώνεται». Εδώ κάθε κορυφή που πέφτει πάνω σε ακμή ΑΛΛΟΥ δακτυλίου
   *  (σε απόσταση ≤ tol) προστίθεται και σε εκείνη την ακμή. Ελέγχονται μόνο δακτύλιοι/κορυφές
   *  μέσα στην περιοχή του buffer, εκεί όπου έγιναν οι πράξεις. */
  function nodeRings(rings, region, tol) {
    var live = rings.filter(function (r) {
      var b = ptsBBox(r.pts); return !(b[2] < region[0] || b[0] > region[2] || b[3] < region[1] || b[1] > region[3]);
    });
    var verts = [], added = 0;
    live.forEach(function (r, ri) { r.pts.forEach(function (p) {
      if (p[0] >= region[0] && p[0] <= region[2] && p[1] >= region[1] && p[1] <= region[3]) verts.push({ x: p[0], y: p[1], r: ri });
    }); });
    live.forEach(function (r, ri) {
      var pts = r.pts, n = pts.length, out = [], changed = false;
      for (var i = 0; i < n; i++) {
        var a = pts[i], b = pts[(i + 1) % n];
        out.push(a);
        var ex0 = Math.min(a[0], b[0]) - tol, ex1 = Math.max(a[0], b[0]) + tol, ey0 = Math.min(a[1], b[1]) - tol, ey1 = Math.max(a[1], b[1]) + tol;
        if (ex1 < region[0] || ex0 > region[2] || ey1 < region[1] || ey0 > region[3]) continue;
        var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
        if (!l2) continue;
        var L = Math.sqrt(l2), ins = [];
        for (var k = 0; k < verts.length; k++) {
          var v = verts[k];
          if (v.r === ri || v.x < ex0 || v.x > ex1 || v.y < ey0 || v.y > ey1) continue;
          var t = ((v.x - a[0]) * dx + (v.y - a[1]) * dy) / l2, qx = a[0] + t * dx - v.x, qy = a[1] + t * dy - v.y;
          if (qx * qx + qy * qy > tol * tol) continue;
          var along = t * L;
          if (along <= tol || along >= L - tol) continue;               // ήδη στο άκρο της ακμής
          ins.push({ s: along, x: v.x, y: v.y });
        }
        if (ins.length) {
          ins.sort(function (u, w) { return u.s - w.s; });
          var last = -Infinity;
          ins.forEach(function (q) { if (q.s - last > tol * 0.5) { out.push([q.x, q.y]); last = q.s; added++; } });
          changed = true;
        }
      }
      if (changed) r.pts = out;
    });
    return added;
  }

  function signedArea(pts) {
    var a = 0; for (var i = 0, n = pts.length; i < n; i++) { var p = pts[i], q = pts[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
    return a / 2;
  }

  return { compute: compute, readBBox: readBBox, bboxOfRings: bboxOfRings, signedArea: signedArea };
})();
