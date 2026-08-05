// Does the phone's offline search give the same answers as the database?
//
// This is the check that matters most for the snapshot feature. If the two
// disagree, the same query returns different vehicles depending on whether
// the operator happened to have signal — which is far worse than being slow.
//
// It runs the REAL client code (compiled from lib/snapshot.ts), not a
// reimplementation, against the REAL snapshot endpoint, and compares every
// query with /api/search.
//
// Usage — with a local server running:
//   npx tsc lib/snapshot.ts --outDir .parity-build --module commonjs \
//     --target es2020 --moduleResolution node --skipLibCheck --esModuleInterop
//   node scripts/parity-search.mjs
//
// The build lands inside the project on purpose: the compiled module still
// requires `idb`, which only resolves from within node_modules' reach.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const snap = require('../.parity-build/snapshot.js')

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const BASE = 'http://localhost:3000'
let bad = 0
const fail = (m) => { console.log('  ✗ ' + m); bad++ }
const ok = (m) => console.log('  ✓ ' + m)

// --- log in ----------------------------------------------------------
const login = await fetch(`${BASE}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pin: env.SUPER_ADMIN_PIN }),
})
const H = { cookie: login.headers.get('set-cookie')?.split(';')[0] }

// --- pull the snapshot exactly as the phone would --------------------
const rows = new Map()
let cursor = null
let pages = 0
for (;;) {
  const params = new URLSearchParams()
  if (cursor) params.set('since', new Date(Date.parse(cursor) - 2000).toISOString())
  const res = await fetch(`${BASE}/api/search/snapshot?${params}`, { headers: H })
  if (!res.ok) { fail(`snapshot page ${pages}: ${res.status}`); break }
  const page = await res.json()

  const { rows: incoming, goneKeys } = snap.unpackPage(page)
  for (const r of incoming) rows.set(r.k, r)
  for (const k of goneKeys) rows.delete(k)

  pages++
  cursor = page.until
  if (!page.more) break
}
ok(`snapshot pulled: ${rows.size} vehicles in ${pages} page(s)`)

const all = [...rows.values()]
const { count: expected } = await (async () => {
  const r = await fetch(`${BASE}/api/entries?limit=1`, { headers: H })
  const j = await r.json()
  return { count: j.total }
})()
all.length === expected ? ok(`matches the table exactly (${expected})`) : fail(`snapshot has ${all.length}, table has ${expected}`)

// Every field the search screen draws must have survived the packing
const withAll = all.find((r) => r.name && r.phone && r.vill)
withAll
  ? ok(`fields survive packing (e.g. #${withAll.n} ${withAll.reg} — ${withAll.name}, ${withAll.vill})`)
  : fail('no row came back with name / phone / village intact')

// --- build the queries from the real data ----------------------------
const withPhone = all.find((r) => r.phone && r.phone.length >= 10)
const withName = all.find((r) => r.name && r.name.length >= 5)
const withVillage = all.find((r) => r.vill && r.vill.length >= 3)
const sample = all[Math.floor(all.length / 2)]

const queries = [
  { label: 'full plate', q: sample.reg },
  { label: 'last 4 of a plate', q: sample.reg.slice(-4) },
  { label: 'middle of a plate', q: sample.reg.slice(2, 6) },
  { label: 'entry number as #N', q: `#${sample.n}` },
  { label: 'entry number as plain N', q: String(sample.n) },
  { label: 'phone, last 4', q: withPhone?.phone.slice(-4) ?? '' },
  { label: 'full phone', q: withPhone?.phone ?? '' },
  { label: 'name fragment', q: withName?.name.slice(0, 5) ?? '' },
  { label: 'village only', q: '', village: withVillage?.vill ?? '' },
  { label: 'village + taluka', q: '', village: withVillage?.vill ?? '', taluka: withVillage?.tal ?? '' },
  { label: 'plate + village', q: sample.reg.slice(-4), village: sample.vill ?? '' },
  { label: 'nothing matches', q: 'ZZZZ9999' },
].filter((t) => t.q || t.village || t.taluka)

const key = (r) => `${r.block_name}#${r.entry_no}`

for (const t of queries) {
  const params = new URLSearchParams()
  if (t.q) params.set('q', t.q)
  if (t.village) params.set('village', t.village)
  if (t.taluka) params.set('taluka', t.taluka)

  const server = await (await fetch(`${BASE}/api/search?${params}`, { headers: H })).json()
  const serverSet = new Set((server.results ?? []).map(key))

  const local = snap.searchRows(all, t.q ?? '', t.village ?? '', t.taluka ?? '')
  const localSet = new Set(local.map(key))

  const onlyServer = [...serverSet].filter((k) => !localSet.has(k))
  const onlyLocal = [...localSet].filter((k) => !serverSet.has(k))

  if (onlyServer.length === 0 && onlyLocal.length === 0) {
    // The top hit is what the operator reads out, so it must agree too
    const topAgrees =
      local.length === 0 || key(local[0]) === key(server.results[0])
    topAgrees
      ? ok(`${t.label} ("${t.q || t.village}") → ${localSet.size} results, identical`)
      : fail(`${t.label}: same set but different top hit — server ${key(server.results[0])}, phone ${key(local[0])}`)
  } else {
    fail(
      `${t.label} ("${t.q || t.village}"): ` +
        `${onlyServer.length} only on server [${onlyServer.slice(0, 3)}], ` +
        `${onlyLocal.length} only on phone [${onlyLocal.slice(0, 3)}]`,
    )
  }
}

// --- the thresholds must agree too -----------------------------------
for (const [q, want] of [['ab', false], ['abc', true], ['7', true], ['#7', true], ['', false]]) {
  snap.isSearchable(q, '', '') === want
    ? ok(`"${q}" searchable=${want}`)
    : fail(`"${q}" searchable should be ${want}`)
}

console.log(bad === 0 ? '\nOffline search agrees with the database.' : `\n${bad} check(s) FAILED.`)
process.exit(bad === 0 ? 0 : 1)
