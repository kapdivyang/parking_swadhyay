'use client'

import { useState } from 'react'
import { resetAndGo } from '@/lib/session-reset'

export default function LogoutButton() {
  const [busy, setBusy] = useState(false)

  async function logout() {
    if (busy) return
    setBusy(true)
    try {
      await fetch('/api/login', { method: 'DELETE' })
    } catch {
      // The cookie may not have been cleared server-side, but everything
      // cached on this device still has to go — on a shared phone that is
      // the part that matters.
    }
    // Clears the cached pages of the person signing out, then a full load
    await resetAndGo('/login')
  }

  return (
    <button
      onClick={logout}
      disabled={busy}
      className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 active:bg-slate-50 disabled:opacity-50"
    >
      {busy ? 'Signing out…' : 'Logout'}
    </button>
  )
}
