import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getSession } from '@/lib/auth'

// A vehicle number needs 3 characters before it is worth searching, but a
// village name is a whole word — 2 characters is enough to start narrowing.
const MIN_Q = 3
const MIN_PLACE = 2

// An entry number is short on purpose — "7" is a whole answer, and holding
// it back until three characters are typed would make the feature useless.
const ENTRY_NO = /^#?\s*[0-9]{1,6}$/

export async function GET(req: Request) {
  if (!(await getSession())) {
    return NextResponse.json({ error: 'Please log in' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') ?? '').trim()
  const village = (searchParams.get('village') ?? '').trim()
  const taluka = (searchParams.get('taluka') ?? '').trim()

  const isEntryNo = ENTRY_NO.test(q)

  // Any one field is enough to search on. Whatever else is filled in
  // simply narrows the result down further.
  const usable =
    isEntryNo || q.length >= MIN_Q || village.length >= MIN_PLACE || taluka.length >= MIN_PLACE

  if (!usable) {
    return NextResponse.json({
      results: [],
      hint: 'Type at least 3 characters of a number, 2 of a village / taluka, or an entry number',
    })
  }

  // A field below its minimum is ignored rather than used as a bad filter
  const { data, error } = await supabaseAdmin.rpc('search_vehicles', {
    q: isEntryNo || q.length >= MIN_Q ? q : '',
    village_q: village.length >= MIN_PLACE ? village : '',
    taluka_q: taluka.length >= MIN_PLACE ? taluka : '',
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    results: data ?? [],
    query: { q, village, taluka },
  })
}
