import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getSession } from '@/lib/auth'
import { normalizeReg, cleanDisplay, normalizePhone, isPlausibleReg, cleanPlace } from '@/lib/reg'

type Ctx = { params: Promise<{ id: string }> }

// An entry account may correct entries in its own block and nowhere else.
// The Super Admin is not fenced in that way.
//
// The block comes from the signed session, never from the request. That is
// what makes this a real boundary rather than a guard against mis-taps: a
// phone can no longer claim to belong to a block it was not given, because
// the claim is not the phone's to make.
async function mayTouch(id: string) {
  const session = await getSession()
  if (!session) return { error: 'Please log in', status: 401 as const }

  if (session.role === 'search') {
    return { error: 'This account can only search', status: 403 as const }
  }

  const { data, error } = await supabaseAdmin
    .from('vehicles')
    .select('id, entry_no, reg_no, reg_no_display, block_id, owner_phone')
    .eq('id', id)
    .maybeSingle()

  if (error) return { error: error.message, status: 500 as const }
  if (!data) return { error: 'That entry no longer exists', status: 404 as const }

  if (session.role !== 'super') {
    if (!session.blockId) {
      return { error: 'This account has no block', status: 400 as const }
    }
    if (session.blockId !== data.block_id) {
      return {
        error: 'This entry belongs to another block — only the Super Admin can change it',
        status: 403 as const,
      }
    }
  }

  return { session, vehicle: data }
}

// PATCH — correct an entry.
//
// The block is deliberately not editable. Entry numbers run 1, 2, 3…
// inside a block, so moving a vehicle across would either duplicate a
// number or leave a hole. A vehicle entered under the wrong block is a
// delete and a re-entry.
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  // body.block_id is deliberately not consulted. Which block this account
  // may touch is decided by its session, above.
  const gate = await mayTouch(id)
  if ('error' in gate) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }
  const current = gate.vehicle

  const patch: Record<string, unknown> = {}

  if (body.reg_no !== undefined) {
    const raw = String(body.reg_no)
    if (!isPlausibleReg(raw)) {
      return NextResponse.json({ error: `"${raw}" does not look like a valid number` }, { status: 400 })
    }
    patch.reg_no = normalizeReg(raw)
    patch.reg_no_display = cleanDisplay(raw)
  }

  if (body.owner_name !== undefined) {
    patch.owner_name = String(body.owner_name).trim() || null
  }
  if (body.owner_phone !== undefined) {
    patch.owner_phone = normalizePhone(String(body.owner_phone)) || null
  }
  if (body.village !== undefined) patch.village = cleanPlace(String(body.village))
  if (body.taluka !== undefined) patch.taluka = cleanPlace(String(body.taluka))
  if (body.landmark !== undefined) patch.landmark = cleanPlace(String(body.landmark))

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to change' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('vehicles')
    .update(patch)
    .eq('id', id)
    .select('id, entry_no, reg_no_display, owner_name, owner_phone, village, taluka, landmark, entered_at, updated_at, block_id')
    .single()

  if (error) {
    // The same two rules the entry screen enforces, and the same wording:
    // "duplicate" alone would leave the operator guessing which field to
    // ask the visitor about.
    if (error.code === '23505') {
      return NextResponse.json({ error: await clashMessage(patch, current.id) }, { status: 400 })
    }
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({ vehicle: data })
}

// Which of the two uniqueness rules the edit broke, and where the other
// vehicle already is
async function clashMessage(patch: Record<string, unknown>, selfId: string): Promise<string> {
  const reg = patch.reg_no as string | undefined
  const phone = patch.owner_phone as string | null | undefined

  if (reg) {
    const { data } = await supabaseAdmin
      .from('vehicles')
      .select('reg_no_display, blocks(name)')
      .eq('status', 'parked')
      .eq('reg_no', reg)
      .neq('id', selfId)
      .maybeSingle()
    if (data) {
      // The embedded block comes back as an object on a to-one join and as
      // a one-element array on some client versions; both are handled so a
      // type change upstream cannot turn this into "undefined".
      const joined = data.blocks as unknown as { name: string } | { name: string }[] | null
      const block = (Array.isArray(joined) ? joined[0]?.name : joined?.name) ?? 'another block'
      return `Vehicle number ${data.reg_no_display} is already entered — Block ${block}`
    }
  }

  if (phone) {
    const { data } = await supabaseAdmin
      .from('vehicles')
      .select('reg_no_display')
      .eq('status', 'parked')
      .eq('owner_phone', phone)
      .neq('id', selfId)
      .maybeSingle()
    if (data) {
      return `Mobile number ${phone} is already used for ${data.reg_no_display}`
    }
  }

  return 'That vehicle number or mobile number is already entered'
}

// DELETE — Super Admin only.
//
// The row is copied into vehicle_deletions before it goes, so deleting the
// wrong entry has an answer rather than a shrug. The vehicle number has to
// be typed back to confirm: a delete is one tap away from a list of
// hundreds of near-identical rows.
export async function DELETE(req: Request, { params }: Ctx) {
  if ((await getSession())?.role !== 'super') {
    return NextResponse.json({ error: 'Only the Super Admin can delete an entry' }, { status: 403 })
  }

  const { id } = await params
  const body = await req.json().catch(() => null)

  const { data: v, error: findErr } = await supabaseAdmin
    .from('vehicles')
    .select('id, reg_no, reg_no_display')
    .eq('id', id)
    .maybeSingle()

  if (findErr) return NextResponse.json({ error: findErr.message }, { status: 500 })
  if (!v) return NextResponse.json({ error: 'That entry no longer exists' }, { status: 404 })

  const typed = normalizeReg(String(body?.confirm ?? ''))
  if (typed !== v.reg_no) {
    return NextResponse.json(
      { error: `Type ${v.reg_no_display} exactly to confirm the delete` },
      { status: 400 },
    )
  }

  const { data, error } = await supabaseAdmin.rpc('delete_vehicle', {
    p_id: id,
    p_reason: String(body?.reason ?? '').trim() || null,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const row = Array.isArray(data) ? data[0] : data
  return NextResponse.json({ ok: true, deleted: row?.deleted ?? false, reg_no_display: v.reg_no_display })
}
