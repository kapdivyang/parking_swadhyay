// Read-only export of the live vehicles table to CSV.
// Runs SELECT only — no insert, update, delete or DDL anywhere in this file.

import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// --- env (.env.local, not committed) ---------------------------------
const env = {}
for (const line of readFileSync(process.argv[2], 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const url = env.NEXT_PUBLIC_SUPABASE_URL
const key = env.SUPABASE_SECRET_KEY
if (!url || !key) throw new Error('Missing Supabase env')

console.log('Project:', new URL(url).host)

const db = createClient(url, key, { auth: { persistSession: false } })

// --- blocks (for names) ----------------------------------------------
const { data: blocks, error: bErr } = await db.from('blocks').select('id, name, landmark')
if (bErr) throw bErr
const blockName = new Map(blocks.map((b) => [b.id, b.name]))
const blockMark = new Map(blocks.map((b) => [b.id, b.landmark]))
console.log('Blocks:', blocks.length)

// --- vehicles, paged so nothing is truncated at 1000 ------------------
const PAGE = 1000
const rows = []
for (let from = 0; ; from += PAGE) {
  const { data, error } = await db
    .from('vehicles')
    .select('*')
    .order('entered_at', { ascending: true })
    .order('id', { ascending: true })
    .range(from, from + PAGE - 1)
  if (error) throw error
  rows.push(...data)
  process.stdout.write(`\rFetched ${rows.length}…`)
  if (data.length < PAGE) break
}
console.log(`\nVehicles: ${rows.length}`)

// --- CSV --------------------------------------------------------------
const COLS = [
  ['sr_no', (r, i) => i + 1],
  ['block', (r) => blockName.get(r.block_id) ?? ''],
  ['block_landmark', (r) => blockMark.get(r.block_id) ?? ''],
  ['vehicle_no', (r) => r.reg_no_display],
  ['vehicle_no_normalized', (r) => r.reg_no],
  ['owner_name', (r) => r.owner_name ?? ''],
  ['owner_phone', (r) => r.owner_phone ?? ''],
  ['village', (r) => r.village ?? ''],
  ['taluka', (r) => r.taluka ?? ''],
  ['landmark', (r) => r.landmark ?? ''],
  ['vehicle_type', (r) => r.vehicle_type ?? ''],
  ['status', (r) => r.status],
  ['entered_at_ist', (r) => ist(r.entered_at)],
  ['entered_at_utc', (r) => r.entered_at ?? ''],
  ['exited_at_ist', (r) => ist(r.exited_at)],
  ['device_id', (r) => r.device_id ?? ''],
  ['client_uuid', (r) => r.client_uuid ?? ''],
  ['id', (r) => r.id],
]

function ist(ts) {
  if (!ts) return ''
  return new Date(ts)
    .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })
    .replace(',', '')
}

const esc = (v) => {
  const s = String(v ?? '')
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const lines = [COLS.map(([h]) => h).join(',')]
rows.forEach((r, i) => lines.push(COLS.map(([, f]) => esc(f(r, i))).join(',')))

// BOM so Excel reads Gujarati / Hindi names correctly
const out = process.argv[3]
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8')

// A verbatim snapshot alongside the CSV. The CSV is for reading; this is
// what a restore would be rebuilt from — every column, exactly as stored.
const snap = out.replace(/\.csv$/, '') + '.json'
writeFileSync(snap, JSON.stringify({ exported_at: new Date().toISOString(), blocks, vehicles: rows }, null, 1), 'utf8')

// --- a small summary, useful for the analysis they mentioned ----------
const perBlock = new Map()
for (const r of rows) {
  const n = blockName.get(r.block_id) ?? '(unknown)'
  perBlock.set(n, (perBlock.get(n) ?? 0) + 1)
}
console.log('\nPer block:')
for (const [n, c] of [...perBlock].sort((a, b) => b[1] - a[1])) console.log(`  ${n}: ${c}`)
console.log('\nWritten:', out)
