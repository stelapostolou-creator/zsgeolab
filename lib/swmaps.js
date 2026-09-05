/*!
 * swmaps.js — Κοινός reader για δεδομένα SW Maps (.swm2 SQLite & Excel .xlsx).
 * Διαβάζει ΟΛΑ τα σχήματα (POINT / LINE / POLYGON) με σωστή γεωμετρία.
 * Κοινό για: SW_Maps GR Helper (ΕΓΣΑ87) & SW Maps Stake Out Helper (παγκόσμιο).
 *
 * Ενιαίο μοντέλο:
 *   {
 *     source: 'db' | 'excel',
 *     layers:   [{ name, geomType, color }],            // geomType: 'POINT'|'LINE'|'POLYGON'
 *     features: [{ layer, geomType, name, remarks, color, pts:[{lon,lat,elv,ortho}] }]
 *   }
 *
 * Χρήση:
 *   var model = SWMaps.fromDb(sqlJsDatabase);          // sql.js Database
 *   var model = SWMaps.fromWorkbook(xlsxWorkbook);     // SheetJS workbook
 */
(function (global) {
  'use strict';

  var SKIP_SHEETS = { PHOTOS: 1, TRACKS: 1, TRACK_POINTS: 1, FEATURE_POINTS: 1 };

  function androidColorToHex(c) {
    if (c == null || isNaN(c)) return '#e0353a';
    var u = (c >>> 0) & 0xFFFFFF;               // ARGB -> RGB
    return '#' + ('000000' + u.toString(16)).slice(-6);
  }

  function normGeom(t) {
    t = (t || '').toUpperCase();
    if (t.indexOf('POLYGON') >= 0) return 'POLYGON';
    if (t.indexOf('LINE') >= 0) return 'LINE';     // LINE / LINESTRING
    return 'POINT';
  }

  /* --- WKT parser: υποστηρίζει κόμμα-δεκαδικό (SW Maps GR export) & τελεία-δεκαδικό --- */
  function parseWKT(wkt) {
    if (!wkt) return null;
    var s = String(wkt).trim();
    var m = s.match(/^(MULTIPOLYGON|POLYGON|MULTILINESTRING|LINESTRING|POINT)\s*(ZM|Z|M)?\s*\(([\s\S]*)\)\s*$/i);
    if (!m) return null;
    var type = m[1].toUpperCase();
    var hasZ = (m[2] || '').toUpperCase().indexOf('Z') >= 0;
    var dims = hasZ ? 3 : 2;
    var inner = m[3].replace(/[()]/g, ' ');        // «ισοπεδώνει» rings/multi
    var commaDecimal = /\d,\d/.test(inner);        // π.χ. "20,648"
    var nums;
    if (commaDecimal) {
      // Κάθε αριθμός είναι "int,frac". Οι κόμμα-διαχωριστές κορυφών ΔΕΝ έχουν frac μετά με τελεία.
      var mm = inner.match(/-?\d+,\d+/g) || [];
      nums = mm.map(function (t) { return parseFloat(t.replace(',', '.')); });
    } else {
      // Τελεία-δεκαδικό: κορυφές με κόμμα, συντεταγμένες με κενό.
      nums = [];
      inner.split(',').forEach(function (v) {
        v.trim().split(/\s+/).forEach(function (n) {
          if (n !== '') { var f = parseFloat(n); if (!isNaN(f)) nums.push(f); }
        });
      });
    }
    var coords = [];
    for (var i = 0; i + dims - 1 < nums.length; i += dims) {
      coords.push({ lon: nums[i], lat: nums[i + 1], elv: dims >= 3 ? nums[i + 2] : 0 });
    }
    return { type: normGeom(type), coords: coords };
  }

  /* --- DB (.swm2) → μοντέλο --- */
  function fromDb(db) {
    function rows(sql) {
      var r = db.exec(sql);
      if (!r || !r.length) return [];
      var cols = r[0].columns, vals = r[0].values;
      return vals.map(function (row) {
        var o = {}; cols.forEach(function (c, i) { o[c] = row[i]; }); return o;
      });
    }
    var layerById = {}, layers = [];
    rows("SELECT uuid,name,geom_type,color,line_width FROM feature_layers").forEach(function (l) {
      var L = { name: l.name || 'SWMaps', geomType: normGeom(l.geom_type), color: androidColorToHex(l.color) };
      layerById[l.uuid] = L; layers.push(L);
    });
    var featById = {};
    rows("SELECT uuid,layer_id,COALESCE(name,'') AS name,COALESCE(remarks,'') AS remarks FROM features").forEach(function (f) {
      var L = layerById[f.layer_id] || { name: 'SWMaps', geomType: 'POINT', color: '#e0353a' };
      featById[f.uuid] = { layer: L.name, geomType: L.geomType, name: (f.name || '').trim(), remarks: (f.remarks || '').trim(), color: L.color, pts: [] };
    });
    rows("SELECT fid,seq,lat,lon,elv,ortho_ht,fix_quality FROM points WHERE lat IS NOT NULL AND lon IS NOT NULL ORDER BY fid,seq").forEach(function (p) {
      var F = featById[p.fid];
      if (!F) return;
      F.pts.push({ lon: p.lon, lat: p.lat, elv: p.elv || 0, ortho: (p.ortho_ht != null ? p.ortho_ht : 0), fix: (p.fix_quality != null ? p.fix_quality : '') });
    });
    var features = Object.keys(featById).map(function (k) { return featById[k]; }).filter(function (f) { return f.pts.length > 0; });
    // CRS του project (αν ο χρήστης το έχει ορίσει στο SW Maps· αλλιώς λείπει = auto/WGS84)
    var crs = null;
    try {
      var pr = rows("SELECT value FROM project_info WHERE attr='crs'");
      if (pr.length && pr[0].value) { var j = JSON.parse(pr[0].value); if (j && j.code) crs = { code: +j.code, name: j.name || ('EPSG:' + j.code) }; }
    } catch (e) { /* ignore */ }
    return { source: 'db', crs: crs, layers: layers, features: features };
  }

  /* --- Excel (.xlsx) → μοντέλο --- */
  function fromWorkbook(wb) {
    if (!global.XLSX) throw new Error('SWMaps: το SheetJS (XLSX) δεν είναι φορτωμένο.');
    var layersMap = {}, features = [];
    wb.SheetNames.forEach(function (sheet) {
      if (SKIP_SHEETS[sheet.toUpperCase()]) return;
      var ws = wb.Sheets[sheet];
      var data = global.XLSX.utils.sheet_to_json(ws, { defval: '' });
      if (!data.length) return;
      data.forEach(function (row) {
        var geom = row.Geometry || row.geometry || row.WKT;
        if (!geom) return;
        var g = parseWKT(geom);
        if (!g || !g.coords.length) return;
        var name = String(row.Name || row['Feature Name'] || row.ID || row.id || '').trim();
        var remarks = String(row.Remarks || row.remarks || '').trim();
        // «ύψος»: προτίμηση Ortho Height, αλλιώς Elevation, αλλιώς από WKT z
        var ortho = row['Ortho Height']; if (ortho === '' || ortho == null) ortho = null;
        var fixVal = (row['Fix ID'] !== '' && row['Fix ID'] != null) ? row['Fix ID'] : '';
        if (!layersMap[sheet]) layersMap[sheet] = { name: sheet, geomType: g.type, color: '#e0353a' };
        else if (layersMap[sheet].geomType === 'POINT' && g.type !== 'POINT') layersMap[sheet].geomType = g.type;
        var pts = g.coords.map(function (c) { return { lon: c.lon, lat: c.lat, elv: c.elv || 0, ortho: (ortho != null ? +ortho : (c.elv || 0)), fix: fixVal }; });
        features.push({ layer: sheet, geomType: g.type, name: name, remarks: remarks, color: '#e0353a', pts: pts });
      });
    });
    return { source: 'excel', crs: null, layers: Object.keys(layersMap).map(function (k) { return layersMap[k]; }), features: features };
  }

  /* --- CSV (SW Maps export ή γενικό) → μοντέλο --- */
  function splitCSVLine(line, delim) {
    var out = [], cur = '', q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else { if (ch === '"') q = true; else if (ch === delim) { out.push(cur); cur = ''; } else cur += ch; }
    }
    out.push(cur);
    return out;
  }
  function csvNum(v) {
    if (v == null) return NaN;
    var s = String(v).trim();
    if (!s) return NaN;
    return parseFloat(s.replace(/\s/g, '').replace(',', '.'));   // κόμμα ή τελεία δεκαδικό
  }
  function pickCol(header, re, dflt) {
    if (header) for (var i = 0; i < header.length; i++) if (re.test(header[i])) return i;
    return dflt == null ? -1 : dflt;
  }
  function colMedian(data, c) {
    var a = [];
    for (var i = 0; i < data.length; i++) { var v = csvNum(data[i][c]); if (isFinite(v)) a.push(v); }
    if (!a.length) return NaN;
    a.sort(function (p, q) { return p - q; });
    return a[Math.floor(a.length / 2)];
  }

  // fromCSV(text, layerName, xy2geo?)  — xy2geo: function(X,Y)->{lon,lat} για ΕΓΣΑ87 CSV
  function fromCSV(text, layerName, xy2geo) {
    var raw = String(text == null ? '' : text).replace(/^﻿/, '');
    var lines = raw.split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    var lname = layerName || 'CSV';
    if (!lines.length) return { source: 'csv', crs: null, layers: [], features: [] };
    // διαχωριστικό = αυτό που δίνει τις περισσότερες στήλες
    var best = [';', ',', '\t'].map(function (d) { return { d: d, n: splitCSVLine(lines[0], d).length }; })
      .sort(function (a, b) { return b.n - a.n; })[0];
    var delim = best.n > 1 ? best.d : ',';
    var rows = lines.map(function (l) { return splitCSVLine(l, delim).map(function (c) { return c.trim(); }); });
    var ncol = rows[0].length;
    var isWkt = function (v) { return /^\s*"?\s*(MULTI)?(POINT|LINESTRING|POLYGON)/i.test(v || ''); };

    // στήλη WKT;
    var wktIdx = -1;
    for (var c = 0; c < ncol && wktIdx < 0; c++)
      for (var ri = 0; ri < Math.min(rows.length, 4); ri++)
        if (isWkt(rows[ri][c])) { wktIdx = c; break; }

    // επικεφαλίδες; (λίγα αριθμητικά στην 1η γραμμή & όχι WKT εκεί)
    var numInRow0 = rows[0].filter(function (v) { return v !== '' && isFinite(csvNum(v)); }).length;
    var hasHeader = numInRow0 < Math.max(1, Math.ceil(ncol / 2)) && !(wktIdx >= 0 && isWkt(rows[0][wktIdx]));
    var header = hasHeader ? rows[0].map(function (s) { return s.toLowerCase(); }) : null;
    var data = hasHeader ? rows.slice(1) : rows;
    if (!data.length) return { source: 'csv', crs: null, layers: [], features: [] };

    var nameIdx = pickCol(header, /name|feature|^id$|όνομα|σημ|point|κωδ/, -1);
    var remIdx = pickCol(header, /remark|desc|note|^code$|περιγρ|σχολ/, -1);
    var orthoIdx = pickCol(header, /ortho|orthom|ορθομ|geoid|msl/, -1);
    var elevIdx = pickCol(header, /elev|alt|height|ellip|ύψ|hae|^z$|^h$/, -1);
    var fixIdx = pickCol(header, /fix|quality|ποιότ/, -1);

    if (wktIdx >= 0) {
      var feats = [], gtypes = {};
      data.forEach(function (r) {
        if (!r[wktIdx]) return;
        var g = parseWKT(r[wktIdx]); if (!g || !g.coords.length) return;
        var ortho = orthoIdx >= 0 ? csvNum(r[orthoIdx]) : NaN;
        var elev = elevIdx >= 0 ? csvNum(r[elevIdx]) : NaN;
        var pts = g.coords.map(function (cc) {
          return { lon: cc.lon, lat: cc.lat, elv: (isFinite(elev) ? elev : (cc.elv || 0)), ortho: (isFinite(ortho) ? ortho : null), fix: '' };
        });
        gtypes[g.type] = 1;
        feats.push({ layer: lname, geomType: g.type, name: (nameIdx >= 0 ? String(r[nameIdx] || '') : '').trim(), remarks: (remIdx >= 0 ? String(r[remIdx] || '') : '').trim(), color: '#e0353a', pts: pts });
      });
      var lys = Object.keys(gtypes).map(function (t) { return { name: lname, geomType: t, color: '#e0353a' }; });
      return { source: 'csv', crs: null, layers: lys.length ? lys : [{ name: lname, geomType: 'POINT', color: '#e0353a' }], features: feats };
    }

    // χωρίς WKT → εντοπισμός lat/lon (ή ΕΓΣΑ87 X/Y) + υψόμετρο ανά όνομα ή εύρος τιμών
    var latI = pickCol(header, /^lat|latitude|πλάτ/, -1), lonI = pickCol(header, /^lon|^lng|longitude|μήκ/, -1);
    var xI = -1, yI = -1, egsa = false;
    if (latI < 0 || lonI < 0) {
      for (var c2 = 0; c2 < ncol; c2++) {
        var m = colMedian(data, c2); if (!isFinite(m)) continue;
        if (latI < 0 && m >= 33 && m <= 42) latI = c2;
        else if (lonI < 0 && m >= 18 && m <= 30) lonI = c2;
        else if (xI < 0 && m >= 90000 && m <= 900000) xI = c2;
        else if (yI < 0 && m >= 3800000 && m <= 4700000) yI = c2;
      }
      if ((latI < 0 || lonI < 0) && xI >= 0 && yI >= 0) egsa = true;
    }
    if (!egsa && (latI < 0 || lonI < 0)) throw new Error('Δεν βρέθηκαν στήλες lat/lon (ή X/Y ΕΓΣΑ87) στο CSV.');
    if (elevIdx < 0) {
      for (var c3 = 0; c3 < ncol; c3++) {
        if (c3 === latI || c3 === lonI || c3 === xI || c3 === yI) continue;
        var mm = colMedian(data, c3);
        if (isFinite(mm) && mm > -500 && mm < 5000) { elevIdx = c3; break; }
      }
    }
    if (nameIdx < 0) {
      for (var c4 = 0; c4 < ncol; c4++) {
        if (c4 === latI || c4 === lonI || c4 === xI || c4 === yI || c4 === elevIdx) continue;
        var textish = false;
        for (var k = 0; k < Math.min(data.length, 5); k++) if (data[k][c4] && !isFinite(csvNum(data[k][c4]))) { textish = true; break; }
        if (textish) { nameIdx = c4; break; }
      }
      if (nameIdx < 0) nameIdx = 0;
    }
    var features2 = [];
    data.forEach(function (r) {
      var lon, lat;
      if (egsa) {
        var X = csvNum(r[xI]), Y = csvNum(r[yI]);
        if (!isFinite(X) || !isFinite(Y)) return;
        if (typeof xy2geo === 'function') { var g2 = xy2geo(X, Y); lon = g2.lon; lat = g2.lat; }
        else { lon = X; lat = Y; }   // fallback (θα διορθωθεί από τον caller)
      } else {
        lat = csvNum(r[latI]); lon = csvNum(r[lonI]);
      }
      if (!isFinite(lat) || !isFinite(lon)) return;
      var elv = elevIdx >= 0 ? csvNum(r[elevIdx]) : 0; if (!isFinite(elv)) elv = 0;
      var ortho = orthoIdx >= 0 ? csvNum(r[orthoIdx]) : NaN;
      features2.push({
        layer: lname, geomType: 'POINT',
        name: (nameIdx >= 0 ? String(r[nameIdx] || '') : '').trim(),
        remarks: (remIdx >= 0 ? String(r[remIdx] || '') : '').trim(),
        color: '#e0353a',
        pts: [{ lon: lon, lat: lat, elv: elv, ortho: (isFinite(ortho) ? ortho : null), fix: (fixIdx >= 0 ? String(r[fixIdx] || '').trim() : '') }]
      });
    });
    return { source: 'csv', crs: (egsa ? { code: 2100, name: 'EGSA87 (από CSV)' } : null), layers: [{ name: lname, geomType: 'POINT', color: '#e0353a' }], features: features2 };
  }

  /* Σύνοψη για έλεγχο/εμφάνιση */
  function summarize(model) {
    var by = { POINT: 0, LINE: 0, POLYGON: 0 }, verts = 0;
    model.features.forEach(function (f) { by[f.geomType] = (by[f.geomType] || 0) + 1; verts += f.pts.length; });
    return { source: model.source, layers: model.layers.length, features: model.features.length, byType: by, vertices: verts };
  }

  var API = { fromDb: fromDb, fromWorkbook: fromWorkbook, fromCSV: fromCSV, parseWKT: parseWKT, androidColorToHex: androidColorToHex, summarize: summarize };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.SWMaps = API;

})(typeof window !== 'undefined' ? window : this);
