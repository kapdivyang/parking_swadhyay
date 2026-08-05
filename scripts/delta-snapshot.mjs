// Does the phone's copy actually keep up?
//
// A snapshot that only ever does the first full pull is worse than useless
// at an event: it would answer confidently with an hour-old view. This
// checks that a new entry, an edit and a delete each reach the phone
// through the delta, and that nothing else comes down the wire with them.
//
// One throwaway entry is created and then fully removed, including its
// archive record and the block counter it consumed.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const snap = require('../.parity-build/snapshot.js')

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
})

const BASE = 'http://localhost:3000'
const PLATE = 'ZZ00DELTA777'
let bad = 0
const fail = (m) => { console.log('  ✗ ' + m); bad++ }
const ok = (m) => console.log('  ✓ ' + m)

const login = await fetch(`${BASE}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pin: env.SUPER_ADMIN_PIN }),
})
const cookie = login.headers.get('set-cookie')?.split(';')[0]
const H = { 'Content-Type': 'application/json', cookie }

const { data: block } = await db.from('blocks').select('id, name').eq('name', 'P1 - VIP').single()
const { data: c0 } = await db.from('block_counters').select('last_no').eq('block_id', block.id).single()
const { count: before } = await db.from('vehicles').select('id', { count: 'exact', head: true })
// The archive is not assumed to be empty — real deletions live there too,
// and this script must put back what it took, not wipe the table.
const { count: archiveBefore } = await db
  .from('vehicle_deletions').select('id', { count: 'exact', head: true })

// --- the phone's cache, as the real client would build it -------------
const rows = new Map()
let cursor = null
let deletedCursor = null
let bytes = 0

async function pull() {
  let added = 0
  let removed = 0
  for (;;) {
    const params = new URLSearchParams()
    // The same two-second overlap the real client uses, so what is
    // measured here is what a phone would actually download.
    if (cursor) params.set('since', new Date(Date.parse(cursor) - 2000).toISOString())
    if (deletedCursor) params.set('deleted_since', deletedCursor)

    const res = await fetch(`${BASE}/api/search/snapshot?${params}`, { headers: H })
    const text = await res.text()
    bytes += text.length
    const page = JSON.parse(text)
    const { rows: incoming, goneKeys } = snap.unpackPage(page)
    for (const r of incoming) rows.set(r.k, r)
    for (const k of goneKeys) rows.delete(k)
    added += incoming.length
    removed += goneKeys.length
    if (page.until) cursor = page.until
    if (page.deletedUntil) deletedCursor = page.deletedUntil
    if (!page.more) break
  }
  return { added, removed }
}

// The overlap deliberately re-sends anything written in the last two
// seconds, so "idle" means a handful of rows, not exactly zero.
const OVERLAP_SLACK = 5

// --- 1. the first full pull -------------------------------------------
let b0 = bytes
const full = await pull()
const fullBytes = bytes - b0
rows.size === before ? ok(`full pull: ${rows.size} vehicles`) : fail(`full pull got ${rows.size}, expected ${before}`)
ok(`full pull weighs ${(fullBytes / 1024).toFixed(0)} KB — about ${(fullBytes / rows.size).toFixed(0)} bytes a vehicle`)

// --- 2. an idle poll must cost almost nothing -------------------------
b0 = bytes
const idle = await pull()
idle.added <= OVERLAP_SLACK && idle.removed === 0
  ? ok(`idle poll: ${idle.added} row(s) from the overlap, 0 deletions replayed, ${bytes - b0} bytes`)
  : fail(`idle poll returned ${idle.added} rows and ${idle.removed} deletions — a cursor is not holding`)

let id = null
try {
  // --- 3. a new entry must arrive -------------------------------------
  const post = await fetch(`${BASE}/api/vehicles`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      entries: [{
        reg_no: PLATE, block_id: block.id, owner_name: 'Delta Test',
        owner_phone: '9000000001', village: 'Deltagam', landmark: 'near light tower 4',
        client_uuid: crypto.randomUUID(), device_id: 'delta',
        entered_at: new Date().toISOString(),
      }],
    }),
  })
  const entryNo = (await post.json()).assigned?.[0]?.entry_no
  const { data: made } = await db.from('vehicles').select('id').eq('reg_no', PLATE).single()
  id = made.id

  b0 = bytes
  const afterInsert = await pull()
  const key = `${block.id}|${entryNo}`
  rows.has(key) && afterInsert.added <= OVERLAP_SLACK
    ? ok(`new entry #${entryNo} reached the phone in ${bytes - b0} bytes, not the whole table`)
    : fail(`delta after insert brought ${afterInsert.added} rows; has key: ${rows.has(key)}`)

  const found = snap.searchRows(rows.values(), PLATE, '', '')
  found.length === 1 && found[0].landmark === 'near light tower 4'
    ? ok('offline search finds it, landmark and all')
    : fail(`offline search returned ${found.length}`)

  // --- 4. an edit must arrive -----------------------------------------
  await fetch(`${BASE}/api/vehicles/${id}`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ block_id: block.id, owner_name: 'Delta Edited', landmark: 'near gate 9' }),
  })
  b0 = bytes
  const afterEdit = await pull()
  const edited = rows.get(key)
  afterEdit.added >= 1 && edited?.name === 'Delta Edited' && edited?.lm === 'near gate 9'
    ? ok(`edit reached the phone (${bytes - b0} bytes)`)
    : fail(`edit did not propagate: ${JSON.stringify({ added: afterEdit.added, name: edited?.name, lm: edited?.lm })}`)

  // --- 5. a delete must arrive ----------------------------------------
  const del = await fetch(`${BASE}/api/vehicles/${id}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ confirm: PLATE, reason: 'delta test' }),
  })
  del.ok ? ok('deleted through the API') : fail(`delete failed: ${del.status}`)
  id = null

  b0 = bytes
  const afterDelete = await pull()
  afterDelete.removed === 1 && !rows.has(key)
    ? ok(`delete reached the phone — it is gone from the cache (${bytes - b0} bytes)`)
    : fail(`delete did not propagate: removed ${afterDelete.removed}, still cached: ${rows.has(key)}`)

  snap.searchRows(rows.values(), PLATE, '', '').length === 0
    ? ok('offline search no longer finds it')
    : fail('offline search still returns the deleted vehicle')

  rows.size === before ? ok(`cache back to ${rows.size}`) : fail(`cache has ${rows.size}, expected ${before}`)
} finally {
  console.log('\nCleaning up…')
  if (id) await db.rpc('delete_vehicle', { p_id: id, p_reason: 'delta test cleanup' })
  // Only this script's own archive rows — matched by reason, which no
  // real deletion from the app ever sets.
  const { data: arch } = await db
    .from('vehicle_deletions').select('id').in('reason', ['delta test', 'delta test cleanup'])
  for (const a of arch ?? []) await db.from('vehicle_deletions').delete().eq('id', a.id)
  await db.from('block_counters').update({ last_no: c0.last_no }).eq('block_id', block.id)

  const { count: after } = await db.from('vehicles').select('id', { count: 'exact', head: true })
  const { count: archiveAfter } = await db
    .from('vehicle_deletions').select('id', { count: 'exact', head: true })
  const { data: c1 } = await db.from('block_counters').select('last_no').eq('block_id', block.id).single()

  after === before ? ok(`back to ${after} entries`) : fail(`entry count is ${after}, was ${before}`)
  c1.last_no === c0.last_no ? ok(`counter restored to ${c1.last_no}`) : fail(`counter is ${c1.last_no}`)
  archiveAfter === archiveBefore
    ? ok(`archive unchanged (${archiveAfter} real deletions left alone)`)
    : fail(`archive went from ${archiveBefore} to ${archiveAfter}`)
}

console.log(bad === 0 ? '\nDelta sync works.' : `\n${bad} check(s) FAILED.`)
process.exit(bad === 0 ? 0 : 1)
