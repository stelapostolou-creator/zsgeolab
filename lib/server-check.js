/*  ZS-GeoLab — ο server των PRO εργαλείων.
 *
 *  Μερικά εργαλεία (WGS84↔ΕΓΣΑ87, Ομοιότητας & Αφινικός, DXF του HATT,
 *  Ισοϋψείς & DTM, Όγκοι) τρέχουν εξ ολοκλήρου σε Python, ώστε ο κώδικας να
 *  μη φεύγει ποτέ στον browser.
 *
 *  Στη φιλοξενία η σελίδα (GitHub Pages) και το API (Render) είναι σε
 *  ΧΩΡΙΣΤΑ domain — ο browser χρειάζεται ρητή διεύθυνση για να το βρει.
 *  Τοπικά, ο ένας «python server.py» σερβίρει σελίδα και API από το ίδιο
 *  127.0.0.1, οπότε το API μένει στο ίδιο origin.
 *
 *      ZSServer.api('/api/dtm/build')            -> πλήρες URL προς το API
 *      ZSServer.check().then(function (up) {...}) -> υπάρχει ο server;
 *      ZSServer.banner('<b>…</b>')               -> ειδοποίηση αν λείπει
 */
(function (global) {
  'use strict';

  /*  Πού ζει το API.
   *  - file:  (διπλό κλικ) ή localhost/127.0.0.1: ίδιο origin, κενή ρίζα.
   *  - παντού αλλού: το web service στο Render. Πρόσθεσε εδώ εναλλακτική
   *    διεύθυνση μόνο αν αλλάξει ο πάροχος. */
  var API = (function () {
    var loc = global.location || {};
    var h = loc.hostname || '';
    if (loc.protocol === 'file:') return '';
    if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return '';
    return 'https://zsgeolab-api.onrender.com';
  })();

  /** Πλήρες URL για μια διαδρομή του API. Δέχεται και έτοιμο http(s) URL. */
  function api(path) {
    if (!path) return API;
    if (/^https?:\/\//i.test(path)) return path;
    return API + (path.charAt(0) === '/' ? path : '/' + path);
  }

  var _p = null;

  function check() {
    if (_p) return _p;
    // Άνοιγμα με διπλό κλικ: δεν μπορεί να υπάρχει server.
    if ((global.location || {}).protocol === 'file:') {
      _p = Promise.resolve(false);
      return _p;
    }
    var ctl = ('AbortController' in global) ? new AbortController() : null;
    /*  Το δωρεάν πλάνο του Render κοιμάται μετά από 15′ αδράνειας· η πρώτη
     *  κλήση μετά τον ύπνο αργεί δεκάδες δευτερόλεπτα. Το όριο είναι
     *  γενναιόδωρο ώστε ο έλεγχος να προλαβαίνει να τον ξυπνήσει αντί να τον
     *  δηλώσει νεκρό. */
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 20000);
    _p = fetch(api('/api/health'), { signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return !!(j && j.ok); })
      .catch(function () { return false; })
      .then(function (up) {
        clearTimeout(timer);
        // Αποτυχία δεν «κλειδώνει»: ο server μπορεί απλώς να ξυπνούσε — η
        // επόμενη κλήση (π.χ. μετά από ενέργεια του χρήστη) ξαναδοκιμάζει.
        if (!up) _p = null;
        return up;
      });
    return _p;
  }

  /** Δείχνει ειδοποίηση στην κορυφή της σελίδας όταν λείπει ο server. */
  function banner(text) {
    return check().then(function (up) {
      if (up) return true;
      var d = document.createElement('div');
      d.setAttribute('role', 'status');
      d.style.cssText = 'margin:14px auto;max-width:1100px;padding:12px 16px;' +
        'border:1px solid #7a5b12;border-radius:10px;background:#2a2210;' +
        'color:#f5d98a;font-size:14px;line-height:1.5';
      d.innerHTML = text;
      var host = document.querySelector('main') || document.body;
      host.insertBefore(d, host.firstChild);
      return false;
    });
  }

  global.ZSServer = { check: check, banner: banner, api: api, base: API };
})(window);
