/*  ZS-GeoLab — αποθήκευση εργασιών (ιστορικό) για τα εργαλεία SW Maps.
 *
 *  Ο χρήστης δουλεύει στο χωράφι· ένα refresh ή ένα κλείσιμο του tab δεν
 *  πρέπει να χάνει τα σημεία χάραξης. Τα δεδομένα μένουν στο IndexedDB της
 *  συσκευής — το localStorage δεν επαρκεί (όριο ~5MB, ένα .swm2 το ξεπερνά).
 *
 *  Δύο stores: το «meta» κρατά μόνο ονόματα/ημερομηνίες ώστε η λίστα να
 *  ανοίγει ακαριαία, το «data» κρατά ολόκληρο το στιγμιότυπο.
 *
 *  API:  Jobs.init(opts) · Jobs.touch() · Jobs.list() · Jobs.load(id)
 *        Jobs.saveAs(name) · Jobs.rename(id,name) · Jobs.remove(id)
 *        Jobs.exportFile(id) · Jobs.importFile(file)
 */
(function (global) {
  'use strict';

  var DB_NAME = 'zsgeolab', VER = 1, META = 'jobs_meta', DATA = 'jobs_data';
  // Η θέση αυτόματης αποθήκευσης είναι ΑΝΑ ΕΡΓΑΛΕΙΟ: με κοινό κλειδί, το
  // άνοιγμα του δεύτερου εργαλείου έσβηνε τη μισοτελειωμένη δουλειά του πρώτου.
  var AUTO_PREFIX = '__auto:', AUTO = AUTO_PREFIX;
  var _db = null, _opts = null, _timer = null, _busy = false;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (res, rej) {
      var rq = indexedDB.open(DB_NAME, VER);
      rq.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA, { keyPath: 'id' });
      };
      rq.onsuccess = function () { _db = rq.result; res(_db); };
      rq.onerror = function () { rej(rq.error || new Error('IndexedDB')); };
    });
  }

  function req(r) {
    return new Promise(function (res, rej) {
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }

  function tx(stores, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(stores, mode);
        t.oncomplete = function () { res(true); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error || new Error('abort')); };
        fn(stores.map(function (s) { return t.objectStore(s); }));
      });
    });
  }

  function one(store, method, arg) {
    return open().then(function (db) {
      return req(db.transaction([store], 'readonly').objectStore(store)[method](arg));
    });
  }

  function uid() {
    return 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // ------------------------------------------------------------ εγγραφή ---

  function write(id, name, snap) {
    var meta = { id: id, name: name, saved: Date.now(),
                 tool: _opts.tool, info: snap.info || {} };
    return tx([META, DATA], 'readwrite', function (s) {
      s[0].put(meta);
      s[1].put({ id: id, snap: snap });
    }).then(function () { return meta; });
  }

  /** Αποθηκεύει το τρέχον στιγμιότυπο στη θέση αυτόματης αποθήκευσης. */
  function autosave() {
    if (_busy) return Promise.resolve(null);
    _busy = true;
    var snap = null;
    try { snap = _opts.snapshot(); } catch (e) { snap = null; }
    var done = function (r) { _busy = false; return r; };
    if (!snap || snap.empty) {                       // τίποτα να κρατηθεί
      return remove(AUTO).then(done, done);
    }
    return write(AUTO, _opts.autoName || 'Τελευταία εργασία', snap)
      .then(function (m) { if (_opts.onSaved) _opts.onSaved(m); return m; },
            function () { return null; })
      .then(done);
  }

  /** Καλείται μετά από κάθε αλλαγή· η εγγραφή γίνεται μία φορά, με καθυστέρηση. */
  function touch(ms) {
    if (!_opts) return;
    clearTimeout(_timer);
    _timer = setTimeout(autosave, ms == null ? 1200 : ms);
  }

  function saveAs(name) {
    var snap = _opts.snapshot();
    if (!snap || snap.empty) {
      return Promise.reject(new Error('Δεν υπάρχει τίποτα προς αποθήκευση.'));
    }
    return write(uid(), String(name || '').trim() || 'Εργασία', snap);
  }

  // ----------------------------------------------------------- ανάγνωση ---

  function list() {
    return one(META, 'getAll').then(function (rows) {
      return (rows || [])
        .filter(function (r) { return !_opts.tool || r.tool === _opts.tool; })
        .filter(function (r) { return r.id === AUTO || r.id.indexOf(AUTO_PREFIX) !== 0; })
        .sort(function (a, b) { return b.saved - a.saved; });
    });
  }

  function load(id) {
    return one(DATA, 'get', id).then(function (r) { return r ? r.snap : null; });
  }

  function meta(id) {
    return one(META, 'get', id);
  }

  function rename(id, name) {
    return meta(id).then(function (m) {
      if (!m) throw new Error('Δεν βρέθηκε η εργασία.');
      m.name = String(name || '').trim() || m.name;
      return tx([META], 'readwrite', function (s) { s[0].put(m); }).then(function () { return m; });
    });
  }

  function remove(id) {
    return tx([META, DATA], 'readwrite', function (s) { s[0].delete(id); s[1].delete(id); });
  }

  /** Το αυτόματο στιγμιότυπο γίνεται κανονική εργασία με όνομα. */
  function keepAuto(name) {
    return load(AUTO).then(function (snap) {
      if (!snap) throw new Error('Δεν υπάρχει αυτόματη αποθήκευση.');
      return write(uid(), String(name || '').trim() || 'Εργασία', snap);
    });
  }

  // -------------------------------------------------------- αρχείο .zsj ---

  function exportFile(id) {
    return Promise.all([meta(id), load(id)]).then(function (r) {
      var m = r[0] || {}, snap = r[1];
      if (!snap) throw new Error('Δεν βρέθηκε η εργασία.');
      var blob = new Blob([JSON.stringify({ zsgeolab: 1, tool: m.tool, name: m.name,
                                            saved: m.saved, snap: snap })],
                          { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = String(m.name || 'ergasia').replace(/[^\wͰ-Ͽ .-]+/g, '_') + '.zsj';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
      return m;
    });
  }

  function importFile(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function (ev) {
        var o;
        try { o = JSON.parse(ev.target.result); }
        catch (e) { rej(new Error('Το αρχείο δεν είναι έγκυρο .zsj.')); return; }
        if (!o || !o.snap) { rej(new Error('Το αρχείο δεν είναι εργασία ZS-GeoLab.')); return; }
        if (o.tool && _opts.tool && o.tool !== _opts.tool) {
          rej(new Error('Η εργασία προέρχεται από άλλο εργαλείο (' + o.tool + ').'));
          return;
        }
        res(write(uid(), o.name || file.name.replace(/\.[^.]+$/, ''), o.snap));
      };
      r.onerror = function () { rej(new Error('Δεν διαβάστηκε το αρχείο.')); };
      r.readAsText(file);
    });
  }

  // ---------------------------------------------------------------- init --

  function init(opts) {
    _opts = opts || {};
    AUTO = AUTO_PREFIX + (_opts.tool || '');
    global.Jobs.AUTO = AUTO;
    if (typeof _opts.snapshot !== 'function') {
      throw new Error('Jobs.init: λείπει η snapshot().');
    }
    // Το tab φεύγει στο παρασκήνιο: τελευταία ευκαιρία για εγγραφή.
    global.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { clearTimeout(_timer); autosave(); }
    });
    return load(AUTO).then(function (snap) { return snap; }, function () { return null; });
  }

  global.Jobs = {
    init: init, touch: touch, save: autosave, saveAs: saveAs, keepAuto: keepAuto,
    list: list, load: load, meta: meta, rename: rename, remove: remove,
    exportFile: exportFile, importFile: importFile, AUTO: AUTO
  };
})(window);
