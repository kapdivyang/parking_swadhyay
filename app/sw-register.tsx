'use client'

import { useEffect } from 'react'

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    // Only register on HTTPS (or localhost) — the browser rejects it otherwise
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') return

    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Registration failing must never break the app — entries still queue
      // in IndexedDB, only the offline page load is lost.
    })
  }, [])

  return null
}
