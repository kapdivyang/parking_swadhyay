import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getSession } from '@/lib/auth'
import { normalizeReg, normalizePhone } from '@/lib/reg'

// Is this vehicle number / mobile number already taken?
//
// The database is what actually enforces this, but the operator needs to
// know before the car is waved through — not ten seconds later when the
// queue syncs. Called on save whenever the phone is online.
export async function GET(req: Request) {
  if (!(await getSession())) {
    return NextResponse.json({ error: 'Please log in' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const reg = normalizeReg(searchParams.get('reg') ?? '')
  const phone = normalizePhone(searchParams.get('phone') ?? '')

  if (!reg && !phone) {
    return NextResponse.json({ error: 'Nothing to check' }, { status: 400 })
  }

  const cols = 'reg_no, reg_no_display, owner_phone, block_id, entered_at'
  const base = () => supabaseAdmin.from('vehicles').select(cols).eq('status', 'parked')

  const [byReg, byPhone] = await Promise.all([
    reg ? base().eq('reg_no', reg).limit(1) : Promise.resolve({ data: [], error: null }),
    phone ? base().eq('owner_phone', phone).limit(1) : Promise.resolve({ data: [], error: null }),
  ])

  const error = byReg.error ?? byPhone.error
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const regHit = byReg.data?.[0]
  const phoneHit = byPhone.data?.[0]

  if (!regHit && !phoneHit) {
    return NextResponse.json({ ok: true })
  }

  const hit = regHit ?? phoneHit!
  const { data: block } = await supabaseAdmin
    .from('blocks')
    .select('name')
    .eq('id', hit.block_id as string)
    .maybeSingle()

  return NextResponse.json({
    ok: false,
    field: regHit ? 'reg_no' : 'owner_phone',
    // Named by field, never a generic "duplicate" — the two cases lead to
    // two different conversations with the visitor.
    reason: regHit
      ? `Vehicle number ${regHit.reg_no_display} is already entered — Block ${block?.name ?? 'unknown'}`
      : `Mobile number ${phone} is already used for ${phoneHit!.reg_no_display}`,
    block_name: block?.name ?? null,
    reg_no_display: hit.reg_no_display,
  })
}
