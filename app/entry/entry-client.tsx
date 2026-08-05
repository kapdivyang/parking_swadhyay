'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  enqueue,
  syncNow,
  pendingCount,
  recent,
  rejectedEntries,
  dismissRejected,
  localClash,
  clearAll,
  deviceId,
  BLOCK_KEY,
  type QueuedEntry,
} from '@/lib/queue'
import { isPlausibleReg, normalizePhone, normalizeReg } from '@/lib/reg'

type Block = {
  id: string
  name: string
  landmark: string | null
  capacity: number
  parked: number
  remaining: number
  fill_percent: number
}

type Place = { village: string; taluka: string | null }

// Vehicles arrive village by village, so the last one entered is almost
// always the next one too. Kept on the device like the block is.
const PLACE_KEY = 'parking_last_place'
// An operator stands in one spot and fills the row in front of them, so
// the landmark changes far less often than the vehicle does. Kept the
// same way, and cleared by hand when they move.
const LANDMARK_KEY = 'parking_last_landmark'
// The last "Start Fresh" this device knows about
const EPOCH_KEY = 'parking_data_epoch'

/**
 * @param fixedBlockId the block this account is tied to, from the signed
 *   session. When set there is no block to choose and no way to change it
 *   — the server would refuse a different one anyway. Null only for the
 *   Super Admin, who has no block of their own and still gets the picker.
 */
export default function EntryClient({ fixedBlockId }: { fixedBlockId: string | null }) {
  const [blocks, setBlocks] = useState<Block[]>([])
  const [blocksLoaded, setBlocksLoaded] = useState(false)
  const [blockId, setBlockId] = useState<string | null>(fixedBlockId)
  const [picking, setPicking] = useState(false)

  const [reg, setReg] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [village, setVillage] = useState('')
  const [taluka, setTaluka] = useState('')
  const [landmark, setLandmark] = useState('')
  const [places, setPlaces] = useState<Place[]>([])
  const [showOptional, setShowOptional] = useState(false)

  const [saved, setSaved] = useState<QueuedEntry[]>([])
  const [refused, setRefused] = useState<QueuedEntry[]>([])
  const [pending, setPending] = useState(0)
  const [online, setOnline] = useState(true)
  const [checking, setChecking] = useState(false)
  const [flash, setFlash] = useState<{ text: string; kind: 'ok' | 'warn' | 'stop' } | null>(null)

  const regRef = useRef<HTMLInputElement>(null)
  // The entry just saved. Its number arrives a moment later, with the
  // sync reply — and only that entry's number may overwrite the banner,
  // or a fast operator sees the previous vehicle's number appear over
  // the one they are looking at.
  const lastSave = useRef<string | null>(null)

  const block = blocks.find((b) => b.id === blockId) ?? null

  // --- Load blocks, remember chosen block ------------------------------
  const loadBlocks = useCallback(async () => {
    try {
      const res = await fetch('/api/blocks')
      if (!res.ok) return
      const json = await res.json()
      setBlocks(json.blocks ?? [])
      setBlocksLoaded(true)

      // A "Start Fresh" on the admin phone has to reach every other
      // phone too, or this device keeps refusing numbers it remembers
      // and pushes cleared entries back up on the next sync.
      const epoch: string | null = json.data_epoch ?? null
      const seen = localStorage.getItem(EPOCH_KEY)

      if (epoch && seen && epoch !== seen) {
        await clearAll()
        setSaved([])
        setRefused([])
        setPending(0)
        setFlash({ text: 'Data was cleared — starting fresh', kind: 'ok' })
      }
      // First sight of an epoch is recorded without wiping, so upgrading
      // the app never costs anyone their pending entries.
      if (epoch !== seen) {
        if (epoch) localStorage.setItem(EPOCH_KEY, epoch)
        else localStorage.removeItem(EPOCH_KEY)
      }
    } catch {
      // Offline — the saved block keeps entry working
    }
  }, [])

  useEffect(() => {
    loadBlocks()

    // With an account-assigned block there is nothing to remember and
    // nothing to ask. The device's old saved block is cleared out too, so
    // a phone handed to a different volunteer cannot carry the previous
    // one's block around in its storage.
    if (fixedBlockId) {
      setBlockId(fixedBlockId)
      localStorage.removeItem(BLOCK_KEY)
    } else {
      const saved = localStorage.getItem(BLOCK_KEY)
      if (saved) setBlockId(saved)
      else setPicking(true)
    }

    // Carry the last village/taluka over from the previous session
    const place = localStorage.getItem(PLACE_KEY)
    if (place) {
      try {
        const p = JSON.parse(place) as Place
        setVillage(p.village ?? '')
        setTaluka(p.taluka ?? '')
      } catch {
        // Corrupt value — not worth acting on, the fields just start empty
      }
    }

    setLandmark(localStorage.getItem(LANDMARK_KEY) ?? '')
  }, [loadBlocks, fixedBlockId])

  // Suggestions so a village is spelled the same on every phone
  useEffect(() => {
    fetch('/api/villages')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setPlaces(j.villages ?? []))
      .catch(() => {
        // Offline — typing still works, only the suggestions are missing
      })
  }, [])

  // Remember the block on this device so it is never asked again
  function chooseBlock(id: string) {
    setBlockId(id)
    localStorage.setItem(BLOCK_KEY, id)
    setPicking(false)
    setTimeout(() => regRef.current?.focus(), 50)
  }

  // --- Queue status ----------------------------------------------------
  const refreshQueue = useCallback(async () => {
    setPending(await pendingCount())
    setSaved(await recent(6))
    setRefused(await rejectedEntries())
  }, [])

  useEffect(() => {
    refreshQueue()
  }, [refreshQueue])

  // --- Online / offline + background sync ------------------------------
  useEffect(() => {
    setOnline(navigator.onLine)

    async function trySync() {
      const { sent, refused } = await syncNow()
      if (sent > 0 || refused > 0) {
        await refreshQueue()
        loadBlocks()
      }
    }

    function goOnline() {
      setOnline(true)
      trySync()
    }
    function goOffline() {
      setOnline(false)
    }

    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)

    // Retry every 10s so queued entries go out as soon as network returns
    const timer = setInterval(trySync, 10_000)
    trySync()

    // Poll the block list on its own clock. A phone with nothing to sync
    // would otherwise never call it — and that is exactly the phone that
    // needs to hear about a "Start Fresh". Keeps the capacity bar honest too.
    const poll = setInterval(loadBlocks, 30_000)

    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
      clearInterval(timer)
      clearInterval(poll)
    }
  }, [refreshQueue, loadBlocks])

  // --- Save ------------------------------------------------------------
  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!block) {
      setPicking(true)
      return
    }
    if (!isPlausibleReg(reg)) {
      setFlash({ text: 'Number looks incomplete', kind: 'warn' })
      return
    }

    const norm = normalizeReg(reg)
    const normPhone = normalizePhone(phone)

    // 1. This device's own queue — instant, and works with no network.
    //    The message names the field that actually clashed: the operator
    //    has to tell the visitor either "this car is already parked" or
    //    "this mobile is already on another car", never a vague "duplicate".
    const mine = await localClash(norm, normPhone)
    if (mine) {
      setFlash({
        text:
          mine.field === 'reg_no'
            ? `Vehicle number ${normalizeReg(mine.reg_no)} is already entered — Block ${mine.block_name}`
            : `Mobile number ${normPhone} is already used for ${normalizeReg(mine.reg_no)}`,
        kind: 'stop',
      })
      return
    }

    // 2. The other phones. The database is what actually enforces this, but
    //    asking now means the operator finds out before the car is waved
    //    through. Offline, the entry queues and the server refuses it later.
    if (navigator.onLine) {
      setChecking(true)
      try {
        const params = new URLSearchParams({ reg: norm })
        if (normPhone) params.set('phone', normPhone)
        const res = await fetch(`/api/vehicles/check?${params}`)
        if (res.ok) {
          const json = await res.json()
          if (json.ok === false) {
            setFlash({ text: json.reason, kind: 'stop' })
            return
          }
        }
      } catch {
        // Network went in the middle of the check — queue it and let the
        // server have the final say
      } finally {
        setChecking(false)
      }
    }

    const vill = village.trim()
    const tal = taluka.trim()
    const mark = landmark.trim()

    const queued = await enqueue({
      reg_no: reg,
      block_id: block.id,
      block_name: block.name,
      owner_name: name.trim() || null,
      owner_phone: phone.trim() || null,
      village: vill || null,
      taluka: tal || null,
      landmark: mark || null,
      device_id: deviceId(),
      entered_at: new Date().toISOString(),
    })

    if (vill || tal) {
      localStorage.setItem(PLACE_KEY, JSON.stringify({ village: vill, taluka: tal }))
    }
    if (mark) localStorage.setItem(LANDMARK_KEY, mark)

    lastSave.current = queued.client_uuid
    setFlash({ text: `${norm} saved`, kind: 'ok' })
    setReg('')
    setName('')
    setPhone('')
    // Village and taluka deliberately stay — a queue of vehicles from one
    // village would otherwise mean retyping it for every single entry.
    setShowOptional(false)
    regRef.current?.focus()

    await refreshQueue()
    syncNow().then(async ({ sent, refused }) => {
      if (sent === 0 && refused === 0) return
      await refreshQueue()
      loadBlocks()

      // The number only exists once the server has the entry. When it
      // comes back within a second or two — the usual case — say it, so
      // the operator can read it out while the car is still there.
      if (lastSave.current !== queued.client_uuid) return
      const mine = (await recent(6)).find((e) => e.client_uuid === queued.client_uuid)
      if (mine?.entry_no != null && lastSave.current === queued.client_uuid) {
        setFlash({ text: `${norm} saved — Entry #${mine.entry_no}`, kind: 'ok' })
      }
    })
  }

  async function dismiss(clientUuid: string) {
    await dismissRejected(clientUuid)
    await refreshQueue()
  }

  useEffect(() => {
    if (!flash) return
    // A refused entry needs longer on screen than a confirmation does
    const t = setTimeout(() => setFlash(null), flash.kind === 'stop' ? 6000 : 2500)
    return () => clearTimeout(t)
  }, [flash])

  // --- An account-assigned block ---------------------------------------
  // Never the picker: this account has exactly one block and no say in it.
  // Until the block list arrives it is simply not known yet, and if the
  // block has since been deleted that is a job for the Super Admin, not
  // something the volunteer can fix by choosing another.
  if (fixedBlockId && !block) {
    return (
      <main className="mx-auto max-w-lg p-5">
        <h1 className="mb-4 text-2xl font-bold">Vehicle Entry</h1>
        {!blocksLoaded ? (
          <p className="text-slate-500">Loading your block…</p>
        ) : (
          <p className="rounded-xl bg-amber-50 px-4 py-4 text-amber-800">
            The block assigned to your account is not available any more. Ask the Super Admin
            to set your block again.
          </p>
        )}
        <Link href="/" className="mt-6 block text-center text-slate-500">
          ← Back to Home
        </Link>
      </main>
    )
  }

  // --- Block picker (Super Admin only) ---------------------------------
  if (picking || !block) {
    return (
      <main className="mx-auto max-w-lg p-5">
        <div className="mb-5 flex items-center justify-between">
          <h1 className="text-2xl font-bold">Select Your Block</h1>
          <Link
            href="/"
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600"
          >
            ← Home
          </Link>
        </div>

        <p className="mb-6 text-slate-500">
          Chosen once — it will be remembered, so you will not be asked again for every entry.
        </p>

        <div className="space-y-3">
          {blocks.map((b) => (
            <button
              key={b.id}
              onClick={() => chooseBlock(b.id)}
              className="w-full rounded-2xl border-2 border-slate-300 bg-white px-5 py-5 text-left active:bg-slate-50"
            >
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-bold">{b.name}</span>
                <span className="text-sm text-slate-500">
                  {b.parked}/{b.capacity}
                </span>
              </div>
              {b.landmark && <div className="mt-1 text-slate-500">{b.landmark}</div>}
            </button>
          ))}
        </div>

        {blocks.length === 0 && (
          <p className="rounded-xl bg-amber-50 px-4 py-4 text-amber-800">
            No blocks created yet. Ask the Super Admin to add blocks.
          </p>
        )}
      </main>
    )
  }

  // --- Entry form ------------------------------------------------------
  const fill = block.capacity > 0 ? Math.min((block.parked / block.capacity) * 100, 100) : 0
  const isFull = block.remaining <= 0

  return (
    <main className="mx-auto max-w-lg pb-24">
      {/* Sticky banner — the block must always be visible while entering */}
      <div className="sticky top-0 z-10 bg-slate-900 px-5 py-4 text-white">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="rounded-lg border border-white/30 px-3 py-2 text-sm"
              aria-label="Home"
            >
              ←
            </Link>
            <div>
              <div className="text-xs uppercase tracking-wider text-white/60">Block</div>
              <div className="text-3xl font-bold leading-tight">{block.name}</div>
            </div>
          </div>
          {/* No "Change" for an account-assigned block. Offering it would
              be a lie — the server decides the block now, and a different
              choice would simply be overruled on save. */}
          {!fixedBlockId && (
            <button
              onClick={() => setPicking(true)}
              className="rounded-lg border border-white/30 px-3 py-2 text-sm"
            >
              Change
            </button>
          )}
        </div>

        <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/20">
          <div
            className={`h-full ${isFull ? 'bg-red-500' : fill > 85 ? 'bg-amber-400' : 'bg-emerald-400'}`}
            style={{ width: `${fill}%` }}
          />
        </div>
        <div className="mt-2 flex justify-between text-sm text-white/80">
          <span>Entered: {block.parked}</span>
          <span className={isFull ? 'font-bold text-red-300' : ''}>
            {isFull ? 'FULL' : `Left: ${block.remaining}`}
          </span>
        </div>
      </div>

      <div className="px-5">
        <div className="mt-3 flex items-center gap-3 text-sm">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-medium ${
              online ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${online ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            {online ? 'Online' : 'Offline — entries still work'}
          </span>
          {pending > 0 && <span className="text-slate-500">{pending} pending sync</span>}
        </div>

        <form onSubmit={save} className="mt-4">
          <input
            ref={regRef}
            autoFocus
            value={reg}
            onChange={(e) => setReg(e.target.value.toUpperCase())}
            placeholder="GJ06KA1234"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="w-full rounded-2xl border-2 border-slate-300 bg-white px-5 py-6 text-center font-mono text-3xl font-bold tracking-wider outline-none focus:border-blue-600"
          />

          {/* Village and taluka stay filled between entries, so a whole
              village can be entered without retyping it every time. */}
          <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-slate-500">
                Village / Taluka (optional)
              </span>
              {(village || taluka) && (
                <button
                  type="button"
                  onClick={() => {
                    setVillage('')
                    setTaluka('')
                    localStorage.removeItem(PLACE_KEY)
                  }}
                  className="text-sm text-blue-600"
                >
                  Clear
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <input
                value={village}
                onChange={(e) => {
                  const v = e.target.value
                  setVillage(v)
                  // Fill the taluka in while the village is still being
                  // typed — never on blur. Filling it as the operator moves
                  // into the field would put text under their finger, and
                  // the next keystroke would land on the end of it.
                  if (taluka.trim()) return
                  const hit = places.find(
                    (p) => p.village.toLowerCase() === v.trim().toLowerCase(),
                  )
                  if (hit?.taluka) setTaluka(hit.taluka)
                }}
                list="village-list"
                placeholder="Village"
                autoComplete="off"
                className="w-full rounded-lg border-2 border-slate-300 px-3 py-3 text-lg outline-none focus:border-blue-600"
              />
              <input
                value={taluka}
                onChange={(e) => setTaluka(e.target.value)}
                list="taluka-list"
                placeholder="Taluka"
                autoComplete="off"
                className="w-full rounded-lg border-2 border-slate-300 px-3 py-3 text-lg outline-none focus:border-blue-600"
              />
            </div>

            <datalist id="village-list">
              {places.map((p) => (
                <option key={`${p.village}|${p.taluka ?? ''}`} value={p.village} />
              ))}
            </datalist>
            <datalist id="taluka-list">
              {[...new Set(places.map((p) => p.taluka).filter(Boolean))].map((t) => (
                <option key={t as string} value={t as string} />
              ))}
            </datalist>

            {village && (
              <p className="mt-2 text-sm text-slate-500">
                Kept for the next entry as well
              </p>
            )}

            {/* Where inside the block this car is standing. The block name
                says which field to walk to; this says where in it to look,
                and a full block is otherwise a lot of ground to cover.
                Sticky like the village, because an operator fills one row
                before moving to the next. */}
            <div className="mt-3 border-t border-slate-200 pt-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-500">Landmark (optional)</span>
                {landmark && (
                  <button
                    type="button"
                    onClick={() => {
                      setLandmark('')
                      localStorage.removeItem(LANDMARK_KEY)
                    }}
                    className="text-sm text-blue-600"
                  >
                    Clear
                  </button>
                )}
              </div>
              <input
                value={landmark}
                onChange={(e) => setLandmark(e.target.value)}
                placeholder="e.g. near light tower 4"
                autoComplete="off"
                className="w-full rounded-lg border-2 border-slate-300 px-3 py-3 text-lg outline-none focus:border-blue-600"
              />
              {landmark && (
                <p className="mt-2 text-sm text-slate-500">
                  Kept until you change it — update it when you move to a new row
                </p>
              )}
            </div>
          </div>

          {!showOptional ? (
            <button
              type="button"
              onClick={() => setShowOptional(true)}
              className="mt-3 w-full rounded-xl border border-dashed border-slate-300 py-3 text-slate-500"
            >
              + Name / Phone (optional)
            </button>
          ) : (
            <div className="mt-3 space-y-3">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name (optional)"
                autoComplete="off"
                className="w-full rounded-xl border-2 border-slate-300 bg-white px-4 py-4 text-lg outline-none focus:border-blue-600"
              />
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Mobile (optional)"
                inputMode="numeric"
                autoComplete="off"
                className="w-full rounded-xl border-2 border-slate-300 bg-white px-4 py-4 text-lg outline-none focus:border-blue-600"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={checking}
            className="mt-4 w-full rounded-2xl bg-blue-600 py-6 text-2xl font-bold text-white active:bg-blue-700 disabled:bg-slate-400"
          >
            {checking ? 'CHECKING…' : 'SAVE'}
          </button>
        </form>

        {flash && (
          <div
            className={`mt-4 rounded-xl px-4 py-3 text-center font-bold ${
              flash.kind === 'ok'
                ? 'bg-emerald-100 text-emerald-800'
                : flash.kind === 'stop'
                  ? 'bg-red-100 text-red-800'
                  : 'bg-amber-100 text-amber-800'
            }`}
          >
            {flash.kind === 'ok' ? '✓ ' : flash.kind === 'stop' ? '✕ ' : '⚠ '}
            {flash.text}
          </div>
        )}

        {/* Entries the server refused after they were already queued —
            offline duplicates, mostly. They are not retried, so they have
            to be visible or they would just disappear. */}
        {refused.length > 0 && (
          <div className="mt-6 rounded-xl border-2 border-red-200 bg-red-50 p-4">
            <div className="mb-2 font-bold text-red-800">
              {refused.length} entry not saved
            </div>
            <div className="space-y-2">
              {refused.map((r) => (
                <div key={r.client_uuid} className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-mono font-bold">{r.reg_no}</div>
                    <div className="text-sm text-red-700">{r.rejected}</div>
                  </div>
                  <button
                    onClick={() => dismiss(r.client_uuid)}
                    className="shrink-0 rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-700"
                  >
                    OK
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {saved.length > 0 && (
          <div className="mt-6">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-sm font-medium text-slate-500">Recently entered</span>
              <Link href="/entries" className="text-sm font-medium text-blue-600">
                All entries →
              </Link>
            </div>
            <div className="space-y-1.5">
              {saved.map((s) => (
                <div
                  key={s.client_uuid}
                  className="flex items-center justify-between rounded-lg bg-white px-4 py-2.5"
                >
                  <div className="flex items-center gap-3">
                    {/* The number is handed out by the server, so an entry
                        made offline shows a dash until it syncs. Showing a
                        guessed number and correcting it later would be
                        worse than showing none. */}
                    <span
                      className={`min-w-10 rounded-md px-2 py-0.5 text-center font-mono text-sm font-bold ${
                        s.entry_no != null
                          ? 'bg-blue-100 text-blue-800'
                          : 'bg-slate-100 text-slate-400'
                      }`}
                    >
                      {s.entry_no != null ? `#${s.entry_no}` : '#–'}
                    </span>
                    <span className="font-mono font-bold">{s.reg_no}</span>
                  </div>
                  <span className="text-sm text-slate-400">
                    {s.synced ? '✓' : '⏳'} {s.block_name}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-8 flex items-center justify-center gap-6">
          <Link href="/entries" className="text-slate-500">
            All entries
          </Link>
          <Link href="/" className="text-slate-500">
            ← Back to Home
          </Link>
        </div>
      </div>
    </main>
  )
}
