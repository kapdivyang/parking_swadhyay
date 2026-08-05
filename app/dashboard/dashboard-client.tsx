'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

export type BlockStatus = {
  id: string
  name: string
  landmark: string | null
  capacity: number
  vehicle_type: string
  parked: number
  remaining: number
  fill_percent: number
}

export default function DashboardClient() {
  const [blocks, setBlocks] = useState<BlockStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/blocks')
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Could not load')
      } else {
        setBlocks(json.blocks ?? [])
        setError('')
      }
    } catch {
      setError('Network problem')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 15_000) // refresh every 15s
    return () => clearInterval(t)
  }, [load])

  const totalCapacity = blocks.reduce((s, b) => s + b.capacity, 0)
  const totalParked = blocks.reduce((s, b) => s + b.parked, 0)
  const totalLeft = totalCapacity - totalParked

  // Emptiest block — tells guides where to send the next vehicles
  const suggested = [...blocks]
    .filter((b) => b.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining)[0]

  return (
    <main className="mx-auto max-w-3xl pb-24">
      <div className="bg-slate-900 px-5 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="rounded-lg border border-white/30 px-3 py-1.5 text-sm text-white"
              aria-label="Home"
            >
              ←
            </Link>
            <h1 className="text-xl font-bold text-white">Dashboard</h1>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/tv" className="text-sm text-white/70">
              TV Mode
            </Link>
            <Link href="/" className="text-sm text-white/70">
              Home
            </Link>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-3 text-center">
          <Stat label="Total" value={totalCapacity} />
          <Stat label="Parked" value={totalParked} tone="text-emerald-400" />
          <Stat
            label="Left"
            value={totalLeft}
            tone={totalLeft < 100 ? 'text-red-400' : 'text-white'}
          />
        </div>
      </div>

      <div className="px-5 pt-4">
        {suggested && (
          <div className="mb-4 rounded-xl bg-blue-50 px-4 py-3">
            <span className="text-sm text-blue-900">
              Most space available: <strong className="text-lg">{suggested.name}</strong> (
              {suggested.remaining} left)
            </span>
          </div>
        )}

        {error && (
          <p className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-center text-red-700">{error}</p>
        )}

        {loading && <p className="py-10 text-center text-slate-400">Loading…</p>}

        {!loading && blocks.length === 0 && !error && (
          <div className="py-10 text-center">
            <p className="text-lg font-bold text-slate-700">No blocks created yet</p>
            <Link href="/admin/blocks" className="mt-2 inline-block text-blue-600">
              Create blocks →
            </Link>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {blocks.map((b) => (
            <BlockCard key={b.id} b={b} />
          ))}
        </div>
      </div>
    </main>
  )
}

function Stat({
  label,
  value,
  tone = 'text-white',
}: {
  label: string
  value: number
  tone?: string
}) {
  return (
    <div className="rounded-xl bg-white/10 py-3">
      <div className={`text-2xl font-bold ${tone}`}>{value.toLocaleString('en-IN')}</div>
      <div className="text-xs uppercase tracking-wider text-white/50">{label}</div>
    </div>
  )
}

export function BlockCard({ b }: { b: BlockStatus }) {
  const pct = Math.min(b.fill_percent, 100)

  // Colour alone should tell the story — no need to read the numbers
  const tone =
    b.remaining <= 0
      ? { bar: 'bg-red-500', chip: 'bg-red-100 text-red-800', label: 'FULL' }
      : pct >= 85
        ? { bar: 'bg-orange-500', chip: 'bg-orange-100 text-orange-800', label: 'Almost full' }
        : pct >= 60
          ? { bar: 'bg-amber-400', chip: 'bg-amber-100 text-amber-800', label: 'Filling up' }
          : { bar: 'bg-emerald-500', chip: 'bg-emerald-100 text-emerald-800', label: 'Space available' }

  return (
    <div className="rounded-2xl bg-white p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-3xl font-bold leading-none">{b.name}</div>
          {b.landmark && <div className="mt-1.5 text-sm text-slate-500">{b.landmark}</div>}
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-bold ${tone.chip}`}>{tone.label}</span>
      </div>

      <div className="mt-4 h-4 overflow-hidden rounded-full bg-slate-200">
        <div className={`h-full ${tone.bar} transition-all`} style={{ width: `${pct}%` }} />
      </div>

      <div className="mt-2 flex items-baseline justify-between">
        <span className="text-lg font-bold">
          {b.parked}
          <span className="text-slate-400">/{b.capacity}</span>
        </span>
        <span className="text-sm text-slate-500">
          {b.remaining > 0 ? `${b.remaining} left` : 'No space'} · {pct}%
        </span>
      </div>
    </div>
  )
}
