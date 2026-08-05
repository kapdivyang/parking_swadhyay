import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getSession } from '@/lib/auth'

// The villages already entered, so every phone suggests the same spellings.
// Without this, "Sihor", "sihore" and "Shihor" become three villages and a
// village search finds only a third of the vehicles.
export async function GET() {
  if (!(await getSession())) {
    return NextResponse.json({ error: 'Please log in' }, { status: 401 })
  }

  const { data, error } = await supabaseAdmin.rpc('village_suggestions')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ villages: data ?? [] })
}
