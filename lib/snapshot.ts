'use client'

import { openDB, type IDBPDatabase } from 'idb'
// Relative, not the @ alias — this file's matching rules are compiled and
// run outside Next by scripts/parity-search.mjs, which checks them against
// the database's own search. That test cannot resolve the alias.
import { normalizeReg } from './reg'

// The offline search snapshot.
//
// The whole vehicle table, cached on the phone, so a search costs nothing
// and works with no signal. Pulled once, then kept current with deltas.
//
// The matching below deliberately mirrors `search_vehicles` in
// `supabase/schema.sql`, rank for rank. If the two drift apart, the same
// query starts giving different answers depending on whether the phone
// happened to be online — which is worse than being slow.

export type SnapRow = {
  k: string // `${block_id}|${entry_no}` — the IndexedDB key
  b: string // block name, for display
  bl: string | null // block landmark
  n: number | null // entry number
  reg: string // as entered, for display
  regn: string // normalized, for matching. Stored, not recomputed per keystroke
  name: string | null
  phone: string | null
  vill: string | null
  tal: string | null
  lm: string | null
  t: number // entered_at, epoch ms
  x: number // 1 once exit marking exists and this vehicle has left
}

// What the search screen renders. Identical in shape to a server result,
// so the same components draw both.
export type SnapResult = {
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

const DB_NAME = 'parking-snapshot'
const ROWS = 'rows'
const META = 'meta'

const CURSOR_KEY = 'cursor'
// Deletions have their own high-water mark. Sharing the rows cursor means
// that on a quiet stretch, when nothing is being entered and changed_at
// stops moving, every past deletion is resent on every poll.
const DELETED_CURSOR_KEY = 'deleted_cursor'
const EPOCH_KEY = 'epoch'
const SYNCED_KEY = 'synced_at'

// Kept in step with search_vehicles and the two API routes
const MIN_Q = 3
const MIN_PHONE = 4
const MIN_PLACE = 2
const LIMIT = 200
const ENTRY_NO = /^#?\s*[0-9]{1,6}$/

// The delta is re-requested from slightly before the last cursor. Two rows
// written in the same millisecond would otherwise let a strict `>` step
// over one of them for good; the overlap costs a few duplicate rows per
// poll, and they collapse onto the same key anyway.
const OVERLAP_MS = 2000

// A runaway guard, not a real limit: 200 pages of 5000 is a million rows.
const MAX_PAGES = 200

let dbPromise: Promise<IDBPDatabase> | null = null

function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(d) {
        d.createObjectStore(ROWS, { keyPath: 'k' })
        d.createObjectStore(META, { keyPath: 'key' })
      },
    })
  }
  return dbPromise
}

// Every row, held in memory for searching. Reading a hundred thousand rows
// out of IndexedDB per keystroke would be slower than the network we are
// replacing, so they are read once at startup and then kept up to date in
// place — a full reload after every poll would stall the screen for
// seconds on a large dataset.
const cache = new Map<string, SnapRow>()
let loaded = false

async function meta(key: string): Promise<string | null> {
  const d = await db()
  const row = await d.get(META, key)
  return row?.value ?? null
}

async function setMeta(key: string, value: string) {
  const d = await db()
  await d.put(META, { key, value })
}

/** Read the cached rows into memory. Call once, on opening the screen. */
export async function loadSnapshot(): Promise<number> {
  const d = await db()
  const all = (await d.getAll(ROWS)) as SnapRow[]
  cache.clear()
  for (const r of all) cache.set(r.k, r)
  loaded = true
  return cache.size
}

export function snapshotSize(): number {
  return cache.size
}

export function snapshotLoaded(): boolean {
  return loaded
}

export async function lastSyncedAt(): Promise<number | null> {
  const v = await meta(SYNCED_KEY)
  return v ? Number(v) : null
}

/** Throw the cache away — used when the Super Admin has cleared the data. */
export async function clearSnapshot() {
  const d = await db()
  await d.clear(ROWS)
  await d.clear(META)
  cache.clear()
}

type Packed = [
  number, // block index into `blocks`
  number | null, // entry_no
  string, // reg_no_display
  string | null, // owner_name
  string | null, // owner_phone
  string | null, // village
  string | null, // taluka
  string | null, // landmark
  number, // entered_at, epoch ms
  number, // exited flag
]

type Page = {
  blocks: { id: string; name: string; landmark: string | null }[]
  rows: Packed[]
  deleted: [number, number][]
  // Null when the server had nothing to send and the phone has no cursor
  // yet — an empty table on a first sync.
  until: string | null
  deletedUntil: string | null
  more: boolean
  epoch: string | null
}

/**
 * Turn one wire page into rows to store and keys to drop.
 *
 * Pulled out of the sync loop so `scripts/parity-search.mjs` can build the
 * very same rows the phone would, and check them against the database's
 * own search. A copy of this mapping inside the test would only prove the
 * copy right.
 */
export function unpackPage(data: Page): { rows: SnapRow[]; goneKeys: string[] } {
  const rows: SnapRow[] = []
  for (const p of data.rows) {
    const block = data.blocks[p[0]]
    if (!block) continue // a block created mid-sync; the next poll settles it
    rows.push({
      // Keyed on the block's id, not its name — renaming a block from
      // /admin/blocks would otherwise orphan every row it holds.
      k: `${block.id}|${p[1]}`,
      b: block.name,
      bl: block.landmark,
      n: p[1],
      reg: p[2],
      regn: normalizeReg(p[2]),
      name: p[3],
      phone: p[4],
      vill: p[5],
      tal: p[6],
      lm: p[7],
      t: p[8],
      x: p[9],
    })
  }

  const goneKeys: string[] = []
  for (const [idx, entryNo] of data.deleted) {
    const block = data.blocks[idx]
    if (block) goneKeys.push(`${block.id}|${entryNo}`)
  }

  return { rows, goneKeys }
}

let syncing = false

/**
 * Pull everything new from the server. Safe to call on a timer — it does
 * nothing with no network, and only one run happens at a time.
 */
export async function syncSnapshot(): Promise<{
  added: number
  removed: number
  full: boolean
  failed: boolean
}> {
  if (syncing || !navigator.onLine) return { added: 0, removed: 0, full: false, failed: false }
  syncing = true

  let added = 0
  let removed = 0
  let full = false

  try {
    let cursor = await meta(CURSOR_KEY)
    let deletedCursor = await meta(DELETED_CURSOR_KEY)
    full = !cursor

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams()
      if (cursor) {
        params.set('since', new Date(Date.parse(cursor) - OVERLAP_MS).toISOString())
      }
      // No overlap here. A deletion is an exact instant and the archive is
      // append-only, so re-asking for a window would only replay work
      // already done.
      if (deletedCursor) params.set('deleted_since', deletedCursor)

      const res = await fetch(`/api/search/snapshot?${params}`)
      if (!res.ok) return { added, removed, full, failed: true }
      const data: Page = await res.json()

      // A "Start Fresh" invalidates everything. Without this the phone
      // would keep answering with vehicles that no longer exist.
      const seenEpoch = await meta(EPOCH_KEY)
      if (data.epoch && seenEpoch && data.epoch !== seenEpoch) {
        await clearSnapshot()
        await setMeta(EPOCH_KEY, data.epoch)
        cursor = null
        full = true
        added = 0
        removed = 0
        continue // start again from nothing
      }
      if (data.epoch && !seenEpoch) await setMeta(EPOCH_KEY, data.epoch)

      // Built first, written second. Nothing is awaited between the puts:
      // awaiting each one turns a hundred thousand rows into a hundred
      // thousand round trips through the event loop, and an IndexedDB
      // transaction left idle in between can close under us.
      const { rows: incoming, goneKeys } = unpackPage(data)

      const d = await db()
      const tx = d.transaction(ROWS, 'readwrite')
      for (const row of incoming) tx.store.put(row)
      for (const key of goneKeys) tx.store.delete(key)
      await tx.done

      // The in-memory copy is updated in step, so a search right after a
      // poll sees the same rows the database does.
      for (const row of incoming) cache.set(row.k, row)
      for (const key of goneKeys) cache.delete(key)

      added += incoming.length
      removed += goneKeys.length

      // The cursor must always move forward. If a whole page happened to
      // land inside the re-request overlap — a bulk update stamping a
      // thousand rows in the same second would do it — the next request
      // would ask for the same page again, forever. A single millisecond
      // is enough to break that, and cannot skip a row the page did not
      // already contain.
      // A page with nothing in it leaves the cursor where it was — there
      // is no new high-water mark to move it to.
      if (data.until) {
        const before = cursor ? Date.parse(cursor) : 0
        const next = Date.parse(data.until)
        cursor = data.more && next <= before ? new Date(before + 1).toISOString() : data.until
        await setMeta(CURSOR_KEY, cursor)
      }
      if (data.deletedUntil && data.deletedUntil !== deletedCursor) {
        deletedCursor = data.deletedUntil
        await setMeta(DELETED_CURSOR_KEY, deletedCursor)
      }
      if (!data.more) break
    }

    await setMeta(SYNCED_KEY, String(Date.now()))
    loaded = true

    return { added, removed, full, failed: false }
  } catch {
    return { added, removed, full, failed: true }
  } finally {
    syncing = false
  }
}

// ============================================================
//  Searching the cache
//
//  Rank for rank the same as search_vehicles() in the database.
// ============================================================

type Q = {
  regQ: string
  phoneQ: string
  nameQ: string
  villQ: string
  talQ: string
  entryQ: number | null
}

export function searchSnapshot(qRaw: string, villageRaw: string, talukaRaw: string): SnapResult[] {
  return searchRows(cache.values(), qRaw, villageRaw, talukaRaw)
}

/**
 * The matching itself, over any set of rows. Separated from the cache so
 * the parity test can run it against rows it fetched itself — testing a
 * reimplementation would prove nothing about what the phone actually does.
 */
export function searchRows(
  rows: Iterable<SnapRow>,
  qRaw: string,
  villageRaw: string,
  talukaRaw: string,
): SnapResult[] {
  const q = (qRaw ?? '').trim()
  const nameQ = q.toLowerCase()
  const villQ = (villageRaw ?? '').trim().toLowerCase()
  const talQ = (talukaRaw ?? '').trim().toLowerCase()

  // At least one field has to carry something, or nothing is returned
  if (!nameQ && !villQ && !talQ) return []

  const terms: Q = {
    regQ: normalizeReg(q),
    phoneQ: q.replace(/\D/g, ''),
    nameQ,
    villQ,
    talQ,
    // Plain digits are tried as an entry number as well as a plate or
    // phone fragment. A leading # means the operator is certain, and then
    // nothing else is searched.
    entryQ: ENTRY_NO.test(q) ? Number(q.replace(/\D/g, '')) : null,
  }
  const entryOnly = q.startsWith('#')

  const out: SnapResult[] = []

  for (const r of rows) {
    // Village and taluka narrow whatever else matched
    if (villQ && !(r.vill ?? '').toLowerCase().includes(villQ)) continue
    if (talQ && !(r.tal ?? '').toLowerCase().includes(talQ)) continue

    // A blank q means "do not filter on the vehicle number at all"
    let matched = !nameQ
    if (nameQ) {
      matched = entryOnly
        ? terms.entryQ != null && r.n === terms.entryQ
        : (terms.entryQ != null && r.n === terms.entryQ) ||
          (terms.regQ.length >= MIN_Q && r.regn.includes(terms.regQ)) ||
          (terms.phoneQ.length >= MIN_PHONE && (r.phone ?? '').includes(terms.phoneQ)) ||
          (nameQ.length >= MIN_Q && (r.name ?? '').toLowerCase().includes(nameQ))
    }
    if (!matched) continue

    out.push({
      id: r.k,
      entry_no: r.n,
      reg_no_display: r.reg,
      owner_name: r.name,
      owner_phone: r.phone,
      village: r.vill,
      taluka: r.tal,
      landmark: r.lm,
      entered_at: new Date(r.t).toISOString(),
      status: r.x ? 'exited' : 'parked',
      block_name: r.b,
      block_landmark: r.bl,
      match_rank: rank(r, terms),
    })
  }

  out.sort(
    (a, z) =>
      a.match_rank - z.match_rank ||
      a.block_name.localeCompare(z.block_name) ||
      z.entered_at.localeCompare(a.entered_at),
  )

  return out.slice(0, LIMIT)
}

function rank(r: SnapRow, q: Q): number {
  if (q.entryQ != null && r.n === q.entryQ) return 1
  if (q.regQ && r.regn === q.regQ) return 2
  if (q.regQ && r.regn.endsWith(q.regQ)) return 3
  if (q.regQ && r.regn.includes(q.regQ)) return 4
  if (q.phoneQ && (r.phone ?? '').includes(q.phoneQ)) return 5
  if (q.nameQ && (r.name ?? '').toLowerCase().includes(q.nameQ)) return 6

  const vill = (r.vill ?? '').toLowerCase()
  const tal = (r.tal ?? '').toLowerCase()
  if (q.villQ && vill === q.villQ && q.talQ && tal === q.talQ) return 7
  if (q.villQ && vill === q.villQ) return 8
  if (q.talQ && tal === q.talQ) return 9
  return 10
}

/**
 * Whether a query is worth running at all — the same thresholds the server
 * applies, so the two never disagree about "type a bit more".
 */
export function isSearchable(q: string, village: string, taluka: string): boolean {
  const term = (q ?? '').trim()
  return (
    ENTRY_NO.test(term) ||
    term.length >= MIN_Q ||
    (village ?? '').trim().length >= MIN_PLACE ||
    (taluka ?? '').trim().length >= MIN_PLACE
  )
}
