'use client'

import { openDB, type IDBPDatabase } from 'idb'
import { normalizePhone, normalizeReg } from '@/lib/reg'

// Offline entry queue.
// Every entry is written to the device first, then synced in the background.
// If the network drops, the admin keeps entering without interruption.

export type QueuedEntry = {
  client_uuid: string
  reg_no: string
  block_id: string
  block_name: string
  owner_name: string | null
  owner_phone: string | null
  village: string | null
  taluka: string | null
  // Where inside the block the vehicle is standing — "near light tower 4"
  landmark: string | null
  device_id: string
  entered_at: string
  synced: boolean
  // The number the block gave this entry: 1, 2, 3… Only the server can
  // assign it — two phones on one block would otherwise both hand out the
  // same number — so it is empty until the entry syncs.
  entry_no?: number | null
  // Set when the server refused the entry — a duplicate number, almost
  // always. Such an entry must stop retrying and be shown to the operator
  // instead, or it sits in the queue forever.
  rejected?: string | null
}

const DB_NAME = 'parking-queue'
const STORE = 'entries'

// The block this phone is set to. Chosen on the entry screen and read by
// the entry list too, which is why it lives here rather than in either
// screen's own file.
export const BLOCK_KEY = 'parking_selected_block'

let dbPromise: Promise<IDBPDatabase> | null = null

function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(d) {
        const s = d.createObjectStore(STORE, { keyPath: 'client_uuid' })
        s.createIndex('synced', 'synced')
        s.createIndex('entered_at', 'entered_at')
      },
    })
  }
  return dbPromise
}

// A per-device id, so we can later tell which phone made an entry
export function deviceId(): string {
  const KEY = 'parking_device_id'
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = crypto.randomUUID().slice(0, 8)
    localStorage.setItem(KEY, id)
  }
  return id
}

export async function enqueue(entry: Omit<QueuedEntry, 'client_uuid' | 'synced'>) {
  const row: QueuedEntry = {
    ...entry,
    client_uuid: crypto.randomUUID(),
    synced: false,
  }
  const d = await db()
  await d.put(STORE, row)
  return row
}

export async function pendingCount(): Promise<number> {
  const d = await db()
  const all: QueuedEntry[] = await d.getAll(STORE)
  return all.filter((e) => !e.synced && !e.rejected).length
}

export async function recent(limit = 8): Promise<QueuedEntry[]> {
  const d = await db()
  const all: QueuedEntry[] = await d.getAll(STORE)
  return all
    .filter((e) => !e.rejected)
    .sort((a, b) => b.entered_at.localeCompare(a.entered_at))
    .slice(0, limit)
}

// Entries the server refused, newest first — shown so the operator can act
export async function rejectedEntries(): Promise<QueuedEntry[]> {
  const d = await db()
  const all: QueuedEntry[] = await d.getAll(STORE)
  return all.filter((e) => e.rejected).sort((a, b) => b.entered_at.localeCompare(a.entered_at))
}

export async function dismissRejected(clientUuid: string) {
  const d = await db()
  await d.delete(STORE, clientUuid)
}

// Wipe this device's queue. Used when the Super Admin has cleared the
// server: a phone that kept its old entries would refuse numbers it
// remembers, and would push cleared entries straight back up.
export async function clearAll() {
  const d = await db()
  await d.clear(STORE)
}

// Is this number already sitting in this device's own queue? Catches the
// commonest duplicate — the same operator entering the same car twice —
// with no network at all.
//
// Which of the two matched is reported back, because "this vehicle number
// is already entered" and "this mobile number is already used" send the
// operator to two completely different conversations with the visitor.
export async function localClash(
  reg: string,
  phone: string,
): Promise<{ field: 'reg_no' | 'owner_phone'; reg_no: string; block_name: string } | null> {
  const d = await db()
  const all: QueuedEntry[] = await d.getAll(STORE)
  const usable = all.filter((e) => !e.rejected)

  // The vehicle number is checked first — it is the stronger match, and the
  // one the operator can see on the car in front of them.
  const byReg = usable.find((e) => normalizeReg(e.reg_no) === reg)
  if (byReg) {
    return { field: 'reg_no', reg_no: byReg.reg_no, block_name: byReg.block_name }
  }

  if (!phone) return null

  const byPhone = usable.find(
    (e) => !!e.owner_phone && normalizePhone(e.owner_phone) === phone,
  )
  return byPhone
    ? { field: 'owner_phone', reg_no: byPhone.reg_no, block_name: byPhone.block_name }
    : null
}

async function markSynced(uuids: string[], numbers: Map<string, number>) {
  const d = await db()
  const tx = d.transaction(STORE, 'readwrite')
  for (const id of uuids) {
    const row = (await tx.store.get(id)) as QueuedEntry | undefined
    if (!row) continue
    // The entry number arrives with the sync reply, so this is the first
    // moment the phone can show it
    const entry_no = numbers.get(id) ?? row.entry_no ?? null
    await tx.store.put({ ...row, synced: true, entry_no })
  }
  await tx.done
}

async function markRejected(items: { client_uuid: string; error: string }[]) {
  const d = await db()
  const tx = d.transaction(STORE, 'readwrite')
  for (const { client_uuid, error } of items) {
    const row = (await tx.store.get(client_uuid)) as QueuedEntry | undefined
    if (row) await tx.store.put({ ...row, rejected: error })
  }
  await tx.done
}

// Drop old synced entries so the device does not fill up. Only entries older
// than 24 hours are removed, keeping the "recently entered" list populated.
async function pruneOld() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const d = await db()
  const all: QueuedEntry[] = await d.getAll(STORE)
  const tx = d.transaction(STORE, 'readwrite')
  for (const e of all) {
    // Rejected entries are kept — the operator has to see them
    if (e.synced && !e.rejected && e.entered_at < cutoff) await tx.store.delete(e.client_uuid)
  }
  await tx.done
}

let syncing = false

// Send all pending entries to the server in one batch, so 50 entries do not
// turn into 50 separate requests.
export async function syncNow(): Promise<{ sent: number; refused: number; failed: boolean }> {
  if (syncing || !navigator.onLine) return { sent: 0, refused: 0, failed: false }
  syncing = true

  try {
    const d = await db()
    const all: QueuedEntry[] = await d.getAll(STORE)
    const pending = all.filter((e) => !e.synced && !e.rejected)
    if (pending.length === 0) return { sent: 0, refused: 0, failed: false }

    // At most 100 per round
    const batch = pending.slice(0, 100)

    const res = await fetch('/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entries: batch.map((e) => ({
          reg_no: e.reg_no,
          block_id: e.block_id,
          owner_name: e.owner_name,
          owner_phone: e.owner_phone,
          // Entries queued before village/taluka existed simply have no
          // value here — the store keeps no fixed shape, so no migration.
          village: e.village ?? null,
          taluka: e.taluka ?? null,
          landmark: e.landmark ?? null,
          client_uuid: e.client_uuid,
          device_id: e.device_id,
          entered_at: e.entered_at,
        })),
      }),
    })

    // A 400 still carries a rejection list — those entries are not coming
    // back from a retry, so they are recorded rather than left pending.
    const json = await res.json().catch(() => null)
    if (!res.ok && !json?.rejected?.length) return { sent: 0, refused: 0, failed: true }

    const numbers = new Map<string, number>(
      ((json?.assigned ?? []) as { client_uuid: string; entry_no: number }[]).map((a) => [
        a.client_uuid,
        a.entry_no,
      ]),
    )
    await markSynced(json?.saved ?? [], numbers)
    await markRejected(json?.rejected ?? [])
    await pruneOld()

    return {
      sent: json?.saved?.length ?? 0,
      refused: json?.rejected?.length ?? 0,
      failed: false,
    }
  } catch {
    return { sent: 0, refused: 0, failed: true }
  } finally {
    syncing = false
  }
}
