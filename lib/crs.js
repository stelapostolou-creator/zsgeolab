/*!
 * crs.js — Generic WGS84 <-> arbitrary EPSG transform, for tools with no
 * single fixed national datum (unlike hepos.js, which is always EGSA87).
 *
 * Same call shape as hepos.js so it drops in at the same call sites:
 *   CRS.fromWGS84(lat, lon, h)  -> { x, y, z }   (z passes through unchanged —
 *                                                  no geoid/orthometric logic here)
 *   CRS.toWGS84(x, y, z)        -> { lat, lon, h }
 *
 * The active coordinate system is set once (CRS.applyEPSG) and used
 * implicitly by every call after that — mirrors how hepos.js is always
 * EGSA87 under the hood. Default on load: WGS84 (identity, no projection).
 *
 * No grid-based (NTv2/GTX) support here — deliberately out of scope. If a
 * project ever needs one, it stays a separate, later, opt-in feature (a
 * user-supplied local grid file), not part of this generic engine.
 *
 * Dependency: proj4 (global window.proj4). Load it before this file:
 *   <script src="vendor/proj4.js"></script>
 *   <script src="crs.js"></script>
 */
(function (global) {
  'use strict';

  var state = { epsg: 4326, isGeo: true, name: 'WGS84 (lat/lon)' };
  var ready = true;
  var listeners = [];

  function onChange(fn) { listeners.push(fn); }
  function fire() { listeners.forEach(function (fn) { try { fn(state); } catch (e) { /* listener error, ignore */ } }); }

  function proj4lib() {
    var p = global.proj4;
    if (!p) throw new Error('CRS: proj4 is not loaded. Load proj4.js before crs.js.');
    return p;
  }

  function utmDef(zone, north) {
    return '+proj=utm +zone=' + zone + (north ? '' : ' +south') + ' +datum=WGS84 +units=m +no_defs';
  }

  // Picks the UTM zone a representative lon/lat falls in — used only as an
  // explicit, user-triggered convenience ("Use UTM for this data"), never
  // applied silently.
  function autoUTM(lon, lat) {
    var zone = Math.floor((lon + 180) / 6) + 1;
    if (zone < 1) zone = 1; if (zone > 60) zone = 60;
    var north = lat == null || lat >= 0;
    var code = (north ? 32600 : 32700) + zone;
    return { code: code, zone: zone, north: north, name: 'UTM ' + zone + (north ? 'N' : 'S') };
  }

  function setState(s) { state = s; ready = true; fire(); }
  function getState() { return state; }
  function isReady() { return ready; }

  // applyEPSG(code, onReady, onError) — tries an analytic UTM definition,
  // then a cached proj4 def, then epsg.io as a last resort (only case that
  // needs the internet, and only once per code — cached after that).
  function applyEPSG(code, onReady, onError) {
    code = parseInt(code, 10);
    if (isNaN(code)) { if (onError) onError('Not a valid EPSG code.'); return; }
    if (code === 4326) { setState({ epsg: 4326, isGeo: true, name: 'WGS84 (lat/lon)' }); if (onReady) onReady(state); return; }
    var def = null, name = 'EPSG:' + code;
    if (code >= 32601 && code <= 32660) { def = utmDef(code - 32600, true); name = 'UTM ' + (code - 32600) + 'N'; }
    else if (code >= 32701 && code <= 32760) { def = utmDef(code - 32700, false); name = 'UTM ' + (code - 32700) + 'S'; }
    var p = proj4lib();
    if (def) { p.defs('EPSG:' + code, def); setState({ epsg: code, isGeo: false, name: name }); if (onReady) onReady(state); return; }
    if (p.defs('EPSG:' + code)) { setState({ epsg: code, isGeo: false, name: name }); if (onReady) onReady(state); return; }
    ready = false;
    fetch('https://epsg.io/' + code + '.proj4').then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.text();
    }).then(function (t) {
      t = (t || '').trim();
      if (t.indexOf('+proj') < 0) throw new Error('empty definition');
      p.defs('EPSG:' + code, t);
      setState({ epsg: code, isGeo: false, name: 'EPSG:' + code });
      if (onReady) onReady(state);
    }).catch(function () {
      ready = true; // restore previous state's readiness, nothing changed
      if (onError) onError('Could not load EPSG:' + code + ' (check the code or your internet connection).');
    });
  }

  // Sets the active CRS directly to WGS84 passthrough with a custom label —
  // used when the source data is already in a declared projected CRS and
  // must be read as-is (no reprojection), per the project's own numbers.
  function setPassthrough(name) {
    setState({ epsg: null, isGeo: true, name: name || 'as in source file (not reprojected)' });
  }

  // toWGS84(x, y, z) -> {lat, lon, h} — same call shape as HEPOS.toWGS84.
  function toWGS84(x, y, z) {
    if (state.isGeo) return { lat: y, lon: x, h: z };
    var r = proj4lib()('EPSG:' + state.epsg, 'EPSG:4326', [x, y]);
    return { lat: r[1], lon: r[0], h: z };
  }

  // fromWGS84(lat, lon, h) -> {x, y, z} — same call shape as HEPOS.toEGSA87
  // (minus the applyZ geoid argument, which has no meaning here).
  function fromWGS84(lat, lon, h) {
    if (state.isGeo) return { x: lon, y: lat, z: h };
    var r = proj4lib()('EPSG:4326', 'EPSG:' + state.epsg, [lon, lat]);
    return { x: r[0], y: r[1], z: h };
  }

  var API = {
    applyEPSG: applyEPSG, setPassthrough: setPassthrough,
    setState: setState, getState: getState, isReady: isReady, onChange: onChange,
    autoUTM: autoUTM, utmDef: utmDef,
    toWGS84: toWGS84, fromWGS84: fromWGS84
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.CRS = API;

})(typeof window !== 'undefined' ? window : this);
