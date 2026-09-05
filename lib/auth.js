/* ZS-Top — Auth wrapper (Supabase + Demo fallback)
 * Χρειάζεται να έχει φορτωθεί πρώτα το config.js.
 *
 *   ZSAuth.ready            -> Promise (resolve όταν είναι έτοιμο)
 *   ZSAuth.mode             -> 'supabase' | 'demo'
 *   ZSAuth.register({email,password,name})
 *   ZSAuth.login({email,password})
 *   ZSAuth.loginGoogle()
 *   ZSAuth.logout()
 *   ZSAuth.getUser()        -> {id,email,name} | null
 *   ZSAuth.onChange(cb)     -> cb(user|null)
 *   ZSAuth.requireAuth(url) -> redirect αν δεν είναι συνδεδεμένος
 */
(function (global) {
  'use strict';
  var cfg = global.ZS_CONFIG || {};
  var useSupabase = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
  var listeners = [];
  var current = null;
  var sb = null;

  function emit() { listeners.forEach(function (cb) { try { cb(current); } catch (e) {} }); }
  function norm(u) {
    if (!u) return null;
    return { id: u.id, email: u.email, name: (u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name)) || u.name || (u.email ? u.email.split('@')[0] : '') };
  }

  /* ---------- SUPABASE MODE ---------- */
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  function initSupabase() {
    return loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2').then(function () {
      sb = global.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
      return sb.auth.getSession().then(function (r) {
        current = norm(r.data.session && r.data.session.user);
        sb.auth.onAuthStateChange(function (_ev, session) {
          current = norm(session && session.user); emit();
        });
      });
    });
  }
  var supaAPI = {
    register: function (o) {
      return sb.auth.signUp({ email: o.email, password: o.password, options: { data: { full_name: o.name || '' } } })
        .then(function (r) { if (r.error) throw r.error; return norm(r.data.user); });
    },
    login: function (o) {
      return sb.auth.signInWithPassword({ email: o.email, password: o.password })
        .then(function (r) { if (r.error) throw r.error; return norm(r.data.user); });
    },
    loginGoogle: function () {
      return sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } })
        .then(function (r) { if (r.error) throw r.error; });
    },
    logout: function () { return sb.auth.signOut().then(function () { current = null; emit(); }); }
  };

  /* ---------- DEMO MODE (localStorage — ΜΟΝΟ preview, ΜΗ ασφαλές) ---------- */
  var DB = 'zs_demo_users', SES = 'zs_demo_session';
  function dbGet() { try { return JSON.parse(localStorage.getItem(DB) || '{}'); } catch (e) { return {}; } }
  function dbSet(o) { try { localStorage.setItem(DB, JSON.stringify(o)); } catch (e) {} }
  function initDemo() {
    try {
      var em = localStorage.getItem(SES);
      if (em) { var u = dbGet()[em]; if (u) current = { id: em, email: em, name: u.name }; }
    } catch (e) {}
    return Promise.resolve();
  }
  var demoAPI = {
    register: function (o) {
      return new Promise(function (res, rej) {
        var users = dbGet();
        if (users[o.email]) return rej(new Error('Υπάρχει ήδη λογαριασμός με αυτό το email.'));
        if (!o.email || !o.password || o.password.length < 6) return rej(new Error('Δώσε έγκυρο email και κωδικό ≥ 6 χαρακτήρες.'));
        users[o.email] = { name: o.name || o.email.split('@')[0], password: o.password };
        dbSet(users);
        try { localStorage.setItem(SES, o.email); } catch (e) {}
        current = { id: o.email, email: o.email, name: users[o.email].name }; emit(); res(current);
      });
    },
    login: function (o) {
      return new Promise(function (res, rej) {
        var u = dbGet()[o.email];
        if (!u || u.password !== o.password) return rej(new Error('Λάθος email ή κωδικός.'));
        try { localStorage.setItem(SES, o.email); } catch (e) {}
        current = { id: o.email, email: o.email, name: u.name }; emit(); res(current);
      });
    },
    loginGoogle: function () { return Promise.reject(new Error('Το «Σύνδεση με Google» δουλεύει μόνο με πραγματικό Supabase.')); },
    logout: function () { try { localStorage.removeItem(SES); } catch (e) {} current = null; emit(); return Promise.resolve(); }
  };

  /* ---------- PUBLIC ---------- */
  var active = useSupabase ? supaAPI : demoAPI;
  var ZSAuth = {
    mode: useSupabase ? 'supabase' : 'demo',
    register: function (o) { return active.register(o); },
    login: function (o) { return active.login(o); },
    loginGoogle: function () { return active.loginGoogle(); },
    logout: function () { return active.logout(); },
    getUser: function () { return current; },
    onChange: function (cb) { listeners.push(cb); cb(current); },
    requireAuth: function (url) { if (!current) { location.href = url || ('account.html?next=' + encodeURIComponent(location.pathname.split('/').pop())); return false; } return true; }
  };
  ZSAuth.ready = (useSupabase ? initSupabase().catch(function (e) {
    console.error('Supabase init failed, fallback σε demo:', e);
    ZSAuth.mode = 'demo'; active = demoAPI; return initDemo();
  }) : initDemo()).then(function () { emit(); return ZSAuth; });

  global.ZSAuth = ZSAuth;
})(window);
