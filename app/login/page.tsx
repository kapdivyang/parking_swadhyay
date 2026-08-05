'use client'

import { useState } from 'react'
import { resetAndGo } from '@/lib/session-reset'

export default function LoginPage() {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!pin || busy) return

    setBusy(true)
    setError('')

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      })
      const json = await res.json()

      if (!res.ok) {
        setError(json.error ?? 'Login failed')
        setPin('')
        setBusy(false)
        return
      }

      // Everything the browser cached belonged to whoever was signed in
      // before. This clears it and does a full page load, so the screen
      // that appears is rendered for this account and no other.
      //
      // busy deliberately stays true from here: the page is on its way
      // out, and re-enabling the button would only invite a second tap.
      await resetAndGo('/')
    } catch {
      setError('Network problem — please try again')
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-3xl font-bold">Event Parking</h1>
        <p className="mb-8 text-center text-slate-500">Enter your PIN to continue</p>

        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="• • • •"
          className="w-full rounded-2xl border-2 border-slate-300 bg-white px-6 py-6 text-center text-4xl tracking-[0.5em] outline-none focus:border-blue-600"
        />

        {error && (
          <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-center font-medium text-red-700">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || !pin}
          className="mt-6 w-full rounded-2xl bg-blue-600 py-5 text-xl font-bold text-white active:bg-blue-700 disabled:opacity-40"
        >
          {busy ? 'Please wait…' : 'LOGIN'}
        </button>
      </form>
    </main>
  )
}
