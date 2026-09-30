import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getSession } from '@/lib/auth'

// The block-wise entry list.
//
//   block admin  →  the block their phone is set to
//   Super Admin  →  any block, or every block at once
//
// Paged, because a busy block ran to 346 entries in the trial and will run
// to several thousand on the day.

const PAGE = 100
const MAX_PAGE = 500

const SELECT =
  'id, entry_no, reg_no_display, owner_name, owner_phone, village, taluka, landmark, vehicle_type, entered_at, updated_at, block_id, blocks(name)'

export async function GET(req: Request) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'Please log in' }, { status: 401 })
  }
  // A help-desk account searches for one vehicle at a time. Handing it the
  // whole list, block by block, is a different thing entirely.
  if (session.role === 'search') {
    return NextResponse.json({ error: 'This account can only search' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q') ?? ''
  const page = Math.max(Number(searchParams.get('page')) || 0, 0)
  const limit = Math.min(Number(searchParams.get('limit')) || PAGE, MAX_PAGE)

  // The Super Admin may look at any block, or all of them at once. An
  // entry account sees its own block and only its own — the request does
  // not get a say, because the account is what decides.
  const blockId =
    session.role === 'super' ? (searchParams.get('block_id') ?? '') : (session.blockId ?? '')

  if (!blockId && session.role !== 'super') {
    return NextResponse.json({ error: 'This account has no block' }, { status: 400 })
  }

  let query = supabaseAdmin
    .from('vehicles')
    .select(SELECT, { count: 'exact' })
    .range(page * limit, page * limit + limit - 1)

  if (blockId) query = query.eq('block_id', blockId)

  // Newest first. Within one block the entry number *is* the arrival
  // order, and reads better than a timestamp; across blocks it means
  // nothing, so time is the only sensible ordering there.
  query = blockId
    ? query.order('entry_no', { ascending: false })
    : query.order('entered_at', { ascending: false })

  // Finding one entry among hundreds: its number, its plate, or a phone.
  // Values are stripped to letters and digits before they go anywhere
  // near the filter string, which is comma-separated and would otherwise
  // be splittable from outside.
  const term = q.trim()
  if (term) {
    const reg = term.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
    const digits = term.replace(/[^0-9]/g, '')
    const name = term.replace(/[^a-zA-Z ]/g, '').trim()

    const ors: string[] = []
    if (reg.length >= 2) ors.push(`reg_no.ilike.*${reg}*`)
    if (digits && digits.length <= 6) ors.push(`entry_no.eq.${Number(digits)}`)
    if (digits.length >= 4) ors.push(`owner_phone.ilike.*${digits}*`)
    if (name.length >= 2) ors.push(`owner_name.ilike.*${name}*`)

    if (ors.length === 0) {
      return NextResponse.json({ entries: [], total: 0, page, limit })
    }
    query = query.or(ors.join(','))
  }

  const { data, error, count } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Flatten the joined block name — the screen wants a string, not a
  // nested object it has to unwrap in three places.
  const entries = (data ?? []).map((r) => {
    const { blocks, ...rest } = r as typeof r & { blocks: { name: string } | null }
    return { ...rest, block_name: blocks?.name ?? '' }
  })

  return NextResponse.json({
    entries,
    total: count ?? entries.length,
    page,
    limit,
    can_delete: session.role === 'super',
  })
}
