/*!
 * gridfolder.js — File System Access API layer for a local grid-file
 * folder on the user's own device. Picked once, remembered after that
 * (IndexedDB), works fully offline — no server, no bundled grid files.
 *
 * Deliberately separate from gridformats.js: this file is "how do we get
 * the bytes off the device", that one is "what do the bytes mean" — each
 * half can be trusted/tested independently.
 *
 * Feature support varies by Android Chrome build/vendor — always check
 * isSupported() before showing any folder-picker UI, and show a plain
 * "not supported here" message rather than a silent no-op when it's false.
 */
(function (global) {
  'use strict';

  var DB_NAME = 'zs_gridfolder', STORE = 'handle', KEY = 'folder';
  var supported = (typeof window !== 'undefined') && ('showDirectoryPicker' in window);
  var activeHandle = null;

  function openDb() {
    return new Promise(function (res, rej) {
      var rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    });
  }

  function withStore(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction([STORE], mode);
        fn(tx.objectStore(STORE));
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  function saveHandle(handle) {
    return withStore('readwrite', function (store) { store.put(handle, KEY); });
  }
  function loadHandle() {
    return openDb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction([STORE], 'readonly');
        var rq = tx.objectStore(STORE).get(KEY);
        rq.onsuccess = function () { res(rq.result || null); };
        rq.onerror = function () { rej(rq.error); };
      });
    });
  }
  function clearHandle() {
    return withStore('readwrite', function (store) { store.delete(KEY); });
  }

  function isSupported() { return supported; }
  function getActiveHandle() { return activeHandle; }

  /** Opens the OS folder picker. MUST be called directly from a click handler (user gesture). */
  function pickFolder() {
    if (!supported) return Promise.reject(new Error('This browser does not support picking a local folder.'));
    return window.showDirectoryPicker({ mode: 'read' }).then(function (handle) {
      activeHandle = handle;
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* best-effort */ }
      return saveHandle(handle).then(function () { return handle; });
    });
  }

  /*  Tries to pick back up a previously-chosen folder WITHOUT prompting —
   *  only checks the stored permission state. Never calls
   *  requestPermission() here: that needs a live user gesture and silently
   *  rejects without one. Re-requesting is reconnect(), called from a click.
   *  A `null` result (handle gone, or permission lapsed) is a normal state
   *  to show a "choose/reconnect folder" prompt for — not an error. */
  function restore() {
    return loadHandle().then(function (handle) {
      if (!handle) return null;
      return handle.queryPermission({ mode: 'read' }).then(function (state) {
        if (state === 'granted') { activeHandle = handle; return handle; }
        activeHandle = null;
        return null;
      });
    }).catch(function () { activeHandle = null; return null; });
  }

  /** Re-requests permission for the already-stored folder. MUST be called from a click handler. */
  function reconnect() {
    return loadHandle().then(function (handle) {
      if (!handle) throw new Error('No folder was chosen before.');
      return handle.requestPermission({ mode: 'read' }).then(function (state) {
        if (state !== 'granted') throw new Error('Permission to the folder was not granted.');
        activeHandle = handle;
        return handle;
      });
    });
  }

  function forget() {
    activeHandle = null;
    return clearHandle();
  }

  /** Lists .gtx/.gsb files in the connected folder (top level only). */
  async function listGridFiles() {
    if (!activeHandle) throw new Error('No folder is connected.');
    var out = [];
    for await (var entry of activeHandle.values()) {
      if (entry.kind === 'file' && /\.(gtx|gsb)$/i.test(entry.name)) out.push(entry.name);
    }
    out.sort();
    return out;
  }

  /** Reads one file from the connected folder as an ArrayBuffer. */
  async function readGridFile(name) {
    if (!activeHandle) throw new Error('No folder is connected.');
    var fh = await activeHandle.getFileHandle(name);
    var file = await fh.getFile();
    return file.arrayBuffer();
  }

  var API = {
    isSupported: isSupported, pickFolder: pickFolder, restore: restore,
    reconnect: reconnect, forget: forget, getActiveHandle: getActiveHandle,
    listGridFiles: listGridFiles, readGridFile: readGridFile
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.GridFolder = API;

})(typeof window !== 'undefined' ? window : this);
