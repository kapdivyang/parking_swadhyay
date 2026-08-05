'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  loadSnapshot,
  syncSnapshot,
  searchSnapshot,
  snapshotSize,
  lastSyncedAt,
  isSearchable,
} from '@/lib/snapshot'

type Result = {
  id: string
  entry_no: number | null
  reg_no_display: string
  owner_name: string | null
  owner_phone: string | null
  village: string | null
  taluka: string | null
  landmark: string | null
  entered_at: string
  status: string
  block_name: string
  block_landmark: string | null
  match_rank: number
}

type Place = { village: string; taluka: string | null }

const RESULT_CAP_HINT = 200
// Past this age the phone's copy is old enough that the operator should
// know about it before they tell somebody their car is not here.
const STALE_MS = 2 * 60 * 1000
// How often the phone asks for what changed. Only the difference comes
// back, so this is a few kilobytes, not the whole table.
const SYNC_EVERY_MS = 60_000
const RESULT_CAP = RESULT_CAP_HINT
// Above this many results, one line each reads better than a stack of cards
const COMPACT_ABOVE = 8

export default function SearchClient() {
  const [q, setQ] = useState('')
  const [village, setVillage] = useState('')
  const [taluka, setTaluka] = useState('')
  const [byPlace, setByPlace] = useState(false)

  const [places, setPlaces] = useState<Place[]>([])
  const [results, setResults] = useState<Result[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState('')

  // The phone's own copy of the table
  const [cached, setCached] = useState(0)
  const [syncedAt, setSyncedAt] = useState<number | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [firstSync, setFirstSync] = useState(false)
  const [online, setOnline] = useState(true)
  const [servedLocally, setServedLocally] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const inputRef = useRef<HTMLInputElement>(null)
  const seq = useRef(0)

  // Village names already in use, to search by the same spelling they
  // were entered with
  useEffect(() => {
    fetch('/api/villages')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setPlaces(j.villages ?? []))
      .catch(() => {
        // Offline — typing the name still works
      })
  }, [])

  // --- Keep the phone's copy current -----------------------------------
  const sync = useCallback(async () => {
    setSyncing(true)
    const { added, removed } = await syncSnapshot()
    setCached(snapshotSize())
    setSyncedAt(await lastSyncedAt())
    setSyncing(false)
    setFirstSync(false)
    // A vehicle that just arrived can turn a "not found" into a find, so
    // the query on screen is re-run rather than left showing the old answer
    if (added > 0 || removed > 0) seq.current++
  }, [])

  useEffect(() => {
    setOnline(navigator.onLine)

    let alive = true
    ;(async () => {
      const n = await loadSnapshot()
      if (!alive) return
      setCached(n)
      setSyncedAt(await lastSyncedAt())
      // The first pull is the whole table. Saying so matters — on a slow
      // link it is the difference between "still loading" and "broken".
      if (n === 0) setFirstSync(true)
      sync()
    })()

    const timer = setInterval(sync, SYNC_EVERY_MS)
    const goOnline = () => {
      setOnline(true)
      sync()
    }
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)

    // Only drives the "updated N ago" label
    const tick = setInterval(() => setNow(Date.now()), 10_000)

    return () => {
      alive = false
      clearInterval(timer)
      clearInterval(tick)
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [sync])

  // --- Ask the server directly -----------------------------------------
  // Used when the phone's copy has nothing, and by the button under a
  // "no vehicle found" — the one case where the missing 60 seconds
  // between polls actually matters.
  const askServer = useCallback(
    async (term: string, vill: string, tal: string, id: number) => {
      try {
        const params = new URLSearchParams()
        if (term) params.set('q', term)
        if (vill) params.set('village', vill)
        if (tal) params.set('taluka', tal)

        const res = await fetch(`/api/search?${params}`)
        const json = await res.json()
        if (id !== seq.current) return // a newer query has since been typed

        if (!res.ok) {
          setError(json.error ?? 'Search failed')
        } else {
          setResults(json.results ?? [])
          setServedLocally(false)
          setError('')
        }
        setSearched(true)
      } catch {
        if (id !== seq.current) return
        setError(
          navigator.onLine
            ? 'Could not reach the server — showing what this phone has'
            : 'No network. Showing what this phone has already downloaded.',
        )
      } finally {
        if (id === seq.current) setSearching(false)
      }
    },
    [],
  )

  // --- Search as you type ----------------------------------------------
  // The phone's own copy answers first: it is instant, it costs no data,
  // and at exit time — when every network in the area is saturated — it is
  // the only thing that answers at all.
  useEffect(() => {
    const term = q.trim()
    const vill = village.trim()
    const tal = taluka.trim()

    if (!isSearchable(term, vill, tal)) {
      setResults([])
      setSearched(false)
      setServedLocally(false)
      setError('')
      return
    }

    const id = ++seq.current
    setSearching(true)

    const timer = setTimeout(async () => {
      if (cached > 0) {
        const local = searchSnapshot(term, vill, tal)
        if (id !== seq.current) return

        setResults(local)
        setServedLocally(true)
        setSearched(true)
        setError('')
        setSearching(false)

        // Nothing here, but there might be on the server — a vehicle
        // entered in the last minute is exactly the one that would be
        // missing, and "not found" is the answer nobody wants to be wrong.
        if (local.length === 0 && navigator.onLine) {
          setSearching(true)
          await askServer(term, vill, tal, id)
        }
        return
      }

      // No local copy yet — the first sync is probably still running
      await askServer(term, vill, tal, id)
    }, 250)

    return () => clearTimeout(timer)
  }, [q, village, taluka, cached, askServer])

  // A village search answers "which blocks?" long before anyone reads
  // through forty cards, so the blocks are summarised at the top.
  const blockCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of results) counts.set(r.block_name, (counts.get(r.block_name) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [results])

  function clear() {
    setQ('')
    setVillage('')
    setTaluka('')
    setResults([])
    setSearched(false)
    setError('')
    inputRef.current?.focus()
  }

  const anyFilter = q || village || taluka
  const placeOnly = !q.trim() && (village.trim() !== '' || taluka.trim() !== '')

  const age = syncedAt == null ? null : now - syncedAt
  const stale = !online || (age != null && age > STALE_MS)
  const freshness =
    age == null
      ? 'not updated yet'
      : !online
        ? 'offline — not updating'
        : age < 60_000
          ? 'updated just now'
          : `updated ${Math.round(age / 60_000)} min ago`

  return (
    <main className="mx-auto max-w-lg pb-24">
      <div className="sticky top-0 z-10 bg-emerald-700 px-5 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="rounded-lg border border-white/30 px-3 py-1.5 text-sm text-white"
              aria-label="Home"
            >
              ←
            </Link>
            <h1 className="text-xl font-bold text-white">Vehicle Search</h1>
          </div>
          <Link href="/" className="text-sm text-white/70">
            Home
          </Link>
        </div>

        <div className="relative mt-3">
          <input
            ref={inputRef}
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Number / Phone / Name / #Entry"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="w-full rounded-2xl bg-white px-5 py-5 pr-14 text-center font-mono text-2xl font-bold outline-none"
          />
          {anyFilter && (
            <button
              onClick={clear}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-2xl text-slate-400"
              aria-label="Clear"
            >
              ✕
            </button>
          )}
        </div>

        {/* The number is unknown often enough that village and taluka are a
            search of their own, not just a filter on top of one. */}
        {!byPlace && !village && !taluka ? (
          <button
            onClick={() => setByPlace(true)}
            className="mt-3 w-full rounded-xl border border-dashed border-white/40 py-3 text-sm text-white/90"
          >
            + Search by Village / Taluka
          </button>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <input
              value={village}
              onChange={(e) => setVillage(e.target.value)}
              list="search-village-list"
              placeholder="Village"
              autoComplete="off"
              className="w-full rounded-xl bg-white px-4 py-3 text-lg outline-none"
            />
            <input
              value={taluka}
              onChange={(e) => setTaluka(e.target.value)}
              list="search-taluka-list"
              placeholder="Taluka"
              autoComplete="off"
              className="w-full rounded-xl bg-white px-4 py-3 text-lg outline-none"
            />
            <datalist id="search-village-list">
              {places.map((p) => (
                <option key={`${p.village}|${p.taluka ?? ''}`} value={p.village} />
              ))}
            </datalist>
            <datalist id="search-taluka-list">
              {[...new Set(places.map((p) => p.taluka).filter(Boolean))].map((t) => (
                <option key={t as string} value={t as string} />
              ))}
            </datalist>
          </div>
        )}

        <p className="mt-2 text-center text-sm text-white/70">
          {placeOnly
            ? 'Fill in more fields to narrow the list down'
            : 'No full number? Type the last 4 digits — or the entry number as #7'}
        </p>

        {/* How fresh this phone's copy is. An operator about to tell
            somebody their car is not here needs to know whether they are
            reading a minute-old answer or an hour-old one. */}
        <div className="mt-2 flex items-center justify-center gap-2 text-xs">
          {firstSync ? (
            <span className="rounded-full bg-white/20 px-3 py-1 text-white">
              Downloading vehicles for offline use…
            </span>
          ) : cached === 0 ? (
            <span className="rounded-full bg-amber-400/90 px-3 py-1 font-medium text-amber-950">
              {online ? 'Searching the server directly' : 'No offline copy on this phone yet'}
            </span>
          ) : (
            <span
              className={`rounded-full px-3 py-1 font-medium ${
                stale ? 'bg-amber-400/90 text-amber-950' : 'bg-white/20 text-white'
              }`}
            >
              {cached.toLocaleString('en-IN')} vehicles on this phone
              {syncing ? ' · updating…' : ` · ${freshness}`}
            </span>
          )}
        </div>
      </div>

      <div className="px-5 pt-4">
        {searching && <p className="py-8 text-center text-slate-400">Searching…</p>}

        {error && (
          <p className="rounded-xl bg-red-50 px-4 py-4 text-center font-medium text-red-700">
            {error}
          </p>
        )}

        {!searching && searched && results.length === 0 && !error && (
          <div className="py-10 text-center">
            <p className="text-xl font-bold text-slate-700">No vehicle found</p>
            <p className="mt-2 text-slate-500">
              Try a slightly different spelling, or drop one of the fields
            </p>
            {/* The server was already asked automatically when this came
                back empty. Offline it could not be, and that is worth
                saying out loud rather than leaving "not found" to stand. */}
            {!online && cached > 0 && (
              <p className="mx-auto mt-4 max-w-xs rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
                This phone is offline. A vehicle entered after{' '}
                {syncedAt ? new Date(syncedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : 'the last update'}{' '}
                would not be in its copy yet.
              </p>
            )}
          </div>
        )}

        {/* Where the answer came from. Only shown once there is something
            to be wrong about. */}
        {!searching && searched && results.length > 0 && servedLocally && (
          <p className="mb-3 text-center text-xs text-slate-400">
            Answered from this phone&rsquo;s offline copy
          </p>
        )}

        {!searching && results.length > 1 && (
          <>
            <p className="mb-2 text-sm text-slate-500">
              {results.length === RESULT_CAP
                ? `First ${RESULT_CAP} vehicles — add the taluka to narrow it down`
                : `${results.length} vehicles found`}
            </p>

            {/* Which blocks they are in — the answer to a village search */}
            {blockCounts.length > 1 && (
              <div className="mb-4 flex flex-wrap gap-2">
                {blockCounts.map(([name, count]) => (
                  <span
                    key={name}
                    className="rounded-full bg-emerald-600 px-3 py-1.5 text-sm font-bold text-white"
                  >
                    {name} · {count}
                  </span>
                ))}
              </div>
            )}
          </>
        )}

        {/* A whole village can be a hundred vehicles. Full cards are right
            when the operator has found the car; past a handful they are just
            a long scroll, so the list turns into one line each. */}
        {results.length > COMPACT_ABOVE ? (
          <div className="divide-y divide-slate-200 overflow-hidden rounded-2xl bg-white">
            {results.map((r) => (
              <CompactRow key={r.id} r={r} />
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {results.map((r) => (
              <ResultCard key={r.id} r={r} single={results.length === 1} />
            ))}
          </div>
        )}
      </div>
    </main>
  )
}

// One line per vehicle, with the block still the boldest thing on it
function CompactRow({ r }: { r: Result }) {
  const place = [r.village, r.taluka].filter(Boolean).join(', ')

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          {r.entry_no != null && (
            <span className="font-mono text-xs font-bold text-slate-400">#{r.entry_no}</span>
          )}
          <span className="font-mono font-bold">{r.reg_no_display}</span>
        </div>
        {(place || r.owner_name || r.landmark) && (
          <div className="truncate text-sm text-slate-500">
            {r.landmark ?? r.owner_name ?? place}
          </div>
        )}
      </div>
      <div className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-lg font-bold text-white">
        {r.block_name}
      </div>
    </div>
  )
}

function ResultCard({ r, single }: { r: Result; single: boolean }) {
  const time = new Date(r.entered_at).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })

  const place = [r.village, r.taluka].filter(Boolean).join(', ')

  return (
    <div className="overflow-hidden rounded-2xl bg-white">
      <div className="flex items-baseline justify-between gap-3 px-5 pt-4">
        <div className="font-mono text-xl font-bold tracking-wide">{r.reg_no_display}</div>
        {place && <div className="text-sm text-slate-500">{place}</div>}
      </div>

      {/* Block name is the largest thing — must be readable at a glance */}
      <div className="bg-emerald-600 px-5 py-5 text-white">
        <div className="flex items-baseline justify-between">
          <div className="text-xs uppercase tracking-widest text-white/70">Block</div>
          {r.entry_no != null && (
            <div className="rounded-md bg-white/20 px-2 py-0.5 font-mono text-sm font-bold">
              Entry #{r.entry_no}
            </div>
          )}
        </div>
        <div className={`font-bold leading-none ${single ? 'text-6xl' : 'text-4xl'}`}>
          {r.block_name}
        </div>
        {r.block_landmark && <div className="mt-2 text-white/90">{r.block_landmark}</div>}

        {/* Where in the block the car actually is. The block tells the
            visitor which field to walk to; this is the line that stops
            them wandering it end to end. */}
        {r.landmark && (
          <div className="mt-3 rounded-lg bg-white/15 px-3 py-2">
            <span className="text-xs uppercase tracking-wider text-white/70">Landmark</span>
            <div className="text-lg font-bold leading-tight">{r.landmark}</div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-1 px-5 py-3 text-sm text-slate-500">
        <span>Entry: {time}</span>
        {r.owner_name && <span>Name: {r.owner_name}</span>}
        {r.owner_phone && (
          <a href={`tel:${r.owner_phone}`} className="font-medium text-blue-600">
            📞 {r.owner_phone}
          </a>
        )}
      </div>
    </div>
  )
}
