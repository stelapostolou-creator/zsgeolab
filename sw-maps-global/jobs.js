/*  ZS-GeoLab — job storage (history) for the SW Maps tools. English fork of
 *  the shared lib/jobs.js, dedicated to SW Global — kept separate so the
 *  live GR tool's own copy and its Greek default names stay untouched.
 *
 *  The user works in the field; a refresh or closing the tab must not lose
 *  stakeout points. Data lives in the device's IndexedDB — localStorage
 *  isn't enough (~5MB limit, a .swm2 can exceed it).
 *
 *  ONE CURRENT JOB, ALWAYS
 *  When a job is opened or saved, it becomes "active" and every following
 *  change is written INTO IT. Otherwise every new point would need a new
 *  "Save as..." and the user would end up with dozens of near-identical
 *  files — with the risk of opening the wrong one.
 *  While no job is active, work is kept in one anonymous slot, so a refresh
 *  loses nothing.
 *
 *  API:  Jobs.init(opts) · Jobs.touch() · Jobs.list() · Jobs.load(id)
 *        Jobs.saveAs(name) · Jobs.rename(id,name) · Jobs.remove(id)
 *        Jobs.setActive(id) · Jobs.getActive() · Jobs.activeMeta()
 *        Jobs.exportFile(id) · Jobs.importFile(file)
 */
(function (global) {
  'use strict';

  /*  SEPARATE DATABASE PER TOOL.
   *
   *  With one shared database, isolation relied on filtering at read time —
   *  and a filter can be bypassed by mistake. With separate databases there
   *  is nothing to leak: one tool can't even see another's data. Jobs move
   *  between tools only via a .zsj file, i.e. only when the user asks for it.
   */
  var OLD_DB = 'zsgeolab';                     // shared database from an older version
  var DB_NAME = 'zsgeolab', VER = 1, META = 'jobs_meta', DATA = 'jobs_data';
  var AUTO_PREFIX = '__auto:', AUTO = AUTO_PREFIX;
  var _db = null, _opts = null, _timer = null, _busy = false, _active = null;

  function openNamed(name, ver) {
    return new Promise(function (res, rej) {
      var rq = indexedDB.open(name, ver || VER);
      rq.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA, { keyPath: 'id' });
      };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error || new Error('IndexedDB')); };
    });
  }

  /*  The database can exist without the stores — e.g. if something opened it
   *  unversioned before we created them. Then every read would throw. This
   *  bumps the version so onupgradeneeded runs and creates them. */
  function open() {
    if (_db) return Promise.resolve(_db);
    return openNamed(DB_NAME).then(function (db) {
      if (db.objectStoreNames.contains(META) && db.objectStoreNames.contains(DATA)) {
        _db = db;
        return db;
      }
      var next = db.version + 1;
      db.close();
      return openNamed(DB_NAME, next).then(function (d2) { _db = d2; return d2; });
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

  // ------------------------------------------------------- active job -----

  function activeKey() { return 'zs_active_job:' + (_opts.tool || ''); }

  function getActive() { return _active; }

  function setActive(id) {
    _active = id || null;
    try {
      if (_active) localStorage.setItem(activeKey(), _active);
      else localStorage.removeItem(activeKey());
    } catch (e) {}                       // private browsing: just won't remember
    return _active;
  }

  function activeMeta() {
    return _active ? meta(_active) : Promise.resolve(null);
  }

  // ------------------------------------------------------------- write ---

  function write(id, name, snap) {
    var m = { id: id, name: name, saved: Date.now(),
              tool: _opts.tool, info: snap.info || {} };
    return tx([META, DATA], 'readwrite', function (s) {
      s[0].put(m);
      s[1].put({ id: id, snap: snap });
    }).then(function () { return m; });
  }

  /** Writes the current snapshot: into the active job, else the anonymous one. */
  function autosave() {
    if (_busy || !_opts) return Promise.resolve(null);
    _busy = true;
    var snap = null;
    try { snap = _opts.snapshot(); } catch (e) { snap = null; }
    var done = function (r) { _busy = false; return r; };

    if (!snap || snap.empty) {
      // A NAMED job is not deleted just because the screen emptied out —
      // that would wipe a day's work with one "Clear".
      if (_active) return Promise.resolve(null).then(done);
      return remove(AUTO).then(done, done);
    }

    if (!_active) {
      return write(AUTO, _opts.autoName || 'Latest job', snap)
        .then(function (m) { if (_opts.onSaved) _opts.onSaved(m); return m; },
              function () { return null; })
        .then(done);
    }

    var id = _active;
    return meta(id).then(function (m) {
      if (!m) { setActive(null); return null; }   // deleted elsewhere
      return write(id, m.name, snap).then(function (mm) {
        if (_opts.onSaved) _opts.onSaved(mm);
        return mm;
      });
    }).catch(function () { return null; }).then(done);
  }

  /** Called after every change; the write itself is debounced. */
  function touch(ms) {
    if (!_opts) return;
    clearTimeout(_timer);
    _timer = setTimeout(autosave, ms == null ? 1200 : ms);
  }

  /** New named job — and it becomes the active one. */
  function saveAs(name) {
    var snap = _opts.snapshot();
    if (!snap || snap.empty) {
      return Promise.reject(new Error('There is nothing to save.'));
    }
    var id = uid();
    return write(id, String(name || '').trim() || 'Job', snap).then(function (m) {
      setActive(id);
      // The anonymous slot held THIS job; now it has a name, and the
      // anonymous slot would otherwise reappear stale on the next close.
      return remove(AUTO).then(function () { return m; }, function () { return m; });
    });
  }

  // -------------------------------------------------------------- read ---

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
      if (!m) throw new Error('Job not found.');
      m.name = String(name || '').trim() || m.name;
      return tx([META], 'readwrite', function (s) { s[0].put(m); }).then(function () { return m; });
    });
  }

  function remove(id) {
    if (id === _active) setActive(null);
    return tx([META, DATA], 'readwrite', function (s) { s[0].delete(id); s[1].delete(id); });
  }

  // ------------------------------------------------------------ .zsj file --

  function exportFile(id) {
    return Promise.all([meta(id), load(id)]).then(function (r) {
      var m = r[0] || {}, snap = r[1];
      if (!snap) throw new Error('Job not found.');
      var blob = new Blob([JSON.stringify({ zsgeolab: 1, tool: m.tool, name: m.name,
                                            saved: m.saved, snap: snap })],
                          { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = String(m.name || 'job').replace(/[^\wͰ-Ͽ .-]+/g, '_') + '.zsj';
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
        catch (e) { rej(new Error('The file is not a valid .zsj.')); return; }
        if (!o || !o.snap) { rej(new Error('The file is not a ZS-GeoLab job.')); return; }
        if (o.tool && _opts.tool && o.tool !== _opts.tool) {
          // Allowed, but only knowingly: the two tools keep a different
          // reference system, so something might not carry over.
          var ok = global.confirm(
            'This job is from another tool (' + o.tool + ').\n\n' +
            'It can be imported, but settings like the coordinate system ' +
            'may not carry over. Continue?');
          if (!ok) { rej(new Error('Cancelled.')); return; }
        }
        res(write(uid(), o.name || file.name.replace(/\.[^.]+$/, ''), o.snap));
      };
      r.onerror = function () { rej(new Error('The file could not be read.')); };
      r.readAsText(file);
    });
  }

  // ------------------------------------------------------------------ init --

  /*  Migration from the old shared database: only this tool's own jobs are
   *  copied. The old database is left untouched — if something goes wrong,
   *  the data is still there. Runs once per device. */
  function migrateOnce() {
    var flag = 'zs_jobs_migrated:' + (_opts.tool || '');
    try { if (localStorage.getItem(flag)) return Promise.resolve(0); } catch (e) {}
    return openNamed(OLD_DB).then(function (old) {
      return new Promise(function (res) {
        var t = old.transaction([META, DATA], 'readonly');
        var rq = t.objectStore(META).getAll();
        rq.onsuccess = function () {
          var rows = (rq.result || []).filter(function (r) { return r.tool === _opts.tool; });
          if (!rows.length) { old.close(); res(0); return; }
          var left = rows.length, moved = 0;
          rows.forEach(function (m) {
            var dq = old.transaction([DATA], 'readonly').objectStore(DATA).get(m.id);
            dq.onsuccess = function () {
              var snap = dq.result && dq.result.snap;
              var done = function () { if (--left === 0) { old.close(); res(moved); } };
              if (!snap) { done(); return; }
              tx([META, DATA], 'readwrite', function (st) {
                st[0].put(m); st[1].put({ id: m.id, snap: snap });
              }).then(function () { moved++; done(); }, done);
            };
            dq.onerror = function () { if (--left === 0) { old.close(); res(moved); } };
          });
        };
        rq.onerror = function () { old.close(); res(0); };
      });
    }).catch(function () { return 0; }).then(function (n) {
      try { localStorage.setItem(flag, '1'); } catch (e) {}
      return n;
    });
  }

  function init(opts) {
    _opts = opts || {};
    DB_NAME = 'zsgeolab-' + (_opts.tool || 'default');   // must be set before any open()
    AUTO = AUTO_PREFIX + (_opts.tool || '');
    global.Jobs.AUTO = AUTO;
    if (typeof _opts.snapshot !== 'function') {
      throw new Error('Jobs.init: snapshot() is missing.');
    }
    // The tab is going to the background: last chance to write.
    global.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { clearTimeout(_timer); autosave(); }
    });

    try { _active = localStorage.getItem(activeKey()) || null; } catch (e) { _active = null; }

    // The active job may have been deleted from another tab.
    return migrateOnce().then(function () {
      return _active ? meta(_active).catch(function () { return null; })
                     : Promise.resolve(null);
    }).then(function (m) {
      if (_active && !m) setActive(null);
      return load(_active || AUTO).catch(function () { return null; });
    }).then(function (snap) {
      return { snap: snap, activeId: _active };
    });
  }

  /** Drops the anonymous slot once the user moves to a named job. */
  function dropAuto() { return remove(AUTO).catch(function () {}); }

  global.Jobs = {
    init: init, touch: touch, save: autosave, saveAs: saveAs, dropAuto: dropAuto,
    setActive: setActive, getActive: getActive, activeMeta: activeMeta,
    list: list, load: load, meta: meta, rename: rename, remove: remove,
    exportFile: exportFile, importFile: importFile, AUTO: AUTO
  };
})(window);
