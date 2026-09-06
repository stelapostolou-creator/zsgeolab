/*  ZS-GeoLab — όγκοι χωματουργικών.
 *
 *  Καθαρά μαθηματικά, χωρίς οθόνη: έτσι ελέγχονται με γνωστές γεωμετρίες όπου
 *  το σωστό αποτέλεσμα είναι υπολογίσιμο με το χέρι, και έτσι μπορεί αύριο ο
 *  υπολογισμός να φύγει στον server χωρίς να αλλάξει τίποτα στη σελίδα.
 *
 *  ΜΕΘΟΔΟΣ
 *  Από τα σημεία φτιάχνεται τριγωνισμός Delaunay — η επιφάνεια του εδάφους.
 *  Μέσα στο πολύγωνο ρίχνεται κάνναβος· σε κάθε κελί το υψόμετρο βγαίνει με
 *  γραμμική παρεμβολή στο τρίγωνο που το περιέχει, και ο όγκος του κελιού
 *  είναι (υψόμετρο − αναφορά) × εμβαδόν κελιού.
 *
 *  ΓΙΑΤΙ ΚΑΝΝΑΒΟΣ ΚΑΙ ΟΧΙ ΠΡΙΣΜΑΤΑ ΑΝΑ ΤΡΙΓΩΝΟ
 *  Το πρισματικό είναι ακριβέστερο σε μία επιφάνεια, αλλά για τη διαφορά δύο
 *  επιφανειών θα απαιτούσε τομή δύο τριγωνισμών — πολύπλοκη και εύθραυστη.
 *  Ο κάνναβος δίνει την ίδια λογική και στις δύο περιπτώσεις, και η ακρίβειά
 *  του ελέγχεται: τρέχει και με μισό βήμα και συγκρίνονται τα αποτελέσματα.
 *
 *  ΤΟΠΙΚΕΣ ΣΥΝΤΕΤΑΓΜΕΝΕΣ
 *  Οι πράξεις του τριγωνισμού υψώνουν συντεταγμένες στο τετράγωνο. Με ΕΓΣΑ87
 *  (~4.400.000) χάνονται σημαντικά ψηφία, οπότε όλα γίνονται ως προς τοπική
 *  αρχή και επιστρέφονται στο τέλος.
 *
 *  Αντιστοιχεί γραμμή προς γραμμή στο tools/volumes/api/volume.py, που είναι
 *  το μέτρο σύγκρισης. Ό,τι αλλάζει εδώ, ελέγχεται απέναντί του.
 */
(function (root) {
  'use strict';

  // --------------------------------------------------------- γεωμετρία ---

  /** Εμβαδόν κλειστού δακτυλίου με τον τύπο του γεωδαίτη. Θετικό = αριστερόστροφο. */
  function ringArea(ring) {
    var a = 0;
    for (var i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
      a += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
    }
    return a / 2;
  }

  /** Απόσταση σημείου από τμήμα — για την ανοχή «πάνω στο όριο». */
  function distToSeg(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    if (L2 === 0) return Math.hypot(px - ax, py - ay);
    var t = ((px - ax) * dx + (py - ay) * dy) / L2;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  /**
   *  Σημείο μέσα στο πολύγωνο. Τα σημεία ΠΑΝΩ στο όριο μετρούν μέσα: ο
   *  τοπογράφος τα μέτρησε επίτηδες εκεί και δεν πρέπει να πετιούνται.
   */
  function inPolygon(px, py, ring, tol) {
    tol = tol == null ? 0.001 : tol;
    var n = ring.length, i, j;
    for (i = 0, j = n - 1; i < n; j = i++) {
      if (distToSeg(px, py, ring[j].x, ring[j].y, ring[i].x, ring[i].y) <= tol) return true;
    }
    var inside = false;
    for (i = 0, j = n - 1; i < n; j = i++) {
      var yi = ring[i].y, yj = ring[j].y;
      if ((yi > py) !== (yj > py)) {
        var xx = ring[i].x + (py - yi) / (yj - yi) * (ring[j].x - ring[i].x);
        if (px < xx) inside = !inside;
      }
    }
    return inside;
  }

  // ------------------------------------------------------- τριγωνισμός ---

  function circum(a, b, c) {
    var d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-12) return null;                 // συνευθειακά
    var a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
    var ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    var uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    return { x: ux, y: uy, r2: (a.x - ux) * (a.x - ux) + (a.y - uy) * (a.y - uy) };
  }

  /** Bowyer–Watson. Επιστρέφει τρίγωνα ως τριάδες δεικτών στο pts. */
  function triangulate(pts) {
    var n = pts.length;
    if (n < 3) return [];

    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    pts.forEach(function (p) {
      if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
      if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y;
    });
    var dx = maxx - minx || 1, dy = maxy - miny || 1, D = Math.max(dx, dy) * 20;
    var cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;

    // Το υπερ-τρίγωνο μπαίνει στο τέλος του πίνακα και αφαιρείται στο τέλος.
    var v = pts.slice();
    v.push({ x: cx - D, y: cy - D });
    v.push({ x: cx + D, y: cy - D });
    v.push({ x: cx, y: cy + D });
    var s0 = n, s1 = n + 1, s2 = n + 2;

    var tris = [{ a: s0, b: s1, c: s2, cc: circum(v[s0], v[s1], v[s2]) }];

    for (var i = 0; i < n; i++) {
      var p = v[i], bad = [], keep = [];
      for (var t = 0; t < tris.length; t++) {
        var tr = tris[t], cc = tr.cc;
        if (cc && ((p.x - cc.x) * (p.x - cc.x) + (p.y - cc.y) * (p.y - cc.y)) <= cc.r2 * (1 + 1e-12)) {
          bad.push(tr);
        } else keep.push(tr);
      }
      if (!bad.length) continue;                          // διπλό σημείο

      // Το περίγραμμα της «κακής» περιοχής: ακμές που δεν μοιράζονται.
      var edges = {};
      bad.forEach(function (tr) {
        [[tr.a, tr.b], [tr.b, tr.c], [tr.c, tr.a]].forEach(function (e) {
          var k = Math.min(e[0], e[1]) + ':' + Math.max(e[0], e[1]);
          edges[k] = edges[k] ? null : e;                  // δεύτερη φορά -> εσωτερική
        });
      });
      tris = keep;
      Object.keys(edges).forEach(function (k) {
        var e = edges[k];
        if (!e) return;
        var cc2 = circum(v[e[0]], v[e[1]], p);
        if (cc2) tris.push({ a: e[0], b: e[1], c: i, cc: cc2 });
      });
    }

    return tris.filter(function (t) {
      return t.a < n && t.b < n && t.c < n;
    }).map(function (t) { return [t.a, t.b, t.c]; });
  }

  /** Υψόμετρο μέσα σε τρίγωνο με βαρυκεντρικές συντεταγμένες· null αν είναι έξω. */
  function zInTriangle(px, py, A, B, C) {
    var d = (B.y - C.y) * (A.x - C.x) + (C.x - B.x) * (A.y - C.y);
    if (Math.abs(d) < 1e-12) return null;
    var l1 = ((B.y - C.y) * (px - C.x) + (C.x - B.x) * (py - C.y)) / d;
    var l2 = ((C.y - A.y) * (px - C.x) + (A.x - C.x) * (py - C.y)) / d;
    var l3 = 1 - l1 - l2;
    var e = -1e-9;
    if (l1 < e || l2 < e || l3 < e) return null;
    return l1 * A.z + l2 * B.z + l3 * C.z;
  }

  /** Το μήκος της μεγαλύτερης πλευράς ενός τριγώνου. */
  function longestEdge(t, pts) {
    var a = pts[t[0]], b = pts[t[1]], c = pts[t[2]];
    return Math.max(Math.hypot(a.x - b.x, a.y - b.y),
                    Math.hypot(b.x - c.x, b.y - c.y),
                    Math.hypot(c.x - a.x, c.y - a.y));
  }

  /**
   *  Η κλίση του τριγώνου σε μοίρες — 0 = οριζόντιο, 90 = κατακόρυφο.
   *
   *  Το όριο πλευράς πιάνει τα ΟΡΙΖΟΝΤΙΑ κενά. Δεν πιάνει την κατακόρυφη
   *  ασυνέχεια: σε πρανές, τοίχο ή μέτωπο εκσκαφής τα τρίγωνα είναι σε κάτοψη
   *  κανονικά, και ο τριγωνισμός περνάει από πάνω με ράμπα.
   *
   *  Το εργαλείο ΔΕΝ κρίνει αν αυτό είναι σωστό — δεν μπορεί να ξέρει αν οι
   *  63 μοίρες είναι πραγματικό πρανές ή σκαλοπάτι που δεν μετρήθηκε. Απλώς
   *  αναφέρει τη μεγαλύτερη κλίση, όπως αναφέρει και το αμέτρητο εμβαδόν.
   *  Την απόφαση την παίρνει ο τοπογράφος, που ξέρει τι πάτησε.
   */
  function slopeDeg(t, pts) {
    var A = pts[t[0]], B = pts[t[1]], C = pts[t[2]];
    var ux = B.x - A.x, uy = B.y - A.y, uz = B.z - A.z;
    var vx = C.x - A.x, vy = C.y - A.y, vz = C.z - A.z;
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    return Math.atan2(Math.hypot(nx, ny), Math.abs(nz)) * 180 / Math.PI;
  }

  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (p, q) { return p - q; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /**
   *  Επιφάνεια από σημεία: δίνει z(x,y), ή null όπου δεν υπάρχει μέτρηση.
   *
   *  Ο Delaunay γεμίζει ΠΑΝΤΑ το κυρτό περίβλημα των σημείων. Σε μετρήσεις με
   *  σχήμα Γ ή με τρύπα, γεφυρώνει το κενό με μακρόστενα τρίγωνα και εφευρίσκει
   *  επιφάνεια εκεί που δεν πάτησε κανείς — σιωπηλά, με σωστή όψη. Σε δοκιμή με
   *  σχήμα Γ αυτό έδωσε 49% επιπλέον όγκο.
   *
   *  Γι' αυτό τρίγωνα με πλευρά μεγαλύτερη από το όριο θεωρούνται «χωρίς
   *  μέτρηση». Το όριο βγαίνει από τα ίδια τα δεδομένα — διπλάσιο της διάμεσης
   *  πλευράς — εκτός αν το ορίσει ο χρήστης. Ο συντελεστής δοκιμάστηκε: με 1,5
   *  πετιούνται σωστά τρίγωνα σε ακανόνιστες μετρήσεις, με 3 μένουν γέφυρες.
   */
  function surface(pts, maxEdge) {
    var all = triangulate(pts);
    var lens = all.map(function (t) { return longestEdge(t, pts); });
    var lim = (maxEdge > 0) ? maxEdge : median(lens) * 2;

    var tris = [], dropped = 0, slope = [], slopeMax = 0;
    for (var i = 0; i < all.length; i++) {
      if (lens[i] > lim) { dropped++; continue; }
      var s = slopeDeg(all[i], pts);
      tris.push(all[i]); slope.push(s);
      if (s > slopeMax) slopeMax = s;
    }

    /*  Ευρετήριο θέσης. Χωρίς αυτό, κάθε κελί του κανάβου σάρωνε ΟΛΑ τα
     *  τρίγωνα: σε 3 στρέμματα με βήμα 0,5 m αυτό είναι ~12.000 κελιά ×
     *  ~2.000 τρίγωνα, και ο έλεγχος ευστάθειας το τρέχει ξανά με μισό βήμα.
     *  Το κινητό κολλούσε. Πλευρά κελιού = το όριο πλευράς, οπότε κάθε
     *  κρατημένο τρίγωνο αγγίζει το πολύ 2×2 κελιά. */
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    pts.forEach(function (p) {
      if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
      if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y;
    });
    var W = (maxx - minx) || 1, H = (maxy - miny) || 1;
    var cs = lim > 0 ? lim : Math.max(W, H) / 32;
    // Φράγμα μνήμης: με πολύ πυκνά σημεία σε μεγάλη έκταση, ο κάνναβος του
    // ευρετηρίου θα γινόταν εκατομμύρια κελιά χωρίς όφελος.
    var MAXC = 512;
    cs = Math.max(cs, W / MAXC, H / MAXC);
    var nx = Math.max(1, Math.ceil(W / cs)), ny = Math.max(1, Math.ceil(H / cs));

    var cells = new Array(nx * ny);
    for (var k = 0; k < tris.length; k++) {
      var t = tris[k], A = pts[t[0]], B = pts[t[1]], C = pts[t[2]];
      var i0 = Math.max(0, Math.floor((Math.min(A.x, B.x, C.x) - minx) / cs));
      var i1 = Math.min(nx - 1, Math.floor((Math.max(A.x, B.x, C.x) - minx) / cs));
      var j0 = Math.max(0, Math.floor((Math.min(A.y, B.y, C.y) - miny) / cs));
      var j1 = Math.min(ny - 1, Math.floor((Math.max(A.y, B.y, C.y) - miny) / cs));
      for (var jj = j0; jj <= j1; jj++) {
        for (var ii = i0; ii <= i1; ii++) {
          var idx = jj * nx + ii;
          // Αποθηκεύεται ο δείκτης, ώστε να βρίσκεται και η κλίση του τριγώνου.
          (cells[idx] || (cells[idx] = [])).push(k);
        }
      }
    }

    return {
      tris: tris,
      triangles: tris.length,
      dropped: dropped,
      maxEdge: lim,
      slopeMax: slopeMax,
      z: function (px, py) {
        var ci = Math.floor((px - minx) / cs), cj = Math.floor((py - miny) / cs);
        if (ci < 0 || cj < 0 || ci >= nx || cj >= ny) return null;
        var bucket = cells[cj * nx + ci];
        if (!bucket) return null;
        for (var i = 0; i < bucket.length; i++) {
          var b = tris[bucket[i]];
          var z = zInTriangle(px, py, pts[b[0]], pts[b[1]], pts[b[2]]);
          if (z != null) return z;
        }
        return null;
      }
    };
  }

  // -------------------------------------------- περίγραμμα μέτρησης ---

  /**
   *  Η τυπική απόσταση ανάμεσα σε γειτονικά σημεία.
   *
   *  ΓΙΑΤΙ ΟΧΙ Η ΔΙΑΜΕΣΗ ΠΛΕΥΡΑ ΤΩΝ ΤΡΙΓΩΝΩΝ. Ο τοπογράφος παίρνει αραιά
   *  σημεία στο ανοιχτό και πυκνά εκεί που αλλάζει η κλίση — δηλαδή σωστά. Τα
   *  πυκνά όμως παράγουν πολύ περισσότερα τρίγωνα, οπότε η διάμεση πλευρά
   *  πέφτει στο μέγεθος της γραμμής και όχι του ανοιχτού. Δοκιμή: αραιά ανά
   *  4 m συν γραμμή ανά 1 m έριξε το όριο στα 5,45 m και πέταξε το 80% του
   *  εδάφους.
   *
   *  Εδώ μετριέται η απόσταση κάθε σημείου από τον ΠΛΗΣΙΕΣΤΕΡΟ γείτονά του —
   *  μία τιμή ανά σημείο, όχι ανά τρίγωνο — και κρατιέται το 90ό εκατοστημόριο,
   *  δηλαδή η αραιότερη περιοχή. Τα πυκνά σημεία δίνουν μικρές τιμές που δεν
   *  παρασύρουν ένα ψηλό εκατοστημόριο.
   *
   *  Ο πλησιέστερος γείτονας βρίσκεται μέσα στις ακμές του Delaunay: το γράφημα
   *  πλησιέστερου γείτονα είναι πάντα υπογράφημά του, οπότε δεν χρειάζεται
   *  δεύτερη αναζήτηση.
   */
  function spacing(pts, tris) {
    var nn = new Array(pts.length);
    for (var i = 0; i < nn.length; i++) nn[i] = Infinity;
    tris.forEach(function (t) {
      for (var k = 0; k < 3; k++) {
        var a = t[k], b = t[(k + 1) % 3];
        var d = Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y);
        if (d < nn[a]) nn[a] = d;
        if (d < nn[b]) nn[b] = d;
      }
    });
    var v = nn.filter(function (d) { return d > 0 && isFinite(d); })
              .sort(function (p, q) { return p - q; });
    if (!v.length) return 0;
    return v[Math.min(v.length - 1, Math.floor(v.length * 0.9))];
  }

  /**
   *  Το περίγραμμα της μετρημένης περιοχής, από τα ίδια τα σημεία.
   *
   *  Ο Delaunay γεμίζει το ΚΥΡΤΟ περίβλημα, οπότε σε σχήμα Γ ή με τρύπα κλείνει
   *  και εκεί που δεν πάτησε κανείς. Αφαιρούνται πρώτα τα τρίγωνα που τεντώνουν
   *  πολύ πέρα από την τυπική απόσταση, και κρατιέται το περίγραμμα όσων
   *  έμειναν: οι ακμές που ανήκουν σε ΕΝΑ μόνο τρίγωνο.
   *
   *  Οι κορυφές που βγαίνουν είναι μετρημένα σημεία — όχι υπολογισμένα. Και το
   *  αποτέλεσμα ΦΑΙΝΕΤΑΙ στον χάρτη: αν δεν ταιριάζει, ο χρήστης το βλέπει και
   *  το αλλάζει. Ένα πεταμένο τρίγωνο δεν φαίνεται ποτέ.
   *
   *  ΧΩΡΙΣ «tight» ΒΓΑΙΝΕΙ ΤΟ ΚΥΡΤΟ ΠΕΡΙΒΛΗΜΑ, και αυτή είναι η προεπιλογή.
   *  Δεν έχει καμία παράμετρο, δεν σπάει ποτέ, δίνει πάντα έναν βρόχο. Το
   *  κοίλο περίγραμμα ακολουθεί καλύτερα ένα Γ, αλλά εξαρτάται από κατώφλι:
   *  σε δοκιμή με τυχαία σημεία, σφίξιμο 2 διέλυσε το περίγραμμα σε 9 κομμάτια
   *  και 12 m² αντί για 400. Γι' αυτό δίνεται μόνο όταν ζητηθεί ρητά, και ο
   *  αριθμός των βρόχων επιστρέφεται ώστε το κομμάτιασμα να είναι ορατό.
   */
  function hull(points, tight) {
    if (!points || points.length < 3) return { err: 'Χρειάζονται τουλάχιστον 3 σημεία.' };
    var ox = points[0].x, oy = points[0].y;
    var pts = points.map(function (p) { return { x: p.x - ox, y: p.y - oy, z: p.z }; });

    var tris = triangulate(pts);
    if (!tris.length) return { err: 'Τα σημεία είναι συνευθειακά — δεν σχηματίζεται περίγραμμα.' };

    var sp = spacing(pts, tris);
    // Χωρίς σφίξιμο δεν πετιέται κανένα τρίγωνο, οπότε το περίγραμμα των
    // τριγώνων ΕΙΝΑΙ το κυρτό περίβλημα.
    var limit = (tight > 0) ? tight * sp : Infinity;

    var keep = tris.filter(function (t) { return longestEdge(t, pts) <= limit; });
    if (!keep.length) return { err: 'Το σφίξιμο είναι πολύ μικρό — δεν έμεινε τίποτα.' };

    // Ακμή που ανήκει σε ένα μόνο τρίγωνο βρίσκεται στο περίγραμμα.
    function ek(a, b) { return Math.min(a, b) + ':' + Math.max(a, b); }
    var seen = {}, keptEdge = {};
    keep.forEach(function (t) {
      [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]].forEach(function (e) {
        var k = ek(e[0], e[1]);
        seen[k] = (seen[k] || 0) + 1;
        keptEdge[k] = e;
      });
    });
    var adj = {}, edges = [];
    Object.keys(seen).forEach(function (k) {
      if (seen[k] !== 1) return;
      var e = keptEdge[k];
      edges.push(e);
      (adj[e[0]] || (adj[e[0]] = [])).push(e[1]);
      (adj[e[1]] || (adj[e[1]] = [])).push(e[0]);
    });

    // Οι ακμές δένονται σε κλειστούς βρόχους. Πάνω από έναν σημαίνει τρύπα ή
    // χωρισμένη μέτρηση· κρατιέται ο μεγαλύτερος και αναφέρονται οι υπόλοιποι.
    var used = {}, rings = [];
    edges.forEach(function (e0) {
      if (used[ek(e0[0], e0[1])]) return;
      used[ek(e0[0], e0[1])] = 1;
      var ring = [e0[0]], prev = e0[0], cur = e0[1];
      while (cur !== e0[0]) {
        ring.push(cur);
        var nb = adj[cur] || [], nxt = -1;
        for (var i = 0; i < nb.length; i++) {
          if (nb[i] === prev || used[ek(cur, nb[i])]) continue;
          nxt = nb[i]; break;
        }
        if (nxt < 0) { ring = null; break; }      // ανοιχτή αλυσίδα, πετιέται
        used[ek(cur, nxt)] = 1;
        prev = cur; cur = nxt;
      }
      if (ring && ring.length >= 3) rings.push(ring);
    });
    if (!rings.length) return { err: 'Δεν σχηματίστηκε κλειστό περίγραμμα.' };

    rings.sort(function (a, b) {
      return Math.abs(ringArea(b.map(function (i) { return pts[i]; }))) -
             Math.abs(ringArea(a.map(function (i) { return pts[i]; })));
    });
    var best = rings[0].map(function (i) {
      return { x: pts[i].x + ox, y: pts[i].y + oy, z: pts[i].z };
    });
    return {
      ring: best,
      area: Math.abs(ringArea(rings[0].map(function (i) { return pts[i]; }))),
      spacing: sp,
      limit: limit,
      rings: rings.length,
      triangles: keep.length,
      dropped: tris.length - keep.length
    };
  }

  // ------------------------------------------------- έλεγχοι πριν τον --
  // ------------------------------------------------- υπολογισμό --------

  /**
   *  Σημεία και πολύγωνο πρέπει να είναι στο ίδιο σύστημα.
   *
   *  Αν απέχουν περισσότερο από όσο εξηγείται, ο υπολογισμός θα έδινε μηδενική
   *  κάλυψη — ή, χειρότερα, έναν αριθμό. Καλύτερα να το πει.
   */
  function farApart(points, ring) {
    if (!points.length || !ring.length) return { bad: false, dist: 0 };
    var px = points.map(function (p) { return p.x; });
    var py = points.map(function (p) { return p.y; });
    var rx = ring.map(function (p) { return p.x; });
    var ry = ring.map(function (p) { return p.y; });
    var cx = (Math.min.apply(null, px) + Math.max.apply(null, px)) / 2;
    var cy = (Math.min.apply(null, py) + Math.max.apply(null, py)) / 2;
    var dx = (Math.min.apply(null, rx) + Math.max.apply(null, rx)) / 2;
    var dy = (Math.min.apply(null, ry) + Math.max.apply(null, ry)) / 2;
    var dist = Math.hypot(cx - dx, cy - dy);
    var span = Math.max(Math.max.apply(null, px) - Math.min.apply(null, px),
                        Math.max.apply(null, py) - Math.min.apply(null, py),
                        Math.max.apply(null, rx) - Math.min.apply(null, rx),
                        Math.max.apply(null, ry) - Math.min.apply(null, ry), 1);
    return { bad: dist > 10 * span + 1000, dist: dist };
  }

  // ------------------------------------------------------------- όγκοι ---

  /**
   *  opts: {points, ring, spacing, refZ | points2, maxEdge}
   *  Όλα σε ΕΓΣΑ87 (μέτρα). Επιστρέφει m³ και m².
   */
  function compute(opts) {
    var ring = opts.ring || [];
    if (ring.length < 3) return { err: 'Το πολύγωνο χρειάζεται τουλάχιστον 3 κορυφές.' };
    var pts = (opts.points || []).slice();
    if (pts.length < 3) return { err: 'Χρειάζονται τουλάχιστον 3 σημεία με υψόμετρο.' };
    var h = opts.spacing;
    if (!(h > 0)) return { err: 'Το βήμα του κανάβου πρέπει να είναι θετικό.' };
    var pts2 = opts.points2 || null;
    if (pts2 && pts2.length < 3) return { err: 'Η δεύτερη επιφάνεια χρειάζεται τουλάχιστον 3 σημεία.' };
    if (!pts2 && !Number.isFinite(opts.refZ)) return { err: 'Δώσε τελικό υψόμετρο ή δεύτερη επιφάνεια.' };

    var fa = farApart(pts, ring);
    if (fa.bad) return { err: 'Τα σημεία και το πολύγωνο απέχουν ' + fa.dist.toFixed(0) +
      ' m — μάλλον δεν είναι στο ίδιο σύστημα συντεταγμένων.' };
    if (pts2) {
      var fa2 = farApart(pts2, ring);
      if (fa2.bad) return { err: 'Η δεύτερη επιφάνεια απέχει ' + fa2.dist.toFixed(0) +
        ' m από το πολύγωνο — μάλλον άλλο σύστημα συντεταγμένων.' };
    }

    // Τοπική αρχή: αλλιώς τα τετράγωνα των συντεταγμένων χάνουν ακρίβεια.
    var ox = ring[0].x, oy = ring[0].y;
    var L = function (p) { return { x: p.x - ox, y: p.y - oy, z: p.z }; };
    var R = ring.map(L), Pa = pts.map(L);
    var Pb = pts2 ? pts2.map(L) : null;

    var sa = surface(Pa, opts.maxEdge);
    var sb = Pb ? surface(Pb, opts.maxEdge) : null;
    if (!sa.tris.length) return { err: 'Τα σημεία είναι συνευθειακά — δεν σχηματίζεται επιφάνεια.' };
    if (sb && !sb.tris.length) return { err: 'Τα σημεία της δεύτερης επιφάνειας είναι συνευθειακά.' };

    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    R.forEach(function (p) {
      if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
      if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y;
    });

    // Οι θέσεις βγαίνουν από δείκτη και όχι με άθροιση βήματος: σε μεγάλα
    // πολύγωνα η επαναλαμβανόμενη πρόσθεση παρασύρει την τελευταία στήλη.
    var nx = Math.ceil((maxx - (minx + h / 2)) / h);
    var ny = Math.ceil((maxy - (miny + h / 2)) / h);
    if (nx <= 0 || ny <= 0) return { err: 'Το βήμα είναι μεγαλύτερο από την περιοχή.' };

    var cell = h * h, cut = 0, fill = 0, nIn = 0, nCov = 0;
    for (var jy = 0; jy < ny; jy++) {
      var y = miny + h / 2 + jy * h;
      for (var ix = 0; ix < nx; ix++) {
        var x = minx + h / 2 + ix * h;
        if (!inPolygon(x, y, R)) continue;
        nIn++;
        var za = sa.z(x, y);
        if (za == null) continue;
        var zb = sb ? sb.z(x, y) : opts.refZ;
        if (zb == null) continue;
        nCov++;
        var d = za - zb;
        if (d > 0) cut += d * cell; else fill += -d * cell;
      }
    }
    if (!nIn) return { err: 'Κανένα κελί δεν έπεσε μέσα στο πολύγωνο — μίκρυνε το βήμα.' };

    return {
      areaPolygon: Math.abs(ringArea(R)),
      areaCells: nIn * cell,
      areaCovered: nCov * cell,
      areaUncovered: (nIn - nCov) * cell,
      // Το +0 αποφεύγει το «−0,0» όταν δεν υπάρχει καθόλου επίχωση.
      cut: cut + 0, fill: fill + 0, net: cut - fill,
      cells: nIn, covered: nCov, spacing: h,
      triangles: sa.triangles, trianglesDropped: sa.dropped,
      maxEdge: sa.maxEdge, maxEdge2: sb ? sb.maxEdge : null,
      slopeMax: Math.max(sa.slopeMax, sb ? sb.slopeMax : 0),
      points: pts.length
    };
  }

  /**
   *  Τρέχει και με μισό βήμα. Αν τα δύο αποτελέσματα απέχουν πολύ, ο κάνναβος
   *  δεν είναι αρκετά πυκνός για το ανάγλυφο — και ο αριθμός δεν στέκει.
   */
  function computeChecked(opts) {
    var a = compute(opts);
    if (a.err) return a;
    var b = compute(Object.assign({}, opts, { spacing: opts.spacing / 2 }));
    if (b.err) return a;
    var base = Math.max(Math.abs(a.net), Math.abs(b.net), 1e-9);
    a.half = { cut: b.cut, fill: b.fill, net: b.net, spacing: b.spacing };
    a.driftPct = Math.abs(a.net - b.net) / base * 100;
    return a;
  }

  root.Vol = {
    ringArea: ringArea, inPolygon: inPolygon, triangulate: triangulate,
    surface: surface, spacing: spacing, hull: hull, farApart: farApart,
    compute: compute, computeChecked: computeChecked
  };
})(typeof window !== 'undefined' ? window : globalThis);
