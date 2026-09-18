/*!
 * gridformats.js — binary parsers for GTX (NOAA geoid grid) and NTv2
 * (.gsb, datum-realization shift grid) files.
 *
 * Pure data in, data out: no DOM, no File System Access, no fetch. Takes an
 * ArrayBuffer (however it got read off disk — see gridfolder.js), returns a
 * parsed grid object, and offers a lookup function for it. Kept separate
 * from gridfolder.js so the format-parsing half can be tested/trusted on
 * its own.
 *
 * THE ONE RULE THAT MATTERS MORE THAN ANY OTHER HERE: a lookup for a point
 * outside the grid's actual coverage THROWS. It never falls back to 0 or
 * any other "looks like a number" value. This project has been burned
 * before by exactly that class of bug (see HANDOFF.md §10) — a wrong
 * number that renders fine and gets trusted is much worse than a visible
 * error.
 */
(function (global) {
  'use strict';

  // ==================================================================
  // GTX — NOAA-style geoid grid. Always big-endian, no sub-grids, no
  // datum-realization ambiguity — the simpler of the two formats.
  // ==================================================================

  /*  Header (40 bytes, big-endian):
   *    South latitude   float64  offset 0
   *    West longitude   float64  offset 8
   *    Delta latitude   float64  offset 16
   *    Delta longitude  float64  offset 24
   *    Rows             int32    offset 32
   *    Columns          int32    offset 36
   *  Then rows*cols float32 values, row-major, south row first, west to
   *  east within a row — geoid undulation N in meters at each node.
   *
   *  Longitude convention is NOT reliably signed -180..180: some producers
   *  (including some official NOAA CONUS tiles) store it wrapped 0..360.
   *  Detected here from the header's own west-longitude value rather than
   *  assumed, and the query point is normalized to match at lookup time.
   */
  function parseGTX(buf) {
    if (buf.byteLength < 40) throw new Error('GTX file is too short to contain a header.');
    var dv = new DataView(buf);
    var minLat = dv.getFloat64(0, false);
    var minLon = dv.getFloat64(8, false);
    var dLat = dv.getFloat64(16, false);
    var dLon = dv.getFloat64(24, false);
    var nrows = dv.getInt32(32, false);
    var ncols = dv.getInt32(36, false);
    if (!(nrows > 0 && ncols > 0 && nrows < 100000 && ncols < 100000)) {
      throw new Error('GTX header looks invalid (rows=' + nrows + ', cols=' + ncols + ').');
    }
    var expected = 40 + nrows * ncols * 4;
    if (buf.byteLength < expected) {
      throw new Error('GTX file is truncated: expected at least ' + expected + ' bytes for a ' +
        nrows + '×' + ncols + ' grid, got ' + buf.byteLength + '.');
    }
    var wrap360 = minLon > 180;
    var data = new Float32Array(nrows * ncols);
    for (var i = 0; i < nrows * ncols; i++) data[i] = dv.getFloat32(40 + i * 4, false);
    return { type: 'gtx', minLat: minLat, minLon: minLon, dLat: dLat, dLon: dLon,
             nrows: nrows, ncols: ncols, data: data, wrap360: wrap360 };
  }

  /** Bilinear geoid undulation N (meters) at (lat, lon). Throws if outside coverage. */
  function gtxLookup(grid, lat, lon) {
    var qlon = lon;
    if (grid.wrap360) { if (qlon < 0) qlon += 360; }
    else if (qlon > 180) { qlon -= 360; }
    var row = (lat - grid.minLat) / grid.dLat;
    var col = (qlon - grid.minLon) / grid.dLon;
    var r0 = Math.floor(row), c0 = Math.floor(col), r1 = r0 + 1, c1 = c0 + 1;
    if (r0 < 0 || c0 < 0 || r1 >= grid.nrows || c1 >= grid.ncols) {
      throw new Error('Point (' + lat.toFixed(5) + ', ' + lon.toFixed(5) +
        ') is outside this geoid grid’s coverage.');
    }
    var tr = row - r0, tc = col - c0;
    var w = grid.ncols;
    var v00 = grid.data[r0 * w + c0], v10 = grid.data[r0 * w + c1];
    var v01 = grid.data[r1 * w + c0], v11 = grid.data[r1 * w + c1];
    return v00 * (1 - tr) * (1 - tc) + v10 * (1 - tr) * tc + v01 * tr * (1 - tc) + v11 * tr * tc;
  }

  // ==================================================================
  // NTv2 (.gsb) — horizontal datum-realization shift grid. Can have
  // little-endian variants, nested sub-grids, and an inconsistently
  // signed longitude convention across producers — all detected, never
  // assumed, per the plan's own risk review.
  // ==================================================================

  var ASCII_A = 32, ASCII_Z = 126;

  function readAscii8(dv, off) {
    var s = '';
    for (var i = 0; i < 8; i++) {
      var c = dv.getUint8(off + i);
      if (c >= ASCII_A && c <= ASCII_Z) s += String.fromCharCode(c);
    }
    return s.trim();
  }

  /** Reads one 16-byte (name, value) header record at `off`, for the given endianness. */
  function readRecord(dv, off, le) {
    var name = readAscii8(dv, off);
    return { name: name,
             asInt: dv.getInt32(off + 8, le),
             asDouble: dv.getFloat64(off + 8, le),
             asText: readAscii8(dv, off + 8) };
  }

  function readHeaderBlock(dv, off, le, n) {
    var out = {};
    for (var i = 0; i < n; i++) out['_' + i] = readRecord(dv, off + i * 16, le);
    return out;
  }

  /*  Tries to read the overview header (first 11 records = 176 bytes) under
   *  a given endianness and reports whether the result looks sane: the
   *  record-count fields must literally read as 11 (they describe the
   *  file's own layout), and the two ellipsoid semi-major axes must fall in
   *  a physically plausible range for Earth (~6,378,000–6,378,300 m). A
   *  wrong endianness guess turns float64 fields into either NaN/garbage or
   *  wildly out-of-range numbers, so this is a reliable two-signal check —
   *  not just a guess. */
  function tryOverviewHeader(dv, le) {
    if (dv.byteLength < 176) return null;
    var recs = readHeaderBlock(dv, 0, le, 11);
    var numOrec = recs._0.asInt, numSrec = recs._1.asInt, numFile = recs._2.asInt;
    var majorF = recs._7.asDouble, majorT = recs._9.asDouble;
    var plausible = function (v) { return v > 6378000 && v < 6378300; };
    if (numOrec === 11 && numSrec === 11 && numFile > 0 && numFile < 100000 &&
        plausible(majorF) && plausible(majorT)) {
      return {
        le: le, numFile: numFile,
        gsType: recs._3.asText, version: recs._4.asText,
        systemF: recs._5.asText, systemT: recs._6.asText,
        majorF: majorF, minorF: recs._8.asDouble,
        majorT: majorT, minorT: recs._10.asDouble
      };
    }
    return null;
  }

  function readSubGridHeader(dv, off, le) {
    var recs = readHeaderBlock(dv, off, le, 11);
    return {
      name: recs._0.asText, parent: recs._1.asText,
      sLat: recs._4.asDouble, nLat: recs._5.asDouble,
      eLong: recs._6.asDouble, wLong: recs._7.asDouble,
      latInc: recs._8.asDouble, longInc: recs._9.asDouble,
      gsCount: recs._10.asInt
    };
  }

  /*  NTv2 stores S_LAT/N_LAT/E_LONG/W_LONG/*_INC in ARC-SECONDS, and the
   *  classic (Canada/NRCan, Australia/ICSM, NZ/LINZ) convention stores
   *  longitude POSITIVE-WEST — the opposite of normal signed longitude.
   *  Not every producer follows this, so it's detected rather than
   *  hardcoded: convert assuming positive-west, and check the result is a
   *  sane bounding box (west edge west of east edge, in standard signed
   *  terms). If that fails, retry assuming ordinary east-positive seconds. */
  function detectLonConvention(sub) {
    var westPW = -sub.wLong / 3600, eastPW = -sub.eLong / 3600;
    if (westPW < eastPW) return 'positive-west';
    var westEP = sub.wLong / 3600, eastEP = sub.eLong / 3600;
    if (westEP < eastEP) return 'east-positive';
    throw new Error('Could not determine the longitude sign convention for sub-grid "' +
      sub.name + '" — its bounding box is not plausible under either interpretation.');
  }

  function subLonDeg(sub, convention, rawSeconds) {
    return convention === 'positive-west' ? -rawSeconds / 3600 : rawSeconds / 3600;
  }

  /**
   * parseNTv2(buf) -> { systemF, systemT, majorF, minorF, majorT, minorT,
   *                     subgrids: [{ name, parent, sLat, nLat, wLon, eLon,
   *                                  dLat, dLon, nrows, ncols, dlat, dlon,
   *                                  lonConvention }] }
   * sLat/nLat/wLon/eLon/dLat/dLon are all in DEGREES (already converted from
   * the file's arc-seconds); dlat/dlon are Float32Arrays of shift values in
   * ARC-SECONDS (left as-is — see ntv2Lookup for how they're applied).
   */
  function parseNTv2(buf) {
    var dv = new DataView(buf);
    var ov = tryOverviewHeader(dv, false) || tryOverviewHeader(dv, true);
    if (!ov) {
      throw new Error('This does not look like a valid NTv2 (.gsb) file (header failed ' +
        'sanity checks under both big- and little-endian reads).');
    }
    var le = ov.le;
    var subgrids = [];
    var off = 176;
    for (var f = 0; f < ov.numFile; f++) {
      if (off + 176 > dv.byteLength) throw new Error('NTv2 file is truncated (sub-grid header ' + f + ').');
      var h = readSubGridHeader(dv, off, le);
      off += 176;
      var convention = detectLonConvention(h);
      var sLat = h.sLat / 3600, nLat = h.nLat / 3600;
      var wLon = subLonDeg(h, convention, h.wLong), eLon = subLonDeg(h, convention, h.eLong);
      var dLat = h.latInc / 3600, dLon = h.longInc / 3600;
      var ncols = Math.round((eLon - wLon) / dLon) + 1;
      var nrows = Math.round((nLat - sLat) / dLat) + 1;
      // Integrity check: the file's own claimed node count must match what
      // its own extent/increment fields imply. Catches endianness slips and
      // corrupt/non-conforming files before any bad output is possible.
      if (nrows * ncols !== h.gsCount) {
        throw new Error('Sub-grid "' + h.name + '": GS_COUNT (' + h.gsCount +
          ') does not match the extent implied by its own header (' + nrows + '×' + ncols +
          ' = ' + (nrows * ncols) + '). Refusing to trust this file.');
      }
      var need = off + h.gsCount * 16;
      if (need > dv.byteLength) throw new Error('NTv2 file is truncated (sub-grid "' + h.name + '" node data).');
      var dlat = new Float32Array(h.gsCount), dlon = new Float32Array(h.gsCount);
      for (var i = 0; i < h.gsCount; i++) {
        dlat[i] = dv.getFloat32(off + i * 16, le);
        dlon[i] = dv.getFloat32(off + i * 16 + 4, le);
        // bytes +8/+12 are DLAT_ACC/DLON_ACC (accuracy estimates) — not used here.
      }
      off += h.gsCount * 16;
      subgrids.push({ name: h.name, parent: h.parent, sLat: sLat, nLat: nLat,
                       wLon: wLon, eLon: eLon, dLat: dLat, dLon: dLon,
                       nrows: nrows, ncols: ncols, dlat: dlat, dlon: dlon,
                       lonConvention: convention });
    }
    return { systemF: ov.systemF, systemT: ov.systemT,
             majorF: ov.majorF, minorF: ov.minorF, majorT: ov.majorT, minorT: ov.minorT,
             subgrids: subgrids };
  }

  /** True if (lat, lon) falls within a sub-grid's own extent (inclusive, small epsilon). */
  function subCovers(sub, lat, lon) {
    var eps = 1e-9;
    return lat >= sub.sLat - eps && lat <= sub.nLat + eps &&
           lon >= sub.wLon - eps && lon <= sub.eLon + eps;
  }

  /*  Picks the most specific (deepest-nested) sub-grid covering a point.
   *  NTv2 files can have several root-level sub-grids (PARENT="NONE", e.g.
   *  one per province/state) and children nested inside a parent's extent
   *  for higher local resolution — the deepest matching child always wins.
   *  Sibling overlap (two children of the same parent both claiming a
   *  point) is a sign of a non-conforming file and is reported rather than
   *  silently resolved by "first match". */
  function pickSubgrid(ntv2, lat, lon) {
    var roots = ntv2.subgrids.filter(function (s) { return s.parent === 'NONE'; });
    var candidates = roots.filter(function (s) { return subCovers(s, lat, lon); });
    if (!candidates.length) return null;
    var current = candidates.length === 1 ? candidates[0] : ambiguous(candidates, lat, lon);
    for (;;) {
      var children = ntv2.subgrids.filter(function (s) {
        return s.parent === current.name && subCovers(s, lat, lon);
      });
      if (!children.length) return current;
      current = children.length === 1 ? children[0] : ambiguous(children, lat, lon);
    }
  }
  function ambiguous(list, lat, lon) {
    throw new Error('Point (' + lat.toFixed(5) + ', ' + lon.toFixed(5) + ') is claimed by ' +
      list.length + ' overlapping sub-grids (' + list.map(function (s) { return s.name; }).join(', ') +
      ') — the grid file is not internally consistent.');
  }

  /** Bilinear (dLat, dLon) shift in ARC-SECONDS at (lat, lon). Throws if outside all coverage. */
  function ntv2LookupRaw(ntv2, lat, lon) {
    var sub = pickSubgrid(ntv2, lat, lon);
    if (!sub) {
      throw new Error('Point (' + lat.toFixed(5) + ', ' + lon.toFixed(5) +
        ') is outside this NTv2 file’s coverage.');
    }
    // Node order within a sub-grid: south→north by row, but EAST→WEST
    // within a row — the opposite of GTX. This follows from iterating the
    // positive-west header fields from E_LONG to W_LONG in +LONG_INC steps.
    var rowF = (lat - sub.sLat) / sub.dLat;
    var colFromEastF = (lon - sub.eLon) / (-sub.dLon); // increases going west
    var r0 = Math.floor(rowF), c0 = Math.floor(colFromEastF);
    var r1 = r0 + 1, c1 = c0 + 1;
    if (r0 < 0 || c0 < 0 || r1 >= sub.nrows || c1 >= sub.ncols) {
      throw new Error('Point (' + lat.toFixed(5) + ', ' + lon.toFixed(5) +
        ') rounds outside sub-grid "' + sub.name + '" at its own resolution.');
    }
    var tr = rowF - r0, tc = colFromEastF - c0;
    var w = sub.ncols;
    function at(arr, r, c) { return arr[r * w + c]; }
    var la00 = at(sub.dlat, r0, c0), la10 = at(sub.dlat, r0, c1);
    var la01 = at(sub.dlat, r1, c0), la11 = at(sub.dlat, r1, c1);
    var lo00 = at(sub.dlon, r0, c0), lo10 = at(sub.dlon, r0, c1);
    var lo01 = at(sub.dlon, r1, c0), lo11 = at(sub.dlon, r1, c1);
    var dlat = la00 * (1 - tr) * (1 - tc) + la10 * (1 - tr) * tc + la01 * tr * (1 - tc) + la11 * tr * tc;
    var dlon = lo00 * (1 - tr) * (1 - tc) + lo10 * (1 - tr) * tc + lo01 * tr * (1 - tc) + lo11 * tr * tc;
    return { dlat: dlat, dlon: dlon, subName: sub.name };
  }

  /*  Applies the shift. DLAT/DLON are arc-seconds, applied directly as
   *  degrees/3600 — they are already a geographic-coordinate delta, NOT a
   *  linear ground distance, so no cos(latitude) scaling belongs here (that
   *  scaling exists elsewhere in this codebase for UTM/TM math — a
   *  different kind of quantity, kept deliberately separate).
   *
   *  reverse=true inverts SYSTEM_F→SYSTEM_T to SYSTEM_T→SYSTEM_F. A naive
   *  reverse (look up the shift at the target point and subtract) has error
   *  proportional to the local gradient of the shift field, so this does a
   *  short fixed-point iteration instead: look up at the current best
   *  estimate of the source point, step, repeat. */
  function ntv2Apply(ntv2, lat, lon, reverse) {
    if (!reverse) {
      var s = ntv2LookupRaw(ntv2, lat, lon);
      return { lat: lat + s.dlat / 3600, lon: lon + s.dlon / 3600, subName: s.subName };
    }
    var estLat = lat, estLon = lon, last = null;
    for (var i = 0; i < 4; i++) {
      last = ntv2LookupRaw(ntv2, estLat, estLon);
      estLat = lat - last.dlat / 3600;
      estLon = lon - last.dlon / 3600;
    }
    return { lat: estLat, lon: estLon, subName: last.subName };
  }

  var API = {
    parseGTX: parseGTX, gtxLookup: gtxLookup,
    parseNTv2: parseNTv2, ntv2Apply: ntv2Apply, ntv2LookupRaw: ntv2LookupRaw
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.GridFormats = API;

})(typeof window !== 'undefined' ? window : this);
