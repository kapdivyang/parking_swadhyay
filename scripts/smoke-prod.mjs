// Read-only smoke test of the deployed site. Logs in, reads, and changes
// nothing — no entry is created, edited or deleted here.

import { readFileSync } from 'node:fs'

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const BASE = 'https://event-parking.vercel.app'
let bad = 0
const fail = (m) => { console.log('  ✗ ' + m); bad++ }
const ok = (m) => console.log('  ✓ ' + m)

// --- logged out, the data must be unreachable ------------------------
// 401 or 403 — the Super-Admin-only routes answer 403 to everyone who is
// not a Super Admin, logged in or not, the same way /api/admin/reset has
// always done. Either way the data does not come out.
for (const path of ['/api/entries', '/api/export', '/api/search?q=GJ']) {
  const r = await fetch(`${BASE}${path}`, { redirect: 'manual' })
  r.status === 401 || r.status === 403
    ? ok(`${path} → ${r.status} logged out`)
    : fail(`${path} → ${r.status}, expected 401 or 403`)
}

// --- as Super Admin --------------------------------------------------
const login = await fetch(`${BASE}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pin: env.SUPER_ADMIN_PIN }),
})
const cookie = login.headers.get('set-cookie')?.split(';')[0]
cookie ? ok('Super Admin login works') : fail('login failed')
const H = { cookie }

const blocks = await (await fetch(`${BASE}/api/blocks`, { headers: H })).json()
blocks.blocks?.length === 17 ? ok(`17 blocks live`) : fail(`got ${blocks.blocks?.length} blocks`)

const entries = await (await fetch(`${BASE}/api/entries?limit=5`, { headers: H })).json()
entries.total === 1673 ? ok(`entry list: ${entries.total} entries`) : fail(`entry list total is ${entries.total}`)
entries.entries?.[0]?.entry_no != null
  ? ok(`newest entry is #${entries.entries[0].entry_no} in ${entries.entries[0].block_name}`)
  : fail('entry list has no entry_no')
'landmark' in (entries.entries?.[0] ?? {}) ? ok('entry list carries landmark') : fail('landmark missing')

// --- search, including by entry number -------------------------------
const probe = entries.entries[0]
const byPlate = await (await fetch(`${BASE}/api/search?q=${encodeURIComponent(probe.reg_no_display)}`, { headers: H })).json()
byPlate.results?.length > 0 ? ok('search by plate works') : fail('search by plate returned nothing')

const byNo = await (await fetch(`${BASE}/api/search?q=%23${probe.entry_no}`, { headers: H })).json()
byNo.results?.some((r) => r.entry_no === probe.entry_no)
  ? ok(`search "#${probe.entry_no}" works (${byNo.results.length} across blocks)`)
  : fail('search by entry number returned nothing')

// --- export: read only the first chunk, not all 1673 rows ------------
const csv = await fetch(`${BASE}/api/export`, { headers: H })
csv.headers.get('content-type')?.includes('text/csv') ? ok('export serves text/csv') : fail('wrong content-type')
csv.headers.get('content-disposition')?.includes('attachment')
  ? ok(`export downloads as ${csv.headers.get('content-disposition').match(/filename="([^"]+)"/)?.[1]}`)
  : fail('export is not an attachment')
const head = (await csv.text()).split('\r\n')
head[0].includes('entry_no') && head[0].includes('landmark') && head[0].includes('vehicle_type')
  ? ok('CSV header correct') : fail(`header: ${head[0]}`)
head.length - 2 === 1673 ? ok(`CSV streamed all ${head.length - 2} rows`) : fail(`CSV has ${head.length - 2} rows`)

// --- the new screen renders ------------------------------------------
const page = await fetch(`${BASE}/entries`, { headers: H })
page.ok ? ok('/entries renders') : fail(`/entries → ${page.status}`)

// --- the offline snapshot ---------------------------------------------
// Fetched the way a phone would, including asking for the compressed
// response, so the size reported is the size that actually crosses 4G.
let pulled = 0
let cursor = null
let wire = 0
let pages = 0
for (;;) {
  const params = new URLSearchParams()
  if (cursor) params.set('since', cursor)
  const res = await fetch(`${BASE}/api/search/snapshot?${params}`, {
    headers: { ...H, 'Accept-Encoding': 'gzip, br' },
  })
  if (!res.ok) { fail(`snapshot page ${pages} → ${res.status}`); break }
  const body = await res.arrayBuffer()
  wire += body.byteLength
  const j = JSON.parse(new TextDecoder().decode(body))
  pulled += j.rows.length
  cursor = j.until
  pages++
  if (!j.more || pages > 50) break
}
pulled === entries.total
  ? ok(`snapshot serves all ${pulled} vehicles in ${pages} page(s)`)
  : fail(`snapshot served ${pulled}, table has ${entries.total}`)
ok(`snapshot costs ${(wire / 1024).toFixed(0)} KB decoded — a phone downloads this once`)

const idle = await fetch(`${BASE}/api/search/snapshot?since=${encodeURIComponent(cursor)}&deleted_since=${encodeURIComponent(new Date().toISOString())}`, { headers: H })
const idleBody = await idle.text()
idleBody.length < 5000
  ? ok(`an idle poll costs ${idleBody.length} bytes`)
  : fail(`an idle poll costs ${idleBody.length} bytes — too much to repeat every minute`)

const snapLoggedOut = await fetch(`${BASE}/api/search/snapshot`)
snapLoggedOut.status === 401
  ? ok('snapshot refuses a logged-out request (401)')
  : fail(`snapshot logged out → ${snapLoggedOut.status} — the whole table must not be public`)

// --- accounts ---------------------------------------------------------
// Read-only: this runs against production, so it creates nothing.
const usersOut = await fetch(`${BASE}/api/users`)
usersOut.status === 403
  ? ok('account list refuses a logged-out request (403)')
  : fail(`/api/users logged out → ${usersOut.status} — it holds every PIN`)

const usersRes = await fetch(`${BASE}/api/users`, { headers: H })
const usersJson = await usersRes.json()
usersRes.ok
  ? ok(`Super Admin sees the account list (${usersJson.users?.length ?? 0} accounts)`)
  : fail(`/api/users → ${usersRes.status}`)

const adminPage = await fetch(`${BASE}/admin/users`, { headers: H })
adminPage.ok ? ok('/admin/users renders') : fail(`/admin/users → ${adminPage.status}`)

// The old shared PIN must be dead in production too
if (env.APP_PIN) {
  const old = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: env.APP_PIN }),
  })
  old.status === 401 || old.status === 403
    ? ok(`the old shared PIN is refused in production (${old.status})`)
    : fail(`the old APP_PIN still signs in on production — ${old.status}`)
}

if ((usersJson.users?.length ?? 0) === 0) {
  console.log(
    '\n  NOTE: no accounts exist yet. Until the Super Admin creates them at\n' +
      '  /admin/users, nobody but the Super Admin can sign in.',
  )
}

console.log(bad === 0 ? '\nProduction looks healthy.' : `\n${bad} check(s) FAILED.`)
process.exit(bad === 0 ? 0 : 1)
