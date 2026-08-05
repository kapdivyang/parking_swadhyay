// Service worker for the Event Parking PWA.
//
// The goal is narrow: when the network drops on the ground, an admin who
// already has the app open — or reopens it — must still reach the entry
// screen. Entries themselves queue in IndexedDB and sync later.

// Bumped whenever SHELL_URLS changes, so every phone drops the old cache
// and picks the new screens up on its next visit.
const VERSION = 'v3'
const SHELL = `parking-shell-${VERSION}`

// Pages the app must be able to open with no network at all.
// /entries needs the network for its data, but the shell being cached
// means it opens and says so, instead of showing the browser's error page.
const SHELL_URLS = [
  '/entry',
  '/search',
  '/entries',
  '/',
  '/offline',
  '/manifest.json',
  '/icon.svg',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // Individual failures must not abort the whole install
      .then((cache) => Promise.allSettled(SHELL_URLS.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

// Signing in or out empties the cache.
//
// The pages stored here are rendered for whoever was signed in at the
// time: the home screen names them and lists exactly what they may do.
// Serving that to the next person on the same phone is wrong even though
// every API call behind it is still checked — the block admin who is shown
// the Super Admin's screen has no way to know the buttons will not work.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CLEAR_CACHE') return

  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      // The page waits for this before navigating, so it must be answered
      // even if the deletion failed — a stuck login is worse than a stale
      // cache, and the hard navigation gets fresh HTML regardless.
      .catch(() => undefined)
      .then(() => event.ports[0]?.postMessage({ cleared: true })),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // API calls must never be served stale — a cached block list or search
  // result would be worse than an honest failure.
  if (url.pathname.startsWith('/api/')) return

  // Navigations: try the network, fall back to whatever we cached.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone()
          caches.open(SHELL).then((c) => c.put(request, copy))
          return res
        })
        .catch(async () => {
          const cached = await caches.match(request)
          if (cached) return cached
          // Entry is the screen that matters most when offline
          return (
            (await caches.match('/entry')) ??
            (await caches.match('/offline')) ??
            new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
          )
        })
    )
    return
  }

  // Static assets: serve from cache first, refresh in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(SHELL).then((c) => c.put(request, copy))
          }
          return res
        })
        .catch(() => cached)
      return cached ?? network
    })
  )
})
