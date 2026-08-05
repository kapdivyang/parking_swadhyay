import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getSession } from '@/lib/auth'

// GET — all blocks with live status (dashboard + entry picker)
export async function GET() {
  if (!(await getSession())) {
    return NextResponse.json({ error: 'Please log in' }, { status: 401 })
  }

  // The epoch rides along with the block list the entry screen already
  // polls, so a phone learns about a "Start Fresh" without another request.
  const [{ data, error }, { data: epoch }] = await Promise.all([
    supabaseAdmin
      .from('block_status')
      .select('*')
      .eq('is_active', true)
      .order('sort_order'),
    supabaseAdmin.rpc('data_epoch'),
  ])

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ blocks: data, data_epoch: epoch ?? null })
}

// POST — create a block (Super Admin only)
export async function POST(req: Request) {
  if ((await getSession())?.role !== 'super') {
    return NextResponse.json({ error: 'Super Admin only' }, { status: 403 })
  }

  const body = await req.json().catch(() => null)
  if (!body) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const name = String(body.name ?? '').trim().toUpperCase()
  const capacity = Number(body.capacity)

  if (!name) {
    return NextResponse.json({ error: 'Block name is required' }, { status: 400 })
  }
  if (!Number.isInteger(capacity) || capacity <= 0) {
    return NextResponse.json({ error: 'Capacity must be at least 1' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('blocks')
    .insert({
      name,
      landmark: String(body.landmark ?? '').trim() || null,
      capacity,
      vehicle_type: body.vehicle_type ?? 'car',
      sort_order: Number(body.sort_order) || 0,
    })
    .select()
    .single()

  if (error) {
    const msg = error.code === '23505' ? `Block "${name}" already exists` : error.message
    return NextResponse.json({ error: msg }, { status: 400 })
  }
  return NextResponse.json({ block: data })
}
