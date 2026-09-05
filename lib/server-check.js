/*  ZS-GeoLab — εντοπισμός του server των PRO εργαλείων.
 *
 *  Μερικά εργαλεία (WGS84↔ΕΓΣΑ87, Ομοιότητας & Αφινικός, DXF του HATT) τρέχουν
 *  εξ ολοκλήρου σε Python, ώστε ο κώδικας να μη φεύγει ποτέ στον browser. Σε
 *  στατική φιλοξενία δεν υπάρχει Python: χωρίς έλεγχο, κάθε κουμπί τους θα
 *  έβγαζε σφάλμα δικτύου και το site θα έμοιαζε χαλασμένο.
 *
 *  Ο έλεγχος γίνεται μία φορά και το αποτέλεσμα μοιράζεται σε όσους το ζητούν.
 *
 *      ZSServer.check().then(function (up) { ... });
 */
(function (global) {
  'use strict';

  // Η ρίζα του site προκύπτει από τη διεύθυνση του ίδιου του αρχείου, ώστε
  // ο έλεγχος να δουλεύει και όταν το site δεν είναι στη ρίζα του τομέα.
  var HERE = (document.currentScript && document.currentScript.src) || '';
  var ROOT = HERE ? HERE.replace(/lib\/server-check\.js.*$/, '') : '';

  var _p = null;

  function check() {
    if (_p) return _p;
    // Άνοιγμα με διπλό κλικ: δεν μπορεί να υπάρχει server.
    if (location.protocol === 'file:') {
      _p = Promise.resolve(false);
      return _p;
    }
    var ctl = ('AbortController' in global) ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 4000);
    _p = fetch(ROOT + 'api/health', { signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return !!(j && j.ok); })
      .catch(function () { return false; })
      .then(function (up) { clearTimeout(timer); return up; });
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

  global.ZSServer = { check: check, banner: banner };
})(window);
