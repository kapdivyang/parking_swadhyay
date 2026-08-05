import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getSession } from '@/lib/auth'

// The offline search snapshot.
//
// A search phone pulls the whole table once and afterwards only what has
// changed. At exit time it then answers from its own copy, which is the
// one thing that keeps working when a lakh of people are sitting on the
// same three cell towers.
//
// The wire format is arrays, not objects. Repeating twelve key names on
// a hundred thousand rows costs several megabytes of pure punctuation —
// over a congested 4G link that is the difference between a sync that
// finishes and one that does not.

export const dynamic = 'force-dynamic'

// PostgREST caps a response at 1000 rows whatever we ask for, so asking
// for more just wastes the round trip. Crucially, "is there another page?"
// must NOT be inferred from the row count reaching this number — it never
// does — which is why the exact count is requested alongside.
const PAGE = 1000
const MAX_PAGE = 1000

// Kept in step with COLS on the client. Order is the contract.
const COLS = ['b', 'n', 'reg', 'name', 'phone', 'village', 'taluka', 'landmark', 't', 'x']

type Row = {
  entry_no: number | null
  reg_no_display: string
  owner_name: string | null
  owner_phone: string | null
  village: string | null
  taluka: string | null
  landmark: string | null
  entered_at: string
  changed_at: string | null
  status: string
  block_id: string
}

export async function GET(req: Request) {
  if (!(await getSession())) {
    return NextResponse.json({ error: 'Please log in' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const since = searchParams.get('since') ?? ''
  // Deletions move on their own clock and need their own cursor. Sharing
  // the rows cursor means that on a quiet block — where changed_at stops
  // advancing because nothing is being entered — every past deletion is
  // resent on every poll, forever.
  const deletedSince = searchParams.get('deleted_since') ?? ''
  const limit = Math.min(Number(searchParams.get('limit')) || PAGE, MAX_PAGE)

  const [{ data: blocks, error: blockErr }, { data: epoch }] = await Promise.all([
    supabaseAdmin.from('blocks').select('id, name, landmark').order('id'),
    supabaseAdmin.rpc('data_epoch'),
  ])
  if (blockErr) {
    return NextResponse.json({ error: blockErr.message }, { status: 500 })
  }

  // The index a row carries is only meaningful inside this one response.
  // The phone resolves it to a real block before storing anything, so a
  // block created between two polls cannot shift what is already cached.
  const blockIdx = new Map((blocks ?? []).map((b, i) => [b.id as string, i]))

  let q = supabaseAdmin
    .from('vehicles')
    .select(
      'entry_no, reg_no_display, owner_name, owner_phone, village, taluka, landmark, entered_at, changed_at, status, block_id',
      // The count is of everything matching the filter, before the limit.
      // It is the only honest answer to "is there more after this page?"
      { count: 'exact' },
    )
    .order('changed_at', { ascending: true })
    .limit(limit)

  if (since) q = q.gt('changed_at', since)

  const { data, error, count } = await q
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (data ?? []) as Row[]

  const packed = rows.map((r) => [
    blockIdx.get(r.block_id) ?? -1,
    r.entry_no,
    r.reg_no_display,
    r.owner_name,
    r.owner_phone,
    r.village,
    r.taluka,
    r.landmark,
    // Epoch milliseconds, not an ISO string — a quarter of the bytes, and
    // the phone sorts on it without parsing anything.
    Date.parse(r.entered_at),
    r.status === 'parked' ? 0 : 1,
  ])

  // The newest deletion on record, whether or not any are being sent.
  // It is the phone's starting cursor after a full sync, and it comes
  // from the data rather than from this server's clock for the same
  // reason `until` does.
  const { data: newestGone } = await supabaseAdmin
    .from('vehicle_deletions')
    .select('deleted_at')
    .order('deleted_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const deletedUntil = (newestGone?.deleted_at as string | undefined) ?? deletedSince ?? null

  // Deletions only matter to a phone that already has a copy — on a first
  // full sync the rows fetched above are the truth by definition, and a
  // deleted vehicle simply is not among them.
  let deleted: [number, number][] = []
  if (deletedSince) {
    const { data: gone, error: goneErr } = await supabaseAdmin
      .from('vehicle_deletions')
      .select('vehicle, deleted_at')
      .gt('deleted_at', deletedSince)
      .order('deleted_at', { ascending: true })
      .limit(MAX_PAGE)

    if (goneErr) {
      return NextResponse.json({ error: goneErr.message }, { status: 500 })
    }
    deleted = (gone ?? [])
      .map((g) => {
        const v = g.vehicle as { block_id?: string; entry_no?: number } | null
        const idx = v?.block_id ? blockIdx.get(v.block_id) : undefined
        return idx == null || v?.entry_no == null ? null : ([idx, v.entry_no] as [number, number])
      })
      .filter((d): d is [number, number] => d !== null)
  }

  // Where the phone should resume from next time.
  //
  // This is always a timestamp that came out of the database, never
  // `new Date()`. The web server and Postgres do not share a clock, and
  // if the server's ran even a couple of seconds ahead, a cursor stamped
  // here would sit *after* the changed_at of rows written a moment later
  // — and those rows would be skipped for good. Rows are ordered
  // ascending, so the last one delivered is the high-water mark.
  //
  // With nothing to send, the cursor stands still rather than creeping
  // forward on a clock that is not the one doing the writing.
  const more = (count ?? rows.length) > rows.length
  const until = rows.length > 0 ? rows[rows.length - 1].changed_at : since || null

  return NextResponse.json(
    {
      // The id rides along because the phone keys its cache on it. Keying
      // on the name would orphan every cached row the moment a block was
      // renamed from /admin/blocks.
      blocks: (blocks ?? []).map((b) => ({ id: b.id, name: b.name, landmark: b.landmark })),
      cols: COLS,
      rows: packed,
      deleted,
      until,
      deletedUntil,
      more,
      epoch: epoch ?? null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
