// Offline support + show-reminders for Concert & Event Log.
const CACHE = 'concert-log-local-v24';
const FIRED = 'cl-fired';   // reminders already shown (shared with the page)
const SHELL = ['./', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './maskable-512.png', './apple-touch-icon.png', './favicon-32.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== FIRED).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.includes('/__fired/')) return;
  if (url.origin === self.location.origin) {
    // network first so new versions show up; cached copy when offline
    // skip the browser's HTTP cache so a new upload to GitHub shows up as soon as Pages serves it
    e.respondWith(fetch(new Request(req, {cache:'no-cache'})).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html'))));
  } else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    })));
  }
});

/* ---------- reminders while the app is closed (Chrome decides how often this runs) ---------- */
self.addEventListener('periodicsync', e => {
  if (e.tag === 'cl-reminders') e.waitUntil(checkReminders());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:'window', includeUncontrolled:true}).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow('./');
  }));
});
function readConcerts(){
  return new Promise(res => {
    let r;
    try { r = indexedDB.open('concert-ticket-book'); } catch (e) { res([]); return; }
    r.onupgradeneeded = () => { r.transaction.abort(); };   // no data yet: don't create an empty database
    r.onerror = () => res([]);
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('concerts')) { db.close(); res([]); return; }
      const q = db.transaction('concerts').objectStore('concerts').getAll();
      q.onsuccess = () => { db.close(); res(q.result || []); };
      q.onerror = () => { db.close(); res([]); };
    };
  });
}
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const timeOf = c => /^\d{2}:\d{2}$/.test((c && c.time) || '') ? c.time : '';
const str = v => typeof v === 'string' ? v : '';
function remindersOf(c){
  if (!c || c.deleted || !Array.isArray(c.remind) || !isDate(c.date)) return [];
  const [y, m, d] = c.date.split('-').map(Number), t = timeOf(c);
  const [hh, mm] = t ? t.split(':').map(Number) : [9, 0];
  const base = new Date(y, m - 1, d, hh, mm).getTime();
  return c.remind.filter(n => Number.isFinite(n)).map(n => ({key:c.id + ':' + n + ':' + base, at:base - n * 60000, min:n}));
}
function reminderMsg(c, r){
  const a = str(c.artist) || 'Your show', t = timeOf(c);
  /* say how long is actually left, in case the alert arrives late */
  const left = r.at + r.min * 60000 - Date.now();
  let title;
  if (!t) title = r.min >= 1440 ? 'Tomorrow: ' + a : 'Today: ' + a;
  else if (left <= 0) title = a + ' is starting now';
  else if (left >= 20 * 3600e3) title = 'Tomorrow: ' + a;
  else if (left >= 3600e3) { const h = Math.round(left / 3600e3); title = a + ' in ' + h + (h === 1 ? ' hour' : ' hours'); }
  else title = a + ' in ' + Math.max(1, Math.round(left / 60000)) + ' min';
  const body = [str(c.title), [t ? 'Starts ' + t : '', str(c.venue)].filter(Boolean).join(' at ')].filter(Boolean).join('\n');
  return {title, body};
}
async function checkReminders(){
  const items = await readConcerts(), now = Date.now(), cache = await caches.open(FIRED);
  for (const c of items) {
    for (const r of remindersOf(c)) {
      if (r.at > now || r.at < now - 18 * 3600e3) continue;
      const key = './__fired/' + encodeURIComponent(r.key);
      if (await cache.match(key)) continue;
      await cache.put(key, new Response('1'));
      const msg = reminderMsg(c, r);
      await self.registration.showNotification(msg.title, {body:msg.body, icon:'icon-192.png', tag:r.key, data:{id:c.id}});
    }
  }
}
