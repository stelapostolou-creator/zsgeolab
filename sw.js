/*  ZS-GeoLab — service worker για ΟΛΟ το site.
 *
 *  Ένας service worker στη ρίζα του site, αντί για έναν ανά εργαλείο:
 *  οι βιβλιοθήκες ζουν στο /lib/ και ένας worker μέσα στο /sw-maps-gr/ δεν θα
 *  μπορούσε να τις εξυπηρετήσει εκτός σύνδεσης — είναι έξω από την εμβέλειά του.
 *
 *  Στρατηγική network-first: όσο υπάρχει σήμα ο χρήστης παίρνει πάντα την
 *  τελευταία έκδοση· η μνήμη είναι μόνο για το χωράφι, όπου δεν υπάρχει σήμα.
 *  Σε κάθε αλλαγή αρχείων αυξάνεται το CACHE, αλλιώς μένουν παλιά αρχεία.
 */
var CACHE = 'zsgeolab-v2';

var SHELL = [
  './', 'index.html',
  'sw-maps-gr/index.html', 'sw-maps/index.html',
  // Ίδιες διευθύνσεις με τις σελίδες, μαζί με την έκδοση: η μνήμη κρατά
  // κλειδί τη ΔΙΕΥΘΥΝΣΗ, οπότε χωρίς αυτήν θα κρατούσε άλλο αρχείο.
  'lib/hepos.js?v=20260906g', 'lib/hepos_grids.js',
  'lib/swmaps.js?v=20260906g', 'lib/jobs.js?v=20260906g',
  'lib/server-check.js?v=20260906g',
  'lib/vendor/leaflet.css', 'lib/vendor/leaflet.js', 'lib/vendor/proj4.js',
  'lib/vendor/xlsx.full.min.js', 'lib/vendor/sql-wasm.js', 'lib/vendor/sql-wasm.wasm',
  'assets/zsgeolab-logo.png', 'assets/zstop-logo.png',
  'sw-maps-gr/manifest.webmanifest', 'sw-maps/manifest.webmanifest',
  'sw-maps-gr/icon-192.png', 'sw-maps-gr/icon-512.png',
  'sw-maps/icon-192.png', 'sw-maps/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      // allSettled: ένα αρχείο που λείπει δεν ρίχνει ολόκληρη την εγκατάσταση.
      .then(function (c) { return Promise.allSettled(SHELL.map(function (u) { return c.add(u); })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.filter(function (k) { return k !== CACHE; })
                          .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var u = e.request.url;
  // Πλακίδια χάρτη και κλήσεις API: δεν αποθηκεύονται.
  if (u.indexOf('tile.openstreetmap') >= 0 || u.indexOf('arcgisonline') >= 0 ||
      u.indexOf('epsg.io') >= 0 || u.indexOf('/api/') >= 0) return;
  e.respondWith(
    fetch(e.request).then(function (resp) {
      if (resp && resp.ok) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return resp;
    }).catch(function () { return caches.match(e.request); })
  );
});
