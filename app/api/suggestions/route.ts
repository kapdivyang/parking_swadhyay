import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getSession } from '@/lib/auth'

// Everything anybody has already typed into village, taluka, landmark or
// vehicle type, most-used first.
//
// Two jobs, and the second is the one that pays for the endpoint:
//   - one spelling per place, so "Sihor", "sihore" and "Shihor" do not
//     become three villages and a village search find a third of the cars
//   - almost no typing. On a phone, four letters and a tap beats twelve
//     letters every time, and every entry on the day is made on a phone.
//
// Replaces /api/villages, which only covered two of the four fields.

export const dynamic = 'force-dynamic'

type Row = { field: string; value: string; pair: string | null; uses: number }

const FIELDS = ['village', 'taluka', 'landmark', 'vehicle_type'] as const
type Field = (typeof FIELDS)[number]

export async function GET() {
  if (!(await getSession())) {
    return NextResponse.json({ error: 'Please log in' }, { status: 401 })
  }

  const { data, error } = await supabaseAdmin.rpc('entry_suggestions')
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Grouped by field here rather than on the phone: the phone would have to
  // do it on every render otherwise, and the wire shape is the contract the
  // client caches to localStorage anyway.
  const out = Object.fromEntries(FIELDS.map((f) => [f, [] as unknown[]])) as Record<
    Field,
    { value: string; pair?: string | null; uses: number }[]
  >

  for (const r of (data ?? []) as Row[]) {
    const bucket = out[r.field as Field]
    if (!bucket) continue // a field added to the function but not here yet
    bucket.push(
      r.pair ? { value: r.value, pair: r.pair, uses: Number(r.uses) } : { value: r.value, uses: Number(r.uses) },
    )
  }

  return NextResponse.json(
    { suggestions: out },
    // The list changes with every entry made anywhere. A cached copy would
    // hold back exactly the village that was just added — which is the one
    // the next operator is about to type.
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
