'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import type { BlockStatus } from '../dashboard/dashboard-client'

// For the big control-room screen. Must be readable from a distance,
// hence the dark background and very large numbers.

export default function TvClient() {
  const [blocks, setBlocks] = useState<BlockStatus[]>([])
  const [updated, setUpdated] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/blocks')
      if (!res.ok) return
      const json = await res.json()
      setBlocks(json.blocks ?? [])
      setUpdated(new Date().toLocaleTimeString('en-IN', { hour12: false }))
    } catch {
      // Stay quiet — the next poll will retry
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [load])

  const total = blocks.reduce((s, b) => s + b.capacity, 0)
  const parked = blocks.reduce((s, b) => s + b.parked, 0)

  return (
    <main className="min-h-dvh bg-slate-950 p-6 text-white">
      <div className="mb-6 flex items-baseline justify-between">
        <div className="flex items-center gap-4">
          <Link
            href="/dashboard"
            className="rounded-lg border border-white/30 px-3 py-1.5 text-base text-white/80"
          >
            ← Back
          </Link>
          <h1 className="text-3xl font-bold">Parking Status</h1>
        </div>
        <div className="text-right">
          <div className="text-4xl font-bold">
            {parked.toLocaleString('en-IN')}
            <span className="text-2xl text-slate-500"> / {total.toLocaleString('en-IN')}</span>
          </div>
          <div className="text-sm text-slate-500">Updated {updated}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
        {blocks.map((b) => {
          const pct = Math.min(b.fill_percent, 100)
          const color =
            b.remaining <= 0
              ? 'bg-red-600'
              : pct >= 85
                ? 'bg-orange-500'
                : pct >= 60
                  ? 'bg-amber-500'
                  : 'bg-emerald-600'

          return (
            <div key={b.id} className="overflow-hidden rounded-2xl bg-slate-900">
              <div className={`${color} px-4 py-3`}>
                <div className="text-4xl font-bold leading-none">{b.name}</div>
              </div>
              <div className="px-4 py-4">
                <div className="text-3xl font-bold">
                  {b.parked}
                  <span className="text-xl text-slate-500">/{b.capacity}</span>
                </div>
                <div className="mt-2 h-3 overflow-hidden rounded-full bg-slate-800">
                  <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-2 text-lg text-slate-400">
                  {b.remaining > 0 ? `${b.remaining} left` : 'FULL'}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </main>
  )
}
