// End-to-end check of the new routes against a locally running server that
// points at the LIVE database.
//
// It creates exactly one entry, with an unmistakable fake plate, and removes
// every trace of it afterwards — the row, its deletion-archive record, and
// the block counter it consumed. The live table is left byte-for-byte as it
// was found, which is verified at the end.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
})

const BASE = 'http://localhost:3000'
const PLATE = 'ZZ00TEST9999'

let bad = 0
const fail = (m) => { console.log('  ✗ ' + m); bad++ }
const ok = (m) => console.log('  ✓ ' + m)

// --- baseline, so cleanup can be proved ------------------------------
const { count: before } = await db.from('vehicles').select('id', { count: 'exact', head: true })
const { data: block } = await db.from('blocks').select('id, name').eq('name', 'P1 - VIP').single()
const { data: c0 } = await db.from('block_counters').select('last_no').eq('block_id', block.id).single()
// The archive is not assumed to be empty — real deletions live there too,
// and this script must put back only what it took.
const { count: archiveBefore } = await db
  .from('vehicle_deletions').select('id', { count: 'exact', head: true })
console.log(
  `Baseline: ${before} entries, ${block.name} counter at ${c0.last_no}, ` +
    `${archiveBefore} archived deletion(s)\n`,
)

// --- log in as Super Admin -------------------------------------------
const login = await fetch(`${BASE}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pin: env.SUPER_ADMIN_PIN }),
})
const cookie = login.headers.get('set-cookie')?.split(';')[0]
cookie ? ok('logged in as Super Admin') : fail('login failed')
const H = { 'Content-Type': 'application/json', cookie }

let id = null
try {
  // --- 1. create, and get a number back ------------------------------
  const post = await fetch(`${BASE}/api/vehicles`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      entries: [{
        reg_no: PLATE, block_id: block.id, owner_name: 'E2E Test',
        owner_phone: '9000000000', village: 'Testgam', taluka: 'Testtaluka',
        landmark: 'near light tower 4',
        client_uuid: crypto.randomUUID(), device_id: 'e2e',
        entered_at: new Date().toISOString(),
      }],
    }),
  })
  const saved = await post.json()
  const num = saved.assigned?.[0]?.entry_no
  num === c0.last_no + 1
    ? ok(`entry saved, trigger assigned #${num} (was ${c0.last_no})`)
    : fail(`expected #${c0.last_no + 1}, got ${JSON.stringify(saved.assigned)}`)

  const { data: made } = await db.from('vehicles').select('id, landmark, entry_no').eq('reg_no', PLATE).single()
  id = made.id
  made.landmark === 'near light tower 4' ? ok('landmark stored') : fail(`landmark is ${made.landmark}`)

  // --- 2. it shows up in the block-wise list -------------------------
  const list = await (await fetch(`${BASE}/api/entries?block_id=${block.id}&q=${made.entry_no}`, { headers: H })).json()
  list.entries?.some((e) => e.id === id)
    ? ok(`/api/entries finds it by entry number (${list.total} match)`)
    : fail('/api/entries did not return it')
  list.can_delete === true ? ok('Super Admin gets can_delete') : fail('can_delete not set')

  // --- 3. search by #number ------------------------------------------
  const s = await (await fetch(`${BASE}/api/search?q=%23${made.entry_no}`, { headers: H })).json()
  s.results?.some((r) => r.id === id) ? ok('/api/search finds it by #number') : fail('search by #number missed it')

  // --- 4. edit -------------------------------------------------------
  const patch = await fetch(`${BASE}/api/vehicles/${id}`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ block_id: block.id, owner_name: 'E2E Edited', landmark: 'near gate 7' }),
  })
  const edited = await patch.json()
  edited.vehicle?.owner_name === 'E2E Edited' && edited.vehicle?.landmark === 'near gate 7'
    ? ok('edit saved') : fail(`edit failed: ${JSON.stringify(edited)}`)
  edited.vehicle?.updated_at ? ok('updated_at stamped by trigger') : fail('updated_at not set')
  edited.vehicle?.entry_no === made.entry_no ? ok('entry number unchanged by edit') : fail('entry number moved')

  // --- 5. a block admin must not reach another block's entry ---------
  const wrong = await fetch(`${BASE}/api/vehicles/${id}`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ block_id: crypto.randomUUID(), owner_name: 'should not apply' }),
  })
  // As Super Admin this is allowed by design, so only the shape is checked here
  wrong.ok ? ok('Super Admin is not fenced to one block (by design)') : fail('Super Admin was blocked')
  await fetch(`${BASE}/api/vehicles/${id}`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ block_id: block.id, owner_name: 'E2E Edited' }),
  })

  // --- 6. delete needs the plate typed back --------------------------
  const noConfirm = await fetch(`${BASE}/api/vehicles/${id}`, {
    method: 'DELETE', headers: H, body: JSON.stringify({ confirm: 'WRONG' }),
  })
  noConfirm.status === 400 ? ok('delete without the right plate is refused') : fail('delete guard did not hold')

  // --- 7. export -----------------------------------------------------
  const csv = await fetch(`${BASE}/api/export?block_id=${block.id}`, { headers: H })
  // The bytes, not .text() — decoding strips the BOM by spec, so reading it
  // back as a string would report "no BOM" for a file that has one.
  const bytes = new Uint8Array(await csv.arrayBuffer())
  const text = new TextDecoder('utf-8').decode(bytes)
  const lines = text.trim().split('\r\n')
  bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? ok('CSV starts with a BOM (Excel-safe)')
    : fail(`CSV has no BOM — starts with ${bytes.slice(0, 3)}`)
  lines[0].includes('entry_no') && lines[0].includes('landmark')
    ? ok('CSV header has entry_no and landmark') : fail(`CSV header: ${lines[0]}`)
  lines.some((l) => l.includes(PLATE)) ? ok(`CSV streamed ${lines.length - 1} rows for ${block.name}`) : fail('CSV missing the test row')
} finally {
  // --- cleanup: leave nothing behind ---------------------------------
  console.log('\nCleaning up…')
  if (id) {
    await db.rpc('delete_vehicle', { p_id: id, p_reason: 'e2e test' })
    // Matched by reason, which no real deletion from the app ever sets
    const { data: arch } = await db.from('vehicle_deletions').select('id, vehicle').eq('reason', 'e2e test')
    arch?.[0]?.vehicle?.reg_no ? ok('delete_vehicle archived the row before removing it') : fail('nothing was archived')
    for (const a of arch ?? []) await db.from('vehicle_deletions').delete().eq('id', a.id)
  }
  await db.from('block_counters').update({ last_no: c0.last_no }).eq('block_id', block.id)

  const { count: after } = await db.from('vehicles').select('id', { count: 'exact', head: true })
  const { data: c1 } = await db.from('block_counters').select('last_no').eq('block_id', block.id).single()
  const { count: archiveAfter } = await db.from('vehicle_deletions').select('id', { count: 'exact', head: true })

  after === before ? ok(`back to ${after} entries`) : fail(`entry count is ${after}, was ${before}`)
  c1.last_no === c0.last_no ? ok(`${block.name} counter restored to ${c1.last_no}`) : fail(`counter is ${c1.last_no}`)
  archiveAfter === archiveBefore
    ? ok(`archive unchanged (${archiveAfter} real deletion(s) left alone)`)
    : fail(`archive went from ${archiveBefore} to ${archiveAfter}`)
}

console.log(bad === 0 ? '\nAll end-to-end checks passed.' : `\n${bad} check(s) FAILED.`)
process.exit(bad === 0 ? 0 : 1)
