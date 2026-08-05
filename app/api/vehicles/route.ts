import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getSession, type Session } from '@/lib/auth'
import { normalizeReg, cleanDisplay, normalizePhone, isPlausibleReg, cleanPlace } from '@/lib/reg'

type IncomingEntry = {
  reg_no?: unknown
  block_id?: unknown
  owner_name?: unknown
  owner_phone?: unknown
  village?: unknown
  taluka?: unknown
  landmark?: unknown
  client_uuid?: unknown
  device_id?: unknown
  entered_at?: unknown
}

type PreparedRow = {
  reg_no: string
  reg_no_display: string
  block_id: string
  owner_name: string | null
  owner_phone: string | null
  village: string | null
  taluka: string | null
  landmark: string | null
  client_uuid: string
  device_id: string | null
  entered_at: string
  // Which account made this entry. Half of "who put this in?" — the other
  // half, device_id, says which phone.
  user_id: string | null
}

type Rejection = { client_uuid: string; error: string }
// The number the database gave the entry, sent back so the phone can show
// it next to the vehicle. Only the server can assign it — two phones on
// one block would otherwise both hand out the same number.
type Assignment = { client_uuid: string; entry_no: number }

function prepare(e: IncomingEntry, session: Session): { row?: PreparedRow; error?: string } {
  const rawReg = String(e.reg_no ?? '')
  const reg = normalizeReg(rawReg)

  if (!isPlausibleReg(rawReg)) {
    return { error: `"${rawReg}" does not look like a valid number` }
  }

  // An entry account writes to its own block, whatever the phone sends.
  // Only the Super Admin, who has no block of their own, may name one.
  // This matters most for the offline queue: entries can sit on a device
  // for an hour, and the account may have been moved to another block in
  // the meantime — the block it lands in should be the one it belongs to
  // now, decided here, not the one the phone remembered.
  const blockId = session.role === 'super' ? String(e.block_id ?? '') : (session.blockId ?? '')
  if (!blockId) {
    return { error: 'No block selected' }
  }

  const phone = normalizePhone(String(e.owner_phone ?? ''))

  return {
    row: {
      reg_no: reg,
      reg_no_display: cleanDisplay(rawReg),
      block_id: blockId,
      owner_name: String(e.owner_name ?? '').trim() || null,
      owner_phone: phone || null,
      // Tidied the same way everywhere, so "Bhavnagar " and "bhavnagar"
      // do not become two different villages in the results
      village: cleanPlace(String(e.village ?? '')),
      taluka: cleanPlace(String(e.taluka ?? '')),
      // "Near light tower 4" — where the car is standing inside the block
      landmark: cleanPlace(String(e.landmark ?? '')),
      // The entry's own id from the device — a resend will not duplicate it
      client_uuid: String(e.client_uuid ?? '') || crypto.randomUUID(),
      device_id: String(e.device_id ?? '') || null,
      // The real time the vehicle arrived, not the time it synced
      entered_at: e.entered_at ? new Date(String(e.entered_at)).toISOString() : new Date().toISOString(),
      user_id: session.userId,
    },
  }
}

// --- Where a vehicle already is, in words the operator can act on ------
async function blockNames(): Promise<Map<string, string>> {
  const { data } = await supabaseAdmin.from('blocks').select('id, name')
  return new Map((data ?? []).map((b) => [b.id as string, b.name as string]))
}

type Existing = {
  client_uuid: string | null
  reg_no: string
  reg_no_display: string
  owner_phone: string | null
  block_id: string
  entry_no: number | null
}

// Everything already in the table that could collide with this batch.
// Only 'parked' rows count — an exited vehicle frees its number up.
async function findClashes(rows: PreparedRow[]) {
  const regs = rows.map((r) => r.reg_no)
  const phones = rows.map((r) => r.owner_phone).filter((p): p is string => !!p)
  const uuids = rows.map((r) => r.client_uuid)

  const cols = 'client_uuid, reg_no, reg_no_display, owner_phone, block_id, entry_no'
  const base = () => supabaseAdmin.from('vehicles').select(cols).eq('status', 'parked')

  // Three narrow lookups rather than one big OR — the values come from the
  // network, and .in() escapes them properly.
  const [byReg, byPhone, byUuid] = await Promise.all([
    base().in('reg_no', regs),
    phones.length ? base().in('owner_phone', phones) : Promise.resolve({ data: [], error: null }),
    base().in('client_uuid', uuids),
  ])

  const error = byReg.error ?? byPhone.error ?? byUuid.error
  if (error) return { error }

  const all = [
    ...((byReg.data ?? []) as Existing[]),
    ...((byPhone.data ?? []) as Existing[]),
    ...((byUuid.data ?? []) as Existing[]),
  ]

  return {
    regTaken: new Map(all.map((r) => [r.reg_no, r])),
    phoneTaken: new Map(all.filter((r) => r.owner_phone).map((r) => [r.owner_phone!, r])),
    alreadySaved: new Set(all.map((r) => r.client_uuid).filter((u): u is string => !!u)),
    // An entry that is already on the server still has to report its
    // number back — the phone that queued it may never have heard the
    // first reply.
    numberOf: new Map(
      all
        .filter((r) => r.client_uuid && r.entry_no != null)
        .map((r) => [r.client_uuid!, r.entry_no!]),
    ),
    error: null,
  }
}

// POST — one or many entries (the offline queue sends them in a batch)
export async function POST(req: Request) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'Please log in' }, { status: 401 })
  }
  if (session.role === 'search') {
    return NextResponse.json({ error: 'This account can only search' }, { status: 403 })
  }

  const body = await req.json().catch(() => null)
  if (!body) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const incoming: IncomingEntry[] = Array.isArray(body.entries)
    ? body.entries
    : [body as IncomingEntry]

  if (incoming.length === 0) {
    return NextResponse.json({ error: 'No entries provided' }, { status: 400 })
  }

  const prepared: PreparedRow[] = []
  const rejected: Rejection[] = []

  for (const e of incoming) {
    const { row, error } = prepare(e, session)
    if (row) prepared.push(row)
    else rejected.push({ client_uuid: String(e.client_uuid ?? ''), error: error! })
  }

  if (prepared.length === 0) {
    return NextResponse.json({ error: rejected[0]?.error ?? 'Invalid entry', rejected }, { status: 400 })
  }

  const clashes = await findClashes(prepared)
  if (clashes.error) {
    return NextResponse.json({ error: clashes.error.message }, { status: 500 })
  }
  const { regTaken, phoneTaken, alreadySaved, numberOf } = clashes
  const names = await blockNames()
  const where = (blockId: string) => names.get(blockId) ?? 'another block'

  // A resend of an entry the server already holds is not a duplicate —
  // it is the same entry arriving twice over a flaky network.
  const resent = prepared.filter((r) => alreadySaved.has(r.client_uuid))
  const fresh = prepared.filter((r) => !alreadySaved.has(r.client_uuid))

  // Two devices can also collide *within* one batch, so the batch is
  // checked against itself as well as against the table.
  const seenReg = new Set<string>()
  const seenPhone = new Set<string>()
  const rows: PreparedRow[] = []

  for (const r of fresh) {
    // Every rejection names the field that clashed. "Duplicate entry" would
    // leave the operator guessing which of the two to ask the visitor about.
    const regClash = regTaken.get(r.reg_no)
    if (regClash) {
      rejected.push({
        client_uuid: r.client_uuid,
        error: `Vehicle number ${r.reg_no_display} is already entered — Block ${where(regClash.block_id)}`,
      })
      continue
    }
    if (seenReg.has(r.reg_no)) {
      rejected.push({
        client_uuid: r.client_uuid,
        error: `Vehicle number ${r.reg_no_display} was entered twice`,
      })
      continue
    }

    if (r.owner_phone) {
      const phoneClash = phoneTaken.get(r.owner_phone)
      if (phoneClash) {
        rejected.push({
          client_uuid: r.client_uuid,
          error: `Mobile number ${r.owner_phone} is already used for ${phoneClash.reg_no_display}`,
        })
        continue
      }
      if (seenPhone.has(r.owner_phone)) {
        rejected.push({
          client_uuid: r.client_uuid,
          error: `Mobile number ${r.owner_phone} was entered twice`,
        })
        continue
      }
      seenPhone.add(r.owner_phone)
    }

    seenReg.add(r.reg_no)
    rows.push(r)
  }

  const saved = resent.map((r) => r.client_uuid)
  const assigned: Assignment[] = resent
    .filter((r) => numberOf.has(r.client_uuid))
    .map((r) => ({ client_uuid: r.client_uuid, entry_no: numberOf.get(r.client_uuid)! }))

  if (rows.length > 0) {
    // The entry number is handed out by a trigger, so it only exists once
    // the row is in — it has to be read back, not calculated here.
    const { data, error } = await supabaseAdmin
      .from('vehicles')
      .upsert(rows, { onConflict: 'client_uuid', ignoreDuplicates: true })
      .select('client_uuid, entry_no')

    if (!error) {
      saved.push(...rows.map((r) => r.client_uuid))
      for (const d of data ?? []) {
        if (d.client_uuid && d.entry_no != null) {
          assigned.push({ client_uuid: d.client_uuid as string, entry_no: d.entry_no as number })
        }
      }
    } else if (error.code === '23505') {
      // Two operators hit the same number in the same instant and the
      // check above could not see it. Retry one at a time so a single
      // clash does not take the other 99 entries down with it.
      const one = await insertIndividually(rows, where)
      saved.push(...one.saved)
      rejected.push(...one.rejected)
      assigned.push(...one.assigned)
    } else {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
  }

  return NextResponse.json({
    ok: true,
    saved,
    assigned,
    inserted: rows.length,
    rejected,
  })
}

// The slow path, only after a unique-violation race
async function insertIndividually(rows: PreparedRow[], where: (id: string) => string) {
  const saved: string[] = []
  const rejected: Rejection[] = []
  const assigned: Assignment[] = []

  for (const r of rows) {
    const { data: inserted, error } = await supabaseAdmin
      .from('vehicles')
      .upsert([r], { onConflict: 'client_uuid', ignoreDuplicates: true })
      .select('client_uuid, entry_no')

    if (!error) {
      saved.push(r.client_uuid)
      const got = inserted?.[0]
      if (got?.entry_no != null) {
        assigned.push({ client_uuid: r.client_uuid, entry_no: got.entry_no as number })
      }
      continue
    }
    if (error.code !== '23505') {
      rejected.push({ client_uuid: r.client_uuid, error: error.message })
      continue
    }

    // Say which of the two rules it broke, and where the vehicle is
    const { data } = await supabaseAdmin
      .from('vehicles')
      .select('reg_no, reg_no_display, owner_phone, block_id')
      .eq('status', 'parked')
      .or(`reg_no.eq.${r.reg_no}${r.owner_phone ? `,owner_phone.eq.${r.owner_phone}` : ''}`)
      .limit(1)

    const hit = data?.[0]
    rejected.push({
      client_uuid: r.client_uuid,
      error:
        hit && hit.reg_no === r.reg_no
          ? `Vehicle number ${r.reg_no_display} is already entered — Block ${where(hit.block_id as string)}`
          : hit
            ? `Mobile number ${r.owner_phone} is already used for ${hit.reg_no_display}`
            : `Vehicle number ${r.reg_no_display} is already entered`,
    })
  }

  return { saved, rejected, assigned }
}

// GET — recent entries for a block (the "recently entered" list)
export async function GET(req: Request) {
  if (!(await getSession())) {
    return NextResponse.json({ error: 'Please log in' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const blockId = searchParams.get('block_id')
  const limit = Math.min(Number(searchParams.get('limit')) || 10, 50)

  let q = supabaseAdmin
    .from('vehicles')
    .select('id, entry_no, reg_no_display, owner_name, landmark, entered_at, block_id, user_id')
    .order('entered_at', { ascending: false })
    .limit(limit)

  if (blockId) q = q.eq('block_id', blockId)

  const { data, error } = await q
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ vehicles: data })
}
