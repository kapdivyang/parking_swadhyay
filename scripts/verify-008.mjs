// Read-only check that migration 008 landed correctly on the live data.
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

let bad = 0
const fail = (m) => { console.log('  ✗ ' + m); bad++ }
const ok = (m) => console.log('  ✓ ' + m)

// 1. Every existing entry got a number
const { count: missing, error: e1 } = await db
  .from('vehicles').select('id', { count: 'exact', head: true }).is('entry_no', null)
if (e1) fail('entry_no column: ' + e1.message)
else missing === 0 ? ok('every entry has a number') : fail(`${missing} entries still have no number`)

// 2. The new columns are reachable through the API
const { data: sample, error: e2 } = await db
  .from('vehicles').select('entry_no, landmark, updated_at, block_id').limit(1)
if (e2) fail('landmark / updated_at: ' + e2.message)
else ok('entry_no, landmark, updated_at all readable')

// 3. Numbering is 1..n with no duplicates, per block
const { data: blocks } = await db.from('blocks').select('id, name').order('name')
const { data: counters } = await db.from('block_counters').select('block_id, last_no')
const counterOf = new Map((counters ?? []).map((c) => [c.block_id, c.last_no]))

for (const b of blocks ?? []) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('vehicles').select('entry_no')
      .eq('block_id', b.id).range(from, from + 999)
    rows.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
  }
  if (rows.length === 0) continue

  const nums = rows.map((r) => r.entry_no).sort((a, z) => a - z)
  const dupes = nums.length - new Set(nums).size
  const contiguous = nums[0] === 1 && nums[nums.length - 1] === nums.length
  const counter = counterOf.get(b.id)

  const highest = nums[nums.length - 1]

  // The counter may sit above the highest live number: a deleted entry
  // does not give its number back, by design. It must never sit below one.
  if (dupes > 0) fail(`${b.name}: ${dupes} duplicate numbers`)
  else if (counter < highest) fail(`${b.name}: counter is ${counter}, below the highest number ${highest}`)
  else if (!contiguous) ok(`${b.name}: ${nums.length} entries, ${nums[0]}..${highest}, counter ${counter} (gaps from deletions)`)
  else ok(`${b.name}: 1..${highest}, counter ${counter}`)
}

// 4. Search still works, and now answers an entry number
const { data: probe } = await db
  .from('vehicles').select('reg_no_display, entry_no').limit(1).single()

const { data: byPlate, error: e4 } = await db.rpc('search_vehicles', {
  q: probe.reg_no_display, village_q: '', taluka_q: '',
})
if (e4) fail('search by plate: ' + e4.message)
else (byPlate ?? []).length > 0 ? ok(`search by plate returns ${byPlate.length}`) : fail('search by plate returned nothing')

const { data: byNo, error: e5 } = await db.rpc('search_vehicles', {
  q: `#${probe.entry_no}`, village_q: '', taluka_q: '',
})
if (e5) fail('search by #entry: ' + e5.message)
else (byNo ?? []).length > 0
  ? ok(`search "#${probe.entry_no}" returns ${byNo.length} (across all blocks)`)
  : fail('search by entry number returned nothing')

if (byNo?.[0]) {
  const r = byNo[0]
  const hasNew = 'entry_no' in r && 'landmark' in r && 'block_id' in r
  hasNew ? ok('search results carry entry_no / landmark / block_id') : fail('search result is missing the new columns')
}

// 5. The delete archive exists (not exercised — nothing is deleted here)
const { error: e6 } = await db.from('vehicle_deletions').select('id', { head: true, count: 'exact' })
e6 ? fail('vehicle_deletions: ' + e6.message) : ok('vehicle_deletions table ready')

// 6. Nothing was lost
const { count: total } = await db.from('vehicles').select('id', { count: 'exact', head: true })
total === 1673 ? ok(`still ${total} entries — nothing lost`) : fail(`entry count is ${total}, expected 1673`)

console.log(bad === 0 ? '\nAll checks passed.' : `\n${bad} check(s) FAILED.`)
process.exit(bad === 0 ? 0 : 1)
