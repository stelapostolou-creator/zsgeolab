/*  Δασικός χάρτης — ανάγνωση αρχείων (zip / shp / dbf / dxf) και εγγραφή DXF.
 *
 *  Τα shapefiles διαβάζονται ΣΕ ΡΕΥΜΑ (stream) και φιλτράρονται κατά την ανάγνωση
 *  με το bbox της κάθε εγγραφής: μόνο τα πολύγωνα που αγγίζουν την περιοχή
 *  αποκωδικοποιούνται πλήρως· τα υπόλοιπα προσπερνιούνται. Έτσι ένα shp νομού
 *  (δεκάδες/εκατοντάδες MB) ή και μεγαλύτερο δεν φορτώνεται ποτέ ολόκληρο στη μνήμη.
 */
var DasikosIO = (function () {
  'use strict';

  /* ---------- ByteStream: αγνωστικό ως προς την πηγή (αρχείο ή zip entry) ---------- */
  function ByteStream(reader) { this.r = reader; this.buf = new Uint8Array(0); this.pos = 0; this.eof = false; }
  ByteStream.prototype.avail = function () { return this.buf.length - this.pos; };
  ByteStream.prototype.ensure = async function (n) {
    if (this.avail() >= n) return true;
    var parts = [this.buf.subarray(this.pos)], got = this.avail();
    while (got < n) {
      var c = await this.r.read();
      if (c.done) { this.eof = true; break; }
      parts.push(c.value); got += c.value.length;
    }
    var nb = new Uint8Array(got), o = 0;
    for (var i = 0; i < parts.length; i++) { nb.set(parts[i], o); o += parts[i].length; }
    this.buf = nb; this.pos = 0;
    return got >= n;
  };
  ByteStream.prototype.skip = async function (n) {
    var a = this.avail();
    if (n <= a) { this.pos += n; return; }
    n -= a; this.buf = new Uint8Array(0); this.pos = 0;
    while (n > 0) {
      var c = await this.r.read();
      if (c.done) { this.eof = true; return; }
      if (c.value.length <= n) n -= c.value.length; else { this.buf = c.value; this.pos = n; n = 0; }
    }
  };

  /*  Παραχώρηση του thread για ενημέρωση προόδου. MessageChannel αντί setTimeout: ο browser
   *  καθυστερεί τα setTimeout σε κρυφή καρτέλα (~1 s το καθένα), τα μηνύματα όχι. */
  var mc = null, mcWait = null;
  function yieldNow() {
    if (!mc) { mc = new MessageChannel(); mc.port1.onmessage = function () { var r = mcWait; mcWait = null; if (r) r(); }; }
    return new Promise(function (r) { mcWait = r; mc.port2.postMessage(0); });
  }

  /* ---------- Πρόσβαση σε αρχεία: απλό File ή είσοδος μέσα σε zip ---------- */
  function fileAcc(file) {
    return {
      name: file.name, size: file.size,
      stream: function () { return Promise.resolve(file.stream().getReader()); },
      slice: function (a, b) { return file.slice(a, b).arrayBuffer().then(function (x) { return new Uint8Array(x); }); },
      bytes: function () { return file.arrayBuffer().then(function (x) { return new Uint8Array(x); }); }
    };
  }
  function u16(d, o) { return d[o] | (d[o + 1] << 8); }
  function u32(d, o) { return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0; }
  function u64(d, o) { return u32(d, o) + u32(d, o + 4) * 4294967296; }

  async function readZipDirectory(file) {
    var tailLen = Math.min(file.size, 65557 + 22);
    var tail = new Uint8Array(await file.slice(file.size - tailLen, file.size).arrayBuffer());
    var e = -1;
    for (var i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('Το αρχείο δεν φαίνεται να είναι έγκυρο zip.');
    var total = u16(tail, e + 10), cdSize = u32(tail, e + 12), cdOff = u32(tail, e + 16);
    if (cdOff === 0xFFFFFFFF || total === 0xFFFF || cdSize === 0xFFFFFFFF) {           // zip64
      var loc = e - 20;
      if (loc < 0 || u32(tail, loc) !== 0x07064b50) throw new Error('Μη υποστηριζόμενο zip64.');
      var z64 = u64(tail, loc + 8);
      var z = new Uint8Array(await file.slice(z64, z64 + 56).arrayBuffer());
      if (u32(z, 0) !== 0x06064b50) throw new Error('Μη έγκυρο zip64.');
      total = u64(z, 32); cdSize = u64(z, 40); cdOff = u64(z, 48);
    }
    var cd = new Uint8Array(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
    var entries = [], p = 0;
    for (var k = 0; k < total && p + 46 <= cd.length; k++) {
      if (u32(cd, p) !== 0x02014b50) break;
      var flags = u16(cd, p + 8), method = u16(cd, p + 10);
      var csize = u32(cd, p + 20), usize = u32(cd, p + 24);
      var nl = u16(cd, p + 28), xl = u16(cd, p + 30), cl = u16(cd, p + 32), off = u32(cd, p + 42);
      var name = new TextDecoder('utf-8').decode(cd.subarray(p + 46, p + 46 + nl));
      if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || off === 0xFFFFFFFF) {
        var x = p + 46 + nl, xe = x + xl;
        while (x + 4 <= xe) {
          var id = u16(cd, x), sz = u16(cd, x + 2);
          if (id === 1) {
            var q = x + 4;
            if (usize === 0xFFFFFFFF) { usize = u64(cd, q); q += 8; }
            if (csize === 0xFFFFFFFF) { csize = u64(cd, q); q += 8; }
            if (off === 0xFFFFFFFF) { off = u64(cd, q); q += 8; }
          }
          x += 4 + sz;
        }
      }
      entries.push({ name: name, flags: flags, method: method, csize: csize, usize: usize, off: off });
      p += 46 + nl + xl + cl;
    }
    return entries;
  }
  function zipEntryAcc(file, e) {
    var cache = null;
    function open() {
      if (e.flags & 1) throw new Error('Το zip είναι κρυπτογραφημένο.');
      return file.slice(e.off, e.off + 30).arrayBuffer().then(function (h) {
        var d = new Uint8Array(h);
        if (u32(d, 0) !== 0x04034b50) throw new Error('Κατεστραμμένο zip (local header).');
        var start = e.off + 30 + u16(d, 26) + u16(d, 28);
        var blob = file.slice(start, start + e.csize), s = blob.stream();
        if (e.method === 8) s = s.pipeThrough(new DecompressionStream('deflate-raw'));
        else if (e.method !== 0) throw new Error('Μη υποστηριζόμενη συμπίεση zip (' + e.method + ').');
        return s.getReader();
      });
    }
    async function bytes() {
      if (cache) return cache;
      var r = await open(), out = new Uint8Array(e.usize), o = 0;
      for (;;) { var c = await r.read(); if (c.done) break; out.set(c.value, o); o += c.value.length; }
      cache = out; return cache;
    }
    return {
      name: e.name, size: e.usize, stream: open, bytes: bytes,
      slice: function (a, b) { return bytes().then(function (x) { return x.subarray(a, b); }); }
    };
  }

  /*  Από μια λίστα αρχείων (ένα zip Ή shp+shx+dbf+cpg+prj) βγάζει datasets.
   *  Ένα zip μπορεί να έχει πολλά shp (π.χ. 2021 και 2022) — επιστρέφονται όλα. */
  async function listDatasets(fileList) {
    var files = Array.prototype.slice.call(fileList), accs = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (/\.zip$/i.test(f.name)) {
        var ents = await readZipDirectory(f);
        ents.forEach(function (e) { if (!/\/$/.test(e.name)) accs.push(zipEntryAcc(f, e)); });
      } else accs.push(fileAcc(f));
    }
    function stemOf(n) { return n.replace(/^.*[\\\/]/, '').replace(/\.[^.]*$/, '').toLowerCase(); }
    function dirOf(n) { var m = n.match(/^(.*[\\\/])/); return m ? m[1] : ''; }
    function extOf(n) { var m = n.match(/\.([^.\\\/]+)$/); return m ? m[1].toLowerCase() : ''; }
    var byKey = {};
    accs.forEach(function (a) { var k = dirOf(a.name) + stemOf(a.name); (byKey[k] = byKey[k] || {})[extOf(a.name)] = a; });
    var out = [];
    Object.keys(byKey).forEach(function (k) {
      var g = byKey[k]; if (!g.shp) return;
      out.push({ name: g.shp.name.replace(/^.*[\\\/]/, ''), shp: g.shp, dbf: g.dbf || null, cpg: g.cpg || null, prj: g.prj || null });
    });
    out.sort(function (a, b) { return (b.dbf ? 1 : 0) - (a.dbf ? 1 : 0) || (a.name < b.name ? 1 : -1); });   // πρώτα όσα έχουν dbf, νεότερο όνομα πρώτο
    return out;
  }

  /* ---------- DBF ---------- */
  async function readText(acc) { if (!acc) return ''; return new TextDecoder('utf-8').decode(await acc.bytes()); }
  async function dbfHeader(acc) {
    var h = await acc.slice(0, 32), n = u32(h, 4), hl = u16(h, 8), rl = u16(h, 10);
    var d = await acc.slice(32, hl), fields = [], p = 0, off = 1;
    while (p < d.length && d[p] !== 0x0D) {
      var nm = ''; for (var i = 0; i < 11 && d[p + i]; i++) nm += String.fromCharCode(d[p + i]);
      var ln = d[p + 16]; fields.push({ name: nm, off: off, len: ln }); off += ln; p += 32;
    }
    return { n: n, hl: hl, rl: rl, fields: fields };
  }
  function pickDecoders(cpgText) {
    var t = (cpgText || '').toUpperCase(), enc = 'utf-8';
    if (/1253/.test(t)) enc = 'windows-1253'; else if (/1252|8859|LATIN/.test(t)) enc = 'windows-1252';
    var first = new TextDecoder(enc, { fatal: true }), fb = new TextDecoder('windows-1253');
    return function (bytes) { try { return first.decode(bytes); } catch (e) { return fb.decode(bytes); } };
  }
  async function dbfRecords(acc, cpgText, indices) {
    var hd = await dbfHeader(acc), dec = pickDecoders(cpgText), rows = {};
    if (indices.length > 5000 || !acc.size) {                // πολλά → ένα πέρασμα με όλο το αρχείο
      var all = await acc.bytes();
      indices.forEach(function (i) { rows[i] = decodeRow(all.subarray(hd.hl + i * hd.rl, hd.hl + (i + 1) * hd.rl), hd, dec); });
    } else {
      for (var k = 0; k < indices.length; k++) {
        var i = indices[k], b = await acc.slice(hd.hl + i * hd.rl, hd.hl + (i + 1) * hd.rl);
        rows[i] = decodeRow(b, hd, dec);
      }
    }
    return { fields: hd.fields.map(function (f) { return f.name; }), rows: rows };
  }
  function decodeRow(b, hd, dec) {
    var o = {};
    hd.fields.forEach(function (f) { o[f.name] = dec(b.subarray(f.off, f.off + f.len)).replace(/\0/g, '').trim(); });
    return o;
  }

  /* ---------- SHP ---------- */
  var POLY = { 5: 1, 15: 1, 25: 1 };
  /*  opts: { bbox:[x0,y0,x1,y1]|null, onProgress(frac) }
   *  Επιστρέφει { records:[{id,attrs,rings,bbox}], fields, scanned, ms, crsNote } */
  async function readDataset(ds, opts) {
    opts = opts || {};
    var t0 = Date.now(), filt = opts.bbox || null;
    var bs = new ByteStream(await ds.shp.stream());
    if (!(await bs.ensure(100))) throw new Error('Κατεστραμμένο .shp (πολύ μικρό).');
    var hdv = new DataView(bs.buf.buffer, bs.buf.byteOffset + bs.pos, 100);
    if (hdv.getInt32(0, false) !== 9994) throw new Error('Το αρχείο δεν είναι shapefile.');
    var stype = hdv.getInt32(32, true);
    if (!POLY[stype]) throw new Error('Το shapefile δεν είναι πολυγωνικό (τύπος ' + stype + ').');
    bs.pos += 100;
    var recs = [], scanned = 0, idx = -1, done = 100, total = ds.shp.size || 1, sinceYield = 0, lastYield = Date.now();
    for (;;) {
      if (!(await bs.ensure(8))) break;
      var h = new DataView(bs.buf.buffer, bs.buf.byteOffset + bs.pos, 8);
      var clen = h.getInt32(4, false) * 2;
      idx++; scanned++;
      var need = 8 + Math.min(clen, 44);
      if (!(await bs.ensure(need))) break;
      var dv = new DataView(bs.buf.buffer, bs.buf.byteOffset + bs.pos + 8, Math.min(clen, 44));
      var hit = false;
      if (clen >= 44 && dv.getInt32(0, true) !== 0) {
        if (!filt) hit = true;
        else {
          var x0 = dv.getFloat64(4, true), y0 = dv.getFloat64(12, true), x1 = dv.getFloat64(20, true), y1 = dv.getFloat64(28, true);
          hit = !(x1 < filt[0] || x0 > filt[2] || y1 < filt[1] || y0 > filt[3]);
        }
      }
      if (hit) {
        if (!(await bs.ensure(8 + clen))) break;
        var c = new DataView(bs.buf.buffer, bs.buf.byteOffset + bs.pos + 8, clen);
        var np = c.getInt32(36, true), npt = c.getInt32(40, true);
        var parts = [], o = 44;
        for (var i = 0; i < np; i++) { parts.push(c.getInt32(o, true)); o += 4; }
        var rings = [], bb = [c.getFloat64(4, true), c.getFloat64(12, true), c.getFloat64(20, true), c.getFloat64(28, true)];
        for (var r = 0; r < np; r++) {
          var s = parts[r], e = r + 1 < np ? parts[r + 1] : npt, ring = [];
          for (var j = s; j < e; j++) ring.push([c.getFloat64(o + j * 16, true), c.getFloat64(o + j * 16 + 8, true)]);
          rings.push(ring);
        }
        recs.push({ id: idx, rings: rings, bbox: bb, attrs: null });
      }
      await bs.skip(8 + clen);
      done += 8 + clen;
      if (opts.onProgress && ++sinceYield >= 500) { sinceYield = 0; var now = Date.now(); if (now - lastYield > 80) { lastYield = now; opts.onProgress(Math.min(1, done / total)); await yieldNow(); } }
    }
    if (ds.dbf && recs.length) {
      var d = await dbfRecords(ds.dbf, await readText(ds.cpg), recs.map(function (r) { return r.id; }));
      recs.forEach(function (r) { r.attrs = d.rows[r.id]; });
      var fields = d.fields;
    } else fields = [];
    var prj = await readText(ds.prj), note = '';
    if (/GEOGCS/i.test(prj) && !/PROJCS/i.test(prj)) note = 'Το .prj δηλώνει γεωγραφικές συντεταγμένες (μοίρες), όχι ΕΓΣΑ87.';
    return { records: recs, fields: fields, scanned: scanned, ms: Date.now() - t0, crsNote: note };
  }

  /* ---------- DXF: ανάγνωση πολυγώνων αντιρρήσεων ---------- */
  function decodeDxf(buf) {
    var u = new Uint8Array(buf), head = new TextDecoder('latin1').decode(u.subarray(0, Math.min(u.length, 20000)));
    var v = /\$ACADVER\s+1\s+(AC\d+)/.exec(head), ver = v ? v[1] : 'AC1009';
    var cp = /\$DWGCODEPAGE\s+3\s+(\S+)/.exec(head), enc;
    if (ver >= 'AC1021') enc = 'utf-8';
    else if (cp && /1253/.test(cp[1])) enc = 'windows-1253';
    else if (cp && /1252/.test(cp[1])) enc = 'windows-1252';
    else enc = 'windows-1253';
    return new TextDecoder(enc).decode(u);
  }
  function parseDxf(buf) {
    var L = decodeDxf(buf).split(/\r?\n/), n = L.length, i = 0;
    // μόνο η ενότητα ENTITIES
    while (i + 1 < n && !(L[i].trim() === '2' && L[i + 1].trim() === 'ENTITIES')) i += 2;
    i += 2;
    var ents = [], ignored = {}, cur = null, inPoly = false;
    function close() { if (cur) { ents.push(cur); cur = null; } }
    var x = 0;
    for (; i + 1 < n; i += 2) {
      var c = L[i].trim(), v = L[i + 1].trim();
      if (c === '0') {
        if (v === 'ENDSEC') { close(); break; }
        if (v === 'VERTEX' && inPoly) { cur.vtx = true; continue; }
        if (v === 'SEQEND') { close(); inPoly = false; continue; }
        if (inPoly && cur) { cur.vtx = false; }
        if (v === 'LWPOLYLINE') { close(); cur = { type: v, layer: '0', flag: 0, pts: [], bulge: false }; inPoly = false; }
        else if (v === 'POLYLINE') { close(); cur = { type: v, layer: '0', flag: 0, pts: [], bulge: false }; inPoly = true; }
        else { close(); inPoly = false; ignored[v] = (ignored[v] || 0) + 1; }
        continue;
      }
      if (!cur) continue;
      if (cur.type === 'LWPOLYLINE') {
        if (c === '8') cur.layer = v; else if (c === '70') cur.flag = +v;
        else if (c === '10') x = +v; else if (c === '20') cur.pts.push([x, +v]);
        else if (c === '42' && +v !== 0) cur.bulge = true;
      } else {                                              // POLYLINE + VERTEX
        if (!cur.vtx) { if (c === '8') cur.layer = v; else if (c === '70') cur.flag = +v; }
        else { if (c === '10') x = +v; else if (c === '20') cur.pts.push([x, +v]); else if (c === '42' && +v !== 0) cur.bulge = true; }
      }
    }
    var layers = {}, warn = [];
    ents.forEach(function (e) {
      var p = e.pts;
      if (p.length > 1 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]) p = p.slice(0, -1);
      if (p.length < 3) { ignored['πολυγραμμή με <3 κορυφές'] = (ignored['πολυγραμμή με <3 κορυφές'] || 0) + 1; return; }
      var L2 = layers[e.layer] = layers[e.layer] || [];
      L2.push({ pts: p, closedFlag: !!(e.flag & 1), bulge: e.bulge });
    });
    var bulges = ents.filter(function (e) { return e.bulge; }).length;
    if (bulges) warn.push(bulges + ' πολυγραμμή/ές έχουν τόξα (bulge)· τα τόξα αντικαθίστανται από ευθύγραμμα τμήματα.');
    return { layers: layers, ignored: ignored, warnings: warn };
  }

  /* ---------- DXF: εγγραφή (ίδιος R12 τρόπος με SW Maps — ανοίγει σε AutoCAD) ---------- */
  var GREEKLISH = {
    'Α':'A','Β':'V','Γ':'G','Δ':'D','Ε':'E','Ζ':'Z','Η':'I','Θ':'TH','Ι':'I','Κ':'K','Λ':'L','Μ':'M','Ν':'N','Ξ':'X','Ο':'O','Π':'P','Ρ':'R','Σ':'S','Τ':'T','Υ':'Y','Φ':'F','Χ':'CH','Ψ':'PS','Ω':'O',
    'α':'a','β':'v','γ':'g','δ':'d','ε':'e','ζ':'z','η':'i','θ':'th','ι':'i','κ':'k','λ':'l','μ':'m','ν':'n','ξ':'x','ο':'o','π':'p','ρ':'r','σ':'s','ς':'s','τ':'t','υ':'y','φ':'f','χ':'ch','ψ':'ps','ω':'o'
  };
  function dxfName(s) {
    s = String(s == null ? '' : s).trim().replace(/[Α-Ωα-ω]/g, function (c) { return GREEKLISH[c] || c; });
    s = s.replace(/[<>\/\\":;?*|,=]/g, '_').replace(/\s+/g, '_').replace(/[^\x20-\x7E]/g, '') || '0';
    return s.length > 26 ? s.slice(0, 26) : s;
  }
  function f3(v) { return (+v).toFixed(6); }
  /*  layers: [{name, color, pieces:[{rings:[{pts,hole}]}]}]  */
  function writeDxf(layers) {
    var le = '';
    layers.forEach(function (l) { le += '0\nLAYER\n2\n' + l.name + '\n70\n0\n62\n' + l.color + '\n6\nCONTINUOUS\n'; });
    var d = '0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n0\n' + le + '0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n';
    layers.forEach(function (l) {
      l.pieces.forEach(function (pc) {
        pc.rings.forEach(function (r) {
          d += '0\nPOLYLINE\n8\n' + l.name + '\n62\n' + l.color + '\n66\n1\n70\n1\n';
          r.pts.forEach(function (p) { d += '0\nVERTEX\n8\n' + l.name + '\n10\n' + f3(p[0]) + '\n20\n' + f3(p[1]) + '\n30\n0.000\n'; });
          d += '0\nSEQEND\n8\n' + l.name + '\n';
        });
      });
    });
    return d + '0\nENDSEC\n0\nEOF\n';
  }

  async function datasetFields(ds) { return ds.dbf ? (await dbfHeader(ds.dbf)).fields.map(function (f) { return f.name; }) : []; }

  return { listDatasets: listDatasets, datasetFields: datasetFields, readDataset: readDataset, parseDxf: parseDxf, writeDxf: writeDxf, dxfName: dxfName };
})();
