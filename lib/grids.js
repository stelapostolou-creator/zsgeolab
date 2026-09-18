/*!
 * grids.js — ties gridformats.js (binary parsing) and gridfolder.js (local
 * folder access) together into the small piece of state a tool actually
 * needs: which geoid (GTX) grid and which datum-shift (NTv2) grid are
 * currently active, and simple lookup functions for them.
 *
 * This is the UI-facing API for a "Grid files" feature — deliberately not
 * wired into lib/crs.js itself (crs.js stays generic proj4 math only, per
 * its own documented scope). A tool calls these functions explicitly,
 * only when the user has loaded and selected a grid.
 */
(function (global) {
  'use strict';

  var geoid = null;   // { name, grid }        — parsed GTX
  var ntv2 = null;     // { name, parsed }       — parsed NTv2
  var ntv2Reverse = false;

  function clearGeoid() { geoid = null; }
  function getGeoidName() { return geoid ? geoid.name : null; }

  function clearNTv2() { ntv2 = null; }
  function getNTv2Name() { return ntv2 ? ntv2.name : null; }
  function setNTv2Reverse(v) { ntv2Reverse = !!v; }
  function getNTv2Reverse() { return ntv2Reverse; }
  function getNTv2Systems() { return ntv2 ? { from: ntv2.parsed.systemF, to: ntv2.parsed.systemT } : null; }

  /** Geoid undulation N (meters) at (lat, lon). null if no geoid grid loaded;
   *  throws if a grid IS loaded but the point falls outside its coverage —
   *  callers must show that error, never swallow it into a fallback value. */
  function geoidN(lat, lon) {
    if (!geoid) return null;
    return GridFormats.gtxLookup(geoid.grid, lat, lon);
  }

  /** Orthometric height at (lat, lon) given ellipsoidal height h. null if no geoid grid loaded. */
  function orthoHeight(lat, lon, h) {
    var n = geoidN(lat, lon);
    return n == null ? null : (h - n);
  }

  /** {lat, lon, subName} shifted per the active NTv2 grid + direction. null if none loaded. */
  function shiftLatLon(lat, lon) {
    if (!ntv2) return null;
    return GridFormats.ntv2Apply(ntv2.parsed, lat, lon, ntv2Reverse);
  }

  async function loadGeoidFile(name) {
    var buf = await GridFolder.readGridFile(name);
    var grid = GridFormats.parseGTX(buf);
    geoid = { name: name, grid: grid };
    return grid;
  }

  async function loadNTv2File(name) {
    var buf = await GridFolder.readGridFile(name);
    var parsed = GridFormats.parseNTv2(buf);
    ntv2 = { name: name, parsed: parsed };
    return parsed;
  }

  var API = {
    loadGeoidFile: loadGeoidFile, clearGeoid: clearGeoid, getGeoidName: getGeoidName,
    geoidN: geoidN, orthoHeight: orthoHeight,
    loadNTv2File: loadNTv2File, clearNTv2: clearNTv2, getNTv2Name: getNTv2Name,
    setNTv2Reverse: setNTv2Reverse, getNTv2Reverse: getNTv2Reverse, getNTv2Systems: getNTv2Systems,
    shiftLatLon: shiftLatLon
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.Grids = API;

})(typeof window !== 'undefined' ? window : this);
