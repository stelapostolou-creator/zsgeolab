/*!
 * hepos.js — WGS84 ⇄ ΕΓΣΑ87 (GGRS87) μετατροπή με τους επίσημους συντελεστές & grids HEPOS
 * Portαρισμένο 1:1 από το SW_HEPOS (ZITopSA). Ίδια μαθηματικά:
 *   - Helmert 7 παραμέτρων (HEPOS)
 *   - Εγκάρσια Mercator (ΕΓΣΑ87, GRS80, lon0=24, k=0.9996, x0=500000)
 *   - bilinear διόρθωση dEast/dNorth (πλέγμα ΕΓΣΑ87)
 *   - geoid grid για ορθομετρικά υψόμετρα
 *
 * Εξάρτηση: proj4 (global window.proj4). Φόρτωσέ το πριν από αυτό το αρχείο:
 *   <script src="https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.9.0/proj4.js"></script>
 *   <script src="hepos.js"></script>
 *
 * Χρήση:
 *   await HEPOS.loadGrids('hepos_grids.json');
 *   const p = HEPOS.toEGSA87(39.65, 20.85, 620.0);   // lat, lon, ελλειψοειδές h
 *   // -> { x, y, z }   (z = ορθομετρικό υψόμετρο)
 *   const w = HEPOS.toWGS84(p.x, p.y, p.z);          // -> { lat, lon, h }
 */
(function (global) {
  'use strict';

  var TM_DEF = "+proj=tmerc +lat_0=0 +lon_0=24 +k=0.9996 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs";
  var TM_KEY = "EPSG:2100_GRS80";
  var grids = null;

  function proj4lib() {
    var p = global.proj4;
    if (!p) throw new Error("HEPOS: το proj4 δεν είναι φορτωμένο. Φόρτωσε πρώτα το proj4.js.");
    if (!p.defs(TM_KEY)) p.defs(TM_KEY, TM_DEF);
    return p;
  }

  /* --- Φόρτωση grids --- */
  function setGrids(g) { grids = g; }
  function hasGrids() { return !!grids; }
  function loadGrids(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HEPOS: αποτυχία φόρτωσης grids (" + r.status + ")");
      return r.json();
    }).then(function (j) { grids = j; return j; });
  }

  /* --- Bilinear interpolation (ίδιο με το HTML) --- */
  function bilinear(grid, x, y) {
    if (!grid) return 0.0;
    var col = (x - grid.min_x) / grid.dx, row = (y - grid.min_y) / grid.dy;
    var col0 = Math.floor(col), col1 = col0 + 1, row0 = Math.floor(row), row1 = row0 + 1;
    if (col0 < 0 || col1 >= grid.cols || row0 < 0 || row1 >= grid.rows) return 0.0;
    var tx = col - col0, ty = row - row0;
    var v00 = grid.data[row0][col0], v10 = grid.data[row0][col1];
    var v01 = grid.data[row1][col0], v11 = grid.data[row1][col1];
    return (v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty);
  }

  /* --- Helmert 7 παραμέτρων HEPOS (ίδιο με το HTML) --- */
  function helmert(lon, lat, h, reverse) {
    var rad = Math.PI / 180.0;
    var a = 6378137.0, f = 1 / 298.257222101;
    var e2 = 2 * f - Math.pow(f, 2);
    var N = a / Math.sqrt(1 - e2 * Math.pow(Math.sin(lat * rad), 2));
    var X = (N + h) * Math.cos(lat * rad) * Math.cos(lon * rad);
    var Y = (N + h) * Math.cos(lat * rad) * Math.sin(lon * rad);
    var Z = (N * (1 - e2) + h) * Math.sin(lat * rad);

    var mult = reverse ? -1 : 1;
    var tx = 203.437 * mult, ty = -73.461 * mult, tz = -243.594 * mult;
    var rx = (-0.170 / 3600.0) * rad * mult, ry = (-0.060 / 3600.0) * rad * mult, rz = (-0.151 / 3600.0) * rad * mult;
    var s = (-0.294 / 1000000.0) * mult;

    var X_g = tx + (1 + s) * (X + rz * Y - ry * Z);
    var Y_g = ty + (1 + s) * (-rz * X + Y + rx * Z);
    var Z_g = tz + (1 + s) * (ry * X - rx * Y + Z);

    var p = Math.sqrt(Math.pow(X_g, 2) + Math.pow(Y_g, 2));
    var lat_new = Math.atan2(Z_g, p * (1 - e2));
    for (var i = 0; i < 4; i++) {
      var N_new = a / Math.sqrt(1 - e2 * Math.pow(Math.sin(lat_new), 2));
      lat_new = Math.atan2(Z_g + e2 * N_new * Math.sin(lat_new), p);
    }
    return { lon_ggrs: Math.atan2(Y_g, X_g) / rad, lat_ggrs: lat_new / rad };
  }

  function requireGrids() {
    if (!grids) throw new Error("HEPOS: τα grids ΔΕΝ έχουν φορτωθεί — η μετατροπή θα ήταν ανακριβής (~1 m οριζόντια, ~30 m υψόμετρο). Κάλεσε HEPOS.loadGrids(url) ή HEPOS.setGrids(obj) πρώτα.");
  }

  /* --- WGS84 -> ΕΓΣΑ87 --- */
  function toEGSA87(lat, lon, h, applyZ) {
    if (applyZ === undefined) applyZ = true;
    requireGrids();
    var g = helmert(lon, lat, h, false);
    var tm = proj4lib()('WGS84', TM_KEY, [g.lon_ggrs, g.lat_ggrs]);
    var x_th = tm[0], y_th = tm[1];
    var dx = 0, dy = 0, Ng = 0;
    if (grids) {
      dx = bilinear(grids.dEast, x_th, y_th);
      dy = bilinear(grids.dNorth, x_th, y_th);
      Ng = bilinear(grids.geoid, lon, lat);
    }
    return { x: x_th + dx, y: y_th + dy, z: applyZ ? (h - Ng) : h };
  }

  /* --- ΕΓΣΑ87 -> WGS84 --- */
  function toWGS84(x, y, z, includeGeoid) {
    if (includeGeoid === undefined) includeGeoid = true;
    requireGrids();
    var dx = 0, dy = 0;
    if (grids) { dx = bilinear(grids.dEast, x, y); dy = bilinear(grids.dNorth, x, y); }
    var x_th = x - dx, y_th = y - dy;
    var w = proj4lib()(TM_KEY, 'WGS84', [x_th, y_th]);
    var lon_ggrs = w[0], lat_ggrs = w[1];

    var approx = helmert(lon_ggrs, lat_ggrs, z, true);
    var Ng = 0;
    if (grids && includeGeoid) Ng = bilinear(grids.geoid, approx.lon_ggrs, approx.lat_ggrs);
    var h = z + Ng;
    var fin = helmert(lon_ggrs, lat_ggrs, h, true);
    return { lat: fin.lat_ggrs, lon: fin.lon_ggrs, h: h };
  }

  var API = {
    loadGrids: loadGrids,
    setGrids: setGrids,
    hasGrids: hasGrids,
    toEGSA87: toEGSA87,
    toWGS84: toWGS84,
    helmert: helmert,
    bilinear: bilinear
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.HEPOS = API;

})(typeof window !== 'undefined' ? window : this);
