import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getSession } from '@/lib/auth'

// The phrase the Super Admin has to type out. A button that wipes the
// day's work should not be reachable by a mis-tap.
const CONFIRM = 'CLEAR ALL'

// GET — what a reset would remove right now, and when the last one was
export async function GET() {
  if ((await getSession())?.role !== 'super') {
    return NextResponse.json({ error: 'Super Admin only' }, { status: 403 })
  }

  const [{ count }, { data: last }] = await Promise.all([
    supabaseAdmin.from('vehicles').select('id', { count: 'exact', head: true }),
    supabaseAdmin
      .from('resets')
      .select('performed_at, vehicles_deleted')
      .order('performed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  return NextResponse.json({
    vehicles: count ?? 0,
    last_reset: last ?? null,
  })
}

// POST — clear every vehicle entry. Blocks are left alone.
export async function POST(req: Request) {
  if ((await getSession())?.role !== 'super') {
    return NextResponse.json({ error: 'Super Admin only' }, { status: 403 })
  }

  const body = await req.json().catch(() => null)
  if (String(body?.confirm ?? '').trim().toUpperCase() !== CONFIRM) {
    return NextResponse.json(
      { error: `Type ${CONFIRM} to confirm` },
      { status: 400 },
    )
  }

  const { data, error } = await supabaseAdmin.rpc('reset_all_data')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // The RPC returns one row: how many went, and the new epoch
  const row = Array.isArray(data) ? data[0] : data

  return NextResponse.json({
    ok: true,
    vehicles_deleted: row?.vehicles_deleted ?? 0,
    performed_at: row?.performed_at ?? null,
  })
}
