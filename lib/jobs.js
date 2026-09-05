/*  ZS-GeoLab — αποθήκευση εργασιών (ιστορικό) για τα εργαλεία SW Maps.
 *
 *  Ο χρήστης δουλεύει στο χωράφι· ένα refresh ή ένα κλείσιμο του tab δεν
 *  πρέπει να χάνει τα σημεία χάραξης. Τα δεδομένα μένουν στο IndexedDB της
 *  συσκευής — το localStorage δεν επαρκεί (όριο ~5MB, ένα .swm2 το ξεπερνά).
 *
 *  ΜΙΑ ΤΡΕΧΟΥΣΑ ΕΡΓΑΣΙΑ, ΠΑΝΤΑ
 *  Όταν ανοίγει ή αποθηκεύεται μια εργασία, γίνεται η «ενεργή» και κάθε
 *  επόμενη αλλαγή γράφεται ΜΕΣΑ ΣΕ ΑΥΤΗΝ. Αλλιώς κάθε νέο σημείο θα απαιτούσε
 *  νέα «Αποθήκευση ως…» και ο χρήστης θα κατέληγε με δεκάδες σχεδόν ίδια
 *  αρχεία — και με το ρίσκο να ανοίξει το λάθος.
 *  Όσο δεν υπάρχει ενεργή εργασία, η δουλειά κρατιέται σε μία ανώνυμη θέση,
 *  ώστε ένα refresh να μη χάνει τίποτα.
 *
 *  API:  Jobs.init(opts) · Jobs.touch() · Jobs.list() · Jobs.load(id)
 *        Jobs.saveAs(name) · Jobs.rename(id,name) · Jobs.remove(id)
 *        Jobs.setActive(id) · Jobs.getActive() · Jobs.activeMeta()
 *        Jobs.exportFile(id) · Jobs.importFile(file)
 */
(function (global) {
  'use strict';

  var DB_NAME = 'zsgeolab', VER = 1, META = 'jobs_meta', DATA = 'jobs_data';
  // Η ανώνυμη θέση είναι ΑΝΑ ΕΡΓΑΛΕΙΟ: με κοινό κλειδί, το άνοιγμα του
  // δεύτερου εργαλείου έσβηνε τη μισοτελειωμένη δουλειά του πρώτου.
  var AUTO_PREFIX = '__auto:', AUTO = AUTO_PREFIX;
  var _db = null, _opts = null, _timer = null, _busy = false, _active = null;

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

  // ------------------------------------------------- η ενεργή εργασία -----

  function activeKey() { return 'zs_active_job:' + (_opts.tool || ''); }

  function getActive() { return _active; }

  function setActive(id) {
    _active = id || null;
    try {
      if (_active) localStorage.setItem(activeKey(), _active);
      else localStorage.removeItem(activeKey());
    } catch (e) {}                       // ιδιωτική περιήγηση: απλώς δεν θυμάται
    return _active;
  }

  function activeMeta() {
    return _active ? meta(_active) : Promise.resolve(null);
  }

  // ------------------------------------------------------------ εγγραφή ---

  function write(id, name, snap) {
    var m = { id: id, name: name, saved: Date.now(),
              tool: _opts.tool, info: snap.info || {} };
    return tx([META, DATA], 'readwrite', function (s) {
      s[0].put(m);
      s[1].put({ id: id, snap: snap });
    }).then(function () { return m; });
  }

  /** Γράφει το τρέχον στιγμιότυπο: στην ενεργή εργασία, αλλιώς στην ανώνυμη. */
  function autosave() {
    if (_busy || !_opts) return Promise.resolve(null);
    _busy = true;
    var snap = null;
    try { snap = _opts.snapshot(); } catch (e) { snap = null; }
    var done = function (r) { _busy = false; return r; };

    if (!snap || snap.empty) {
      // Μια ΟΝΟΜΑΣΜΕΝΗ εργασία δεν διαγράφεται επειδή άδειασε η οθόνη —
      // αυτό θα έσβηνε δουλειά μέρας με ένα «Καθαρισμός».
      if (_active) return Promise.resolve(null).then(done);
      return remove(AUTO).then(done, done);
    }

    if (!_active) {
      return write(AUTO, _opts.autoName || 'Τελευταία εργασία', snap)
        .then(function (m) { if (_opts.onSaved) _opts.onSaved(m); return m; },
              function () { return null; })
        .then(done);
    }

    var id = _active;
    return meta(id).then(function (m) {
      if (!m) { setActive(null); return null; }   // διαγράφηκε αλλού
      return write(id, m.name, snap).then(function (mm) {
        if (_opts.onSaved) _opts.onSaved(mm);
        return mm;
      });
    }).catch(function () { return null; }).then(done);
  }

  /** Καλείται μετά από κάθε αλλαγή· η εγγραφή γίνεται μία φορά, με καθυστέρηση. */
  function touch(ms) {
    if (!_opts) return;
    clearTimeout(_timer);
    _timer = setTimeout(autosave, ms == null ? 1200 : ms);
  }

  /** Νέα εργασία με όνομα — και γίνεται η ενεργή. */
  function saveAs(name) {
    var snap = _opts.snapshot();
    if (!snap || snap.empty) {
      return Promise.reject(new Error('Δεν υπάρχει τίποτα προς αποθήκευση.'));
    }
    var id = uid();
    return write(id, String(name || '').trim() || 'Εργασία', snap).then(function (m) {
      setActive(id);
      // Η ανώνυμη θέση κρατούσε ΑΥΤΗ τη δουλειά· τώρα έχει όνομα και θα
      // ξαναεμφανιζόταν μπαγιάτικη στο επόμενο κλείσιμο.
      return remove(AUTO).then(function () { return m; }, function () { return m; });
    });
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
    if (id === _active) setActive(null);
    return tx([META, DATA], 'readwrite', function (s) { s[0].delete(id); s[1].delete(id); });
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

    try { _active = localStorage.getItem(activeKey()) || null; } catch (e) { _active = null; }

    // Η ενεργή εργασία μπορεί να έχει διαγραφεί από άλλη καρτέλα.
    var check = _active ? meta(_active).catch(function () { return null; })
                        : Promise.resolve(null);
    return check.then(function (m) {
      if (_active && !m) setActive(null);
      return load(_active || AUTO).catch(function () { return null; });
    }).then(function (snap) {
      return { snap: snap, activeId: _active };
    });
  }

  /** Πετάει την ανώνυμη θέση όταν ο χρήστης περνά σε ονομασμένη εργασία. */
  function dropAuto() { return remove(AUTO).catch(function () {}); }

  global.Jobs = {
    init: init, touch: touch, save: autosave, saveAs: saveAs, dropAuto: dropAuto,
    setActive: setActive, getActive: getActive, activeMeta: activeMeta,
    list: list, load: load, meta: meta, rename: rename, remove: remove,
    exportFile: exportFile, importFile: importFile, AUTO: AUTO
  };
})(window);
