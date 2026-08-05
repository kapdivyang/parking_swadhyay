import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getSession } from '@/lib/auth'

type Ctx = { params: Promise<{ id: string }> }

// PATCH — edit a block (Super Admin only)
export async function PATCH(req: Request, { params }: Ctx) {
  if ((await getSession())?.role !== 'super') {
    return NextResponse.json({ error: 'Super Admin only' }, { status: 403 })
  }

  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}

  if (body.name !== undefined) {
    const name = String(body.name).trim().toUpperCase()
    if (!name) {
      return NextResponse.json({ error: 'Block name is required' }, { status: 400 })
    }
    patch.name = name
  }

  if (body.capacity !== undefined) {
    const capacity = Number(body.capacity)
    if (!Number.isInteger(capacity) || capacity <= 0) {
      return NextResponse.json({ error: 'Capacity must be at least 1' }, { status: 400 })
    }
    patch.capacity = capacity
  }

  if (body.landmark !== undefined) {
    patch.landmark = String(body.landmark).trim() || null
  }
  if (body.vehicle_type !== undefined) patch.vehicle_type = body.vehicle_type
  if (body.sort_order !== undefined) patch.sort_order = Number(body.sort_order) || 0
  if (body.is_active !== undefined) patch.is_active = Boolean(body.is_active)

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('blocks')
    .update(patch)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    const msg = error.code === '23505' ? 'That name is already taken' : error.message
    return NextResponse.json({ error: msg }, { status: 400 })
  }
  return NextResponse.json({ block: data })
}

// DELETE — remove a block (Super Admin only, and only when empty)
export async function DELETE(_req: Request, { params }: Ctx) {
  if ((await getSession())?.role !== 'super') {
    return NextResponse.json({ error: 'Super Admin only' }, { status: 403 })
  }

  const { id } = await params

  // Refuse if any vehicle is still recorded in this block
  const { count, error: countErr } = await supabaseAdmin
    .from('vehicles')
    .select('id', { count: 'exact', head: true })
    .eq('block_id', id)

  if (countErr) {
    return NextResponse.json({ error: countErr.message }, { status: 500 })
  }
  if (count && count > 0) {
    return NextResponse.json(
      { error: `This block has ${count} entries and cannot be deleted. Mark it inactive instead.` },
      { status: 400 }
    )
  }

  const { error } = await supabaseAdmin.from('blocks').delete().eq('id', id)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }
  return NextResponse.json({ ok: true })
}
