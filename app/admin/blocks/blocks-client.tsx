'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import type { BlockStatus } from '../../dashboard/dashboard-client'

const VEHICLE_TYPES = [
  { v: 'car', label: 'Car' },
  { v: 'bike', label: 'Bike' },
  { v: 'bus', label: 'Bus' },
  { v: 'mixed', label: 'Mixed' },
]

export default function BlocksClient() {
  const [blocks, setBlocks] = useState<BlockStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)

  const [form, setForm] = useState({
    name: '',
    landmark: '',
    capacity: '',
    vehicle_type: 'car',
  })

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/blocks')
      const json = await res.json()
      if (res.ok) setBlocks(json.blocks ?? [])
      else setError(json.error ?? 'Could not load')
    } catch {
      setError('Network problem')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function addBlock(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return

    setBusy(true)
    setError('')

    try {
      const res = await fetch('/api/blocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          landmark: form.landmark,
          capacity: Number(form.capacity),
          vehicle_type: form.vehicle_type,
          sort_order: blocks.length + 1,
        }),
      })
      const json = await res.json()

      if (!res.ok) {
        setError(json.error ?? 'Could not create block')
        return
      }
      setForm({ name: '', landmark: '', capacity: '', vehicle_type: form.vehicle_type })
      await load()
    } catch {
      setError('Network problem')
    } finally {
      setBusy(false)
    }
  }

  async function updateCapacity(id: string, capacity: number) {
    setError('')
    const res = await fetch(`/api/blocks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capacity }),
    })
    const json = await res.json()
    if (!res.ok) setError(json.error ?? 'Could not update')
    setEditing(null)
    await load()
  }

  async function removeBlock(id: string, name: string) {
    if (!confirm(`Delete block "${name}"?`)) return
    setError('')
    const res = await fetch(`/api/blocks/${id}`, { method: 'DELETE' })
    const json = await res.json()
    if (!res.ok) setError(json.error ?? 'Could not delete')
    await load()
  }

  return (
    <main className="mx-auto max-w-2xl pb-24">
      <div className="bg-purple-800 px-5 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="rounded-lg border border-white/30 px-3 py-1.5 text-sm text-white"
              aria-label="Home"
            >
              ←
            </Link>
            <h1 className="text-xl font-bold text-white">Manage Blocks</h1>
          </div>
          <Link href="/" className="text-sm text-white/70">
            Home
          </Link>
        </div>
      </div>

      <div className="px-5 pt-5">
        {/* New block */}
        <form onSubmit={addBlock} className="rounded-2xl bg-white p-5">
          <h2 className="mb-4 font-bold">New Block</h2>

          <div className="grid gap-3 sm:grid-cols-2">
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value.toUpperCase() })}
              placeholder="Block name (e.g. B-3)"
              required
              autoComplete="off"
              className="rounded-xl border-2 border-slate-300 px-4 py-3 font-mono font-bold outline-none focus:border-purple-600"
            />
            <input
              value={form.capacity}
              onChange={(e) => setForm({ ...form, capacity: e.target.value })}
              placeholder="Capacity"
              inputMode="numeric"
              required
              className="rounded-xl border-2 border-slate-300 px-4 py-3 outline-none focus:border-purple-600"
            />
          </div>

          <input
            value={form.landmark}
            onChange={(e) => setForm({ ...form, landmark: e.target.value })}
            placeholder="Landmark — e.g. Near Gate 2, opposite blue tent"
            autoComplete="off"
            className="mt-3 w-full rounded-xl border-2 border-slate-300 px-4 py-3 outline-none focus:border-purple-600"
          />
          <p className="mt-1.5 text-xs text-slate-500">
            The landmark is shown in search results — &quot;B-3&quot; alone will not help people
            find the spot
          </p>

          <div className="mt-3 flex gap-2">
            {VEHICLE_TYPES.map((t) => (
              <button
                key={t.v}
                type="button"
                onClick={() => setForm({ ...form, vehicle_type: t.v })}
                className={`flex-1 rounded-xl border-2 py-2.5 text-sm font-medium ${
                  form.vehicle_type === t.v
                    ? 'border-purple-600 bg-purple-50 text-purple-800'
                    : 'border-slate-200 text-slate-500'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <button
            type="submit"
            disabled={busy}
            className="mt-4 w-full rounded-xl bg-purple-700 py-4 font-bold text-white active:bg-purple-800 disabled:opacity-40"
          >
            {busy ? 'Please wait…' : 'ADD BLOCK'}
          </button>
        </form>

        {error && (
          <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 font-medium text-red-700">{error}</p>
        )}

        {/* Existing blocks */}
        <h2 className="mb-3 mt-6 font-bold text-slate-600">
          Blocks {blocks.length > 0 && `(${blocks.length})`}
        </h2>

        {loading && <p className="text-slate-400">Loading…</p>}

        <div className="space-y-2">
          {blocks.map((b) => (
            <div key={b.id} className="rounded-2xl bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xl font-bold">{b.name}</div>
                  {b.landmark && (
                    <div className="truncate text-sm text-slate-500">{b.landmark}</div>
                  )}
                  <div className="mt-1 text-sm text-slate-400">
                    {b.vehicle_type} · {b.parked} parked
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {editing === b.id ? (
                    <input
                      autoFocus
                      defaultValue={b.capacity}
                      inputMode="numeric"
                      onBlur={(e) => updateCapacity(b.id, Number(e.target.value))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur()
                        if (e.key === 'Escape') setEditing(null)
                      }}
                      className="w-24 rounded-lg border-2 border-purple-600 px-3 py-2 text-right outline-none"
                    />
                  ) : (
                    <button
                      onClick={() => setEditing(b.id)}
                      className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium"
                    >
                      Cap: {b.capacity}
                    </button>
                  )}

                  <button
                    onClick={() => removeBlock(b.id, b.name)}
                    className="rounded-lg px-2 py-2 text-slate-300 active:text-red-600"
                    aria-label="Delete"
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {!loading && blocks.length === 0 && (
          <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-slate-500">
            No blocks yet. Create your first block above.
          </p>
        )}

        <StartFresh onDone={load} />
      </div>
    </main>
  )
}

// --- Start Fresh -------------------------------------------------------
// Wipes every entry after a day of trial runs, so the real event begins
// at zero. Blocks are kept — losing the setup mid-event would be worse
// than keeping a few practice entries.
function StartFresh({ onDone }: { onDone: () => void }) {
  const CONFIRM = 'CLEAR ALL'

  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<number | null>(null)
  const [info, setInfo] = useState<{
    vehicles: number
    last_reset: { performed_at: string; vehicles_deleted: number } | null
  } | null>(null)

  const loadInfo = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/reset')
      if (res.ok) setInfo(await res.json())
    } catch {
      // Not critical — the count is only shown to inform the decision
    }
  }, [])

  useEffect(() => {
    loadInfo()
  }, [loadInfo])

  async function run() {
    if (busy) return
    setBusy(true)
    setError('')

    try {
      const res = await fetch('/api/admin/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: typed }),
      })
      const json = await res.json()

      if (!res.ok) {
        setError(json.error ?? 'Could not clear the data')
        return
      }

      setDone(json.vehicles_deleted ?? 0)
      setOpen(false)
      setTyped('')
      await loadInfo()
      onDone()
    } catch {
      setError('Network problem — nothing was cleared')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-10 rounded-2xl border-2 border-red-200 bg-red-50 p-5">
      <h2 className="font-bold text-red-900">Start Fresh</h2>
      <p className="mt-1 text-sm text-red-800">
        Deletes every vehicle entry so the event can begin at zero. Blocks and
        their capacity are kept. Every phone clears its own offline queue the
        next time it has signal.
      </p>

      {info && (
        <p className="mt-3 text-sm text-red-900">
          <span className="font-bold">{info.vehicles}</span> entries would be
          deleted.
          {info.last_reset && (
            <>
              {' '}
              Last cleared{' '}
              {new Date(info.last_reset.performed_at).toLocaleString('en-IN')} (
              {info.last_reset.vehicles_deleted} removed).
            </>
          )}
        </p>
      )}

      {done !== null && (
        <p className="mt-3 rounded-xl bg-emerald-100 px-4 py-3 font-bold text-emerald-900">
          ✓ Cleared {done} entries. The system is fresh.
        </p>
      )}

      {!open ? (
        <button
          onClick={() => {
            setOpen(true)
            setDone(null)
            setError('')
          }}
          className="mt-4 w-full rounded-xl border-2 border-red-600 py-3 font-bold text-red-700 active:bg-red-100"
        >
          Clear All Data…
        </button>
      ) : (
        <div className="mt-4">
          <p className="text-sm font-medium text-red-900">
            This cannot be undone. Type <span className="font-mono">{CONFIRM}</span>{' '}
            to confirm.
          </p>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={CONFIRM}
            autoComplete="off"
            className="mt-2 w-full rounded-xl border-2 border-red-300 px-4 py-3 font-mono outline-none focus:border-red-600"
          />

          <div className="mt-3 flex gap-2">
            <button
              onClick={() => {
                setOpen(false)
                setTyped('')
                setError('')
              }}
              className="flex-1 rounded-xl border-2 border-slate-300 py-3 font-medium text-slate-600"
            >
              Cancel
            </button>
            <button
              onClick={run}
              disabled={busy || typed.trim().toUpperCase() !== CONFIRM}
              className="flex-1 rounded-xl bg-red-600 py-3 font-bold text-white active:bg-red-700 disabled:bg-slate-300"
            >
              {busy ? 'Clearing…' : 'CLEAR ALL DATA'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-3 rounded-xl bg-red-100 px-4 py-3 font-medium text-red-800">
          {error}
        </p>
      )}
    </div>
  )
}
