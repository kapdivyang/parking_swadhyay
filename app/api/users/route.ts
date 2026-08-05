import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getSession } from '@/lib/auth'
import { USER_SELECT, flattenUser, flattenUsers, validateUser } from '@/lib/users'

// User accounts — Super Admin only, all of it.
//
// The PIN is returned to the Super Admin on purpose. On the day, "I have
// forgotten my PIN" has to be answerable in seconds, by the one person
// already trusted with every PIN in the system. It goes nowhere else:
// no other role can reach this route at all.

export async function GET() {
  if ((await getSession())?.role !== 'super') {
    return NextResponse.json({ error: 'Super Admin only' }, { status: 403 })
  }

  const { data, error } = await supabaseAdmin
    .from('app_users')
    .select(USER_SELECT)
    .order('role')
    .order('name')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ users: flattenUsers(data ?? []) })
}

export async function POST(req: Request) {
  if ((await getSession())?.role !== 'super') {
    return NextResponse.json({ error: 'Super Admin only' }, { status: 403 })
  }

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  const checked = await validateUser(body, null)
  if ('error' in checked) {
    return NextResponse.json({ error: checked.error }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('app_users')
    .insert(checked.row)
    .select(USER_SELECT)
    .single()

  if (error) {
    const msg =
      error.code === '23505' ? 'That PIN is already used by another account' : error.message
    return NextResponse.json({ error: msg }, { status: 400 })
  }
  return NextResponse.json({ user: flattenUser(data) })
}
