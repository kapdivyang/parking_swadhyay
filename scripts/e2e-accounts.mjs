// User accounts: do the boundaries actually hold?
//
// This is an auth change, so almost every check here is a check that
// something is REFUSED. It creates two throwaway accounts and one
// throwaway vehicle, and removes all of it afterwards — including the
// block counter the vehicle consumed and its archive row.
//
// Needs a local server running against the live database.

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
const PLATE = 'ZZ00ACCT4242'
let bad = 0
const fail = (m) => { console.log('  ✗ ' + m); bad++ }
const ok = (m) => console.log('  ✓ ' + m)

async function login(pin) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  })
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  return { status: res.status, body: await res.json().catch(() => ({})), cookie }
}
const H = (c) => ({ 'Content-Type': 'application/json', cookie: c })

// --- baseline ---------------------------------------------------------
const { data: blocks } = await db.from('blocks').select('id, name').order('name')
const mine = blocks[0]
const theirs = blocks[1]
const { count: vehiclesBefore } = await db.from('vehicles').select('id', { count: 'exact', head: true })
const { count: archiveBefore } = await db.from('vehicle_deletions').select('id', { count: 'exact', head: true })
const { data: c0 } = await db.from('block_counters').select('last_no').eq('block_id', mine.id).single()
// Real accounts may already exist. This script must put back exactly what
// it took, not empty the table.
const { count: usersBefore } = await db.from('app_users').select('id', { count: 'exact', head: true })
console.log(`Baseline: ${vehiclesBefore} entries. Test accounts get ${mine.name}; ${theirs.name} is the one they must not touch.\n`)

const supa = await login(env.SUPER_ADMIN_PIN)
supa.cookie ? ok('Super Admin signed in') : fail('Super Admin login failed')

let entryUser = null
let searchUser = null
let vehicleId = null

try {
  // --- 1. creating accounts ------------------------------------------
  const mk = async (body) => {
    const r = await fetch(`${BASE}/api/users`, {
      method: 'POST', headers: H(supa.cookie), body: JSON.stringify(body),
    })
    return { status: r.status, json: await r.json() }
  }

  const a = await mk({ name: 'E2E Entry', pin: '778811', role: 'entry', block_id: mine.id })
  entryUser = a.json.user
  entryUser?.id ? ok(`entry account created for ${entryUser.block_name}`) : fail(`create failed: ${JSON.stringify(a.json)}`)

  const b = await mk({ name: 'E2E Desk', pin: '778812', role: 'search' })
  searchUser = b.json.user
  searchUser?.id && searchUser.block_id === null
    ? ok('view-only account created with no block')
    : fail(`create failed: ${JSON.stringify(b.json)}`)

  // --- 2. what the API refuses to create ------------------------------
  const noBlock = await mk({ name: 'Bad', pin: '778813', role: 'entry' })
  noBlock.status === 400 ? ok('entry account without a block: refused') : fail(`expected 400, got ${noBlock.status}`)

  const dupePin = await mk({ name: 'Dupe', pin: '778811', role: 'entry', block_id: mine.id })
  dupePin.status === 400 ? ok('duplicate PIN: refused') : fail(`expected 400, got ${dupePin.status}`)

  const superPin = await mk({ name: 'Clash', pin: env.SUPER_ADMIN_PIN, role: 'entry', block_id: mine.id })
  superPin.status === 400
    ? ok('account using the Super Admin PIN: refused')
    : fail(`expected 400, got ${superPin.status} — that account would be unreachable`)

  // --- 3. signing in as each --------------------------------------------
  const e = await login('778811')
  e.cookie && e.body.role === 'entry' ? ok(`entry account signs in as "${e.body.name}"`) : fail('entry login failed')
  const s = await login('778812')
  s.cookie && s.body.role === 'search' ? ok('view-only account signs in') : fail('search login failed')

  // --- 4. the block fence, now enforced by the session -----------------
  const post = async (cookie, blockId) =>
    fetch(`${BASE}/api/vehicles`, {
      method: 'POST', headers: H(cookie),
      body: JSON.stringify({
        entries: [{
          reg_no: PLATE, block_id: blockId, owner_name: 'Accounts Test',
          client_uuid: crypto.randomUUID(), device_id: 'acct',
          entered_at: new Date().toISOString(),
        }],
      }),
    })

  // Ask to write into someone else's block. It must land in the account's
  // own block regardless — the request does not get a vote.
  const wrote = await (await post(e.cookie, theirs.id)).json()
  const { data: made } = await db.from('vehicles').select('id, block_id, user_id').eq('reg_no', PLATE).maybeSingle()
  vehicleId = made?.id ?? null

  made?.block_id === mine.id
    ? ok(`entry claiming ${theirs.name} was written to ${mine.name} anyway — the session decides`)
    : fail(`entry landed in block ${made?.block_id}, expected ${mine.id}`)
  made?.user_id === entryUser.id ? ok('the entry records which account made it') : fail('user_id not recorded')
  wrote.assigned?.[0]?.entry_no ? ok(`numbered #${wrote.assigned[0].entry_no}`) : fail('no entry number returned')

  // --- 5. what a view-only account cannot do ---------------------------
  const deskWrite = await post(s.cookie, mine.id)
  deskWrite.status === 403 ? ok('view-only creating an entry: refused (403)') : fail(`expected 403, got ${deskWrite.status}`)

  const deskEdit = await fetch(`${BASE}/api/vehicles/${vehicleId}`, {
    method: 'PATCH', headers: H(s.cookie), body: JSON.stringify({ owner_name: 'nope' }),
  })
  deskEdit.status === 403 ? ok('view-only editing: refused (403)') : fail(`expected 403, got ${deskEdit.status}`)

  const deskList = await fetch(`${BASE}/api/entries`, { headers: H(s.cookie) })
  deskList.status === 403 ? ok('view-only reading the entry list: refused (403)') : fail(`expected 403, got ${deskList.status}`)

  const deskExport = await fetch(`${BASE}/api/export`, { headers: H(s.cookie) })
  deskExport.status === 403 ? ok('view-only exporting CSV: refused (403)') : fail(`expected 403, got ${deskExport.status}`)

  const deskUsers = await fetch(`${BASE}/api/users`, { headers: H(s.cookie) })
  deskUsers.status === 403 ? ok('view-only reading the account list: refused (403)') : fail(`expected 403, got ${deskUsers.status}`)

  const deskSearch = await fetch(`${BASE}/api/search?q=${PLATE}`, { headers: H(s.cookie) })
  const deskFound = await deskSearch.json()
  deskSearch.ok && deskFound.results?.length > 0
    ? ok('view-only CAN search — which is its whole job')
    : fail('view-only search did not work')

  const deskSnap = await fetch(`${BASE}/api/search/snapshot`, { headers: H(s.cookie) })
  deskSnap.ok ? ok('view-only can fill its offline copy') : fail(`snapshot → ${deskSnap.status}`)

  // --- 6. entry account is fenced to its own block ---------------------
  const list = await (await fetch(`${BASE}/api/entries?block_id=${theirs.id}`, { headers: H(e.cookie) })).json()
  const strayed = (list.entries ?? []).some((x) => x.block_id !== mine.id)
  !strayed && list.entries
    ? ok(`entry account asking for ${theirs.name} still only sees ${mine.name}`)
    : fail('entry account saw another block by asking for it')
  list.can_delete === false ? ok('entry account is not offered delete') : fail('can_delete should be false')

  const entryDelete = await fetch(`${BASE}/api/vehicles/${vehicleId}`, {
    method: 'DELETE', headers: H(e.cookie), body: JSON.stringify({ confirm: PLATE }),
  })
  entryDelete.status === 403 ? ok('entry account deleting: refused (403)') : fail(`expected 403, got ${entryDelete.status}`)

  const entryUsersList = await fetch(`${BASE}/api/users`, { headers: H(e.cookie) })
  entryUsersList.status === 403 ? ok('entry account reading the account list: refused (403)') : fail(`expected 403, got ${entryUsersList.status}`)

  // It may edit its own block's entry
  const ownEdit = await fetch(`${BASE}/api/vehicles/${vehicleId}`, {
    method: 'PATCH', headers: H(e.cookie), body: JSON.stringify({ owner_name: 'Accounts Edited' }),
  })
  const edited = await ownEdit.json()
  edited.vehicle?.owner_name === 'Accounts Edited'
    ? ok('entry account CAN correct its own block')
    : fail(`own-block edit failed: ${JSON.stringify(edited)}`)

  // --- 7. turning the account off stops it NOW -------------------------
  await fetch(`${BASE}/api/users/${entryUser.id}`, {
    method: 'PATCH', headers: H(supa.cookie), body: JSON.stringify({ is_active: false }),
  })

  const afterOff = await fetch(`${BASE}/api/entries`, { headers: H(e.cookie) })
  afterOff.status === 401
    ? ok('a disabled account is stopped on its very next request, not at next login')
    : fail(`expected 401 with the SAME cookie, got ${afterOff.status} — disabling is decorative`)

  const offWrite = await post(e.cookie, mine.id)
  offWrite.status === 401 ? ok('a disabled account cannot enter either') : fail(`expected 401, got ${offWrite.status}`)

  const offLogin = await login('778811')
  offLogin.status === 403 ? ok('and cannot sign in again (403, said plainly)') : fail(`expected 403, got ${offLogin.status}`)

  // Turning it back on restores it
  await fetch(`${BASE}/api/users/${entryUser.id}`, {
    method: 'PATCH', headers: H(supa.cookie), body: JSON.stringify({ is_active: true }),
  })
  const back = await login('778811')
  back.cookie ? ok('turning it back on restores access') : fail('could not sign in after re-enabling')

  // --- 8. the old shared PIN is gone -----------------------------------
  if (env.APP_PIN) {
    const old = await login(env.APP_PIN)
    old.status === 401 || old.status === 403
      ? ok(`the old shared PIN no longer works (${old.status})`)
      : fail(`the old APP_PIN still signs in — role ${old.body.role}`)
  }

  const nonsense = await login('000000')
  nonsense.status === 401 ? ok('an unknown PIN is refused') : fail(`expected 401, got ${nonsense.status}`)

  // --- 9. and nothing at all works signed out --------------------------
  for (const [path, want] of [
    ['/api/entries', 401],
    ['/api/users', 403],
    ['/api/export', 403],
    ['/api/search?q=GJ06', 401],
    ['/api/search/snapshot', 401],
    ['/api/blocks', 401],
  ]) {
    const r = await fetch(`${BASE}${path}`)
    r.status === want
      ? ok(`signed out: ${path} → ${r.status}`)
      : fail(`signed out: ${path} → ${r.status}, expected ${want}`)
  }

  const outWrite = await fetch(`${BASE}/api/vehicles`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [] }),
  })
  outWrite.status === 401 ? ok('signed out: cannot create an entry') : fail(`expected 401, got ${outWrite.status}`)

  const outEdit = await fetch(`${BASE}/api/vehicles/${vehicleId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner_name: 'nope' }),
  })
  outEdit.status === 401 ? ok('signed out: cannot edit an entry') : fail(`expected 401, got ${outEdit.status}`)
} finally {
  console.log('\nCleaning up…')
  if (vehicleId) {
    await db.rpc('delete_vehicle', { p_id: vehicleId, p_reason: 'accounts test' })
    const { data: arch } = await db.from('vehicle_deletions').select('id').eq('reason', 'accounts test')
    for (const a of arch ?? []) await db.from('vehicle_deletions').delete().eq('id', a.id)
  }
  for (const u of [entryUser, searchUser]) {
    if (u?.id) await db.from('app_users').delete().eq('id', u.id)
  }
  await db.from('app_users').delete().in('pin', ['778811', '778812', '778813'])
  await db.from('block_counters').update({ last_no: c0.last_no }).eq('block_id', mine.id)
  await db.from('login_attempts').delete().gt('id', 0)

  const { count: vehiclesAfter } = await db.from('vehicles').select('id', { count: 'exact', head: true })
  const { count: archiveAfter } = await db.from('vehicle_deletions').select('id', { count: 'exact', head: true })
  const { count: usersLeft } = await db.from('app_users').select('id', { count: 'exact', head: true })
  const { data: c1 } = await db.from('block_counters').select('last_no').eq('block_id', mine.id).single()

  vehiclesAfter === vehiclesBefore ? ok(`back to ${vehiclesAfter} entries`) : fail(`entries ${vehiclesBefore} → ${vehiclesAfter}`)
  archiveAfter === archiveBefore ? ok(`archive unchanged (${archiveAfter} real deletions)`) : fail(`archive ${archiveBefore} → ${archiveAfter}`)
  c1.last_no === c0.last_no ? ok(`${mine.name} counter restored to ${c1.last_no}`) : fail(`counter is ${c1.last_no}`)
  usersLeft === usersBefore
    ? ok(`no test accounts left behind (${usersLeft} real account(s) untouched)`)
    : fail(`accounts went from ${usersBefore} to ${usersLeft}`)
}

console.log(bad === 0 ? '\nAccount boundaries hold.' : `\n${bad} check(s) FAILED.`)
process.exit(bad === 0 ? 0 : 1)
