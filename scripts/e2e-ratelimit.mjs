// Does guessing PINs actually get shut down?
//
// A six-digit PIN is a million guesses. Unthrottled, that is an
// afternoon's work for a script, and it applies to the Super Admin PIN
// too. This checks the limiter both stops wrong guesses and — the part
// that is easy to get wrong — does not lock out a correct one it should
// have let through.
//
// Cleans the login_attempts rows it creates.

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
const MAX_FAILURES = 10
let bad = 0
const fail = (m) => { console.log('  ✗ ' + m); bad++ }
const ok = (m) => console.log('  ✓ ' + m)

// Each fake IP is its own bucket, so one test cannot poison another
const IP = () => `203.0.113.${Math.floor(Math.random() * 200) + 1}`

async function login(pin, ip) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ pin }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

await db.from('login_attempts').delete().gt('id', 0)

// --- 1. wrong guesses eventually get refused outright ----------------
const attacker = IP()
let blockedAt = null
for (let i = 1; i <= MAX_FAILURES + 3; i++) {
  const r = await login(String(100000 + i), attacker)
  if (r.status === 429) { blockedAt = i; break }
}
blockedAt
  ? ok(`throttled after ${blockedAt - 1} wrong PINs from one address`)
  : fail(`${MAX_FAILURES + 3} wrong PINs and still not throttled`)

// --- 2. and the CORRECT PIN is refused too, once throttled -----------
// This is the point. A limiter that waves the right PIN through is not a
// limiter — the attacker's last guess would be the one that works.
const throttledCorrect = await login(env.SUPER_ADMIN_PIN, attacker)
throttledCorrect.status === 429
  ? ok('even the correct PIN is refused while throttled')
  : fail(`correct PIN returned ${throttledCorrect.status} while throttled — the limit can be walked straight past`)

// --- 3. a different address is unaffected ----------------------------
const innocent = IP()
const clean = await login(env.SUPER_ADMIN_PIN, innocent)
clean.status === 200
  ? ok('a different address is unaffected — one attacker cannot lock everyone out')
  : fail(`a clean address got ${clean.status}`)

// --- 4. success does not count against you ---------------------------
const busy = IP()
for (let i = 0; i < MAX_FAILURES + 5; i++) await login(env.SUPER_ADMIN_PIN, busy)
const stillFine = await login(env.SUPER_ADMIN_PIN, busy)
stillFine.status === 200
  ? ok(`${MAX_FAILURES + 5} correct logins in a row are still fine — only failures count`)
  : fail(`a busy but legitimate address got ${stillFine.status}`)

// --- 5. attempts are recorded ----------------------------------------
const { count } = await db.from('login_attempts').select('id', { count: 'exact', head: true })
count > 0 ? ok(`${count} attempts recorded for review`) : fail('nothing was recorded')

console.log('\nCleaning up…')
await db.from('login_attempts').delete().gt('id', 0)
const { count: left } = await db.from('login_attempts').select('id', { count: 'exact', head: true })
left === 0 ? ok('attempt log cleared') : fail(`${left} rows left`)

console.log(bad === 0 ? '\nRate limiting works.' : `\n${bad} check(s) FAILED.`)
process.exit(bad === 0 ? 0 : 1)
