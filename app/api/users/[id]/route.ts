import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getSession } from '@/lib/auth'
import { USER_SELECT, flattenUser, validateUser } from '@/lib/users'

type Ctx = { params: Promise<{ id: string }> }

// PATCH — rename, re-PIN, move to another block, or turn the account
// off. Turning it off takes effect on that account's very next request:
// getSession() re-reads the row rather than trusting the cookie alone.
export async function PATCH(req: Request, { params }: Ctx) {
  if ((await getSession())?.role !== 'super') {
    return NextResponse.json({ error: 'Super Admin only' }, { status: 403 })
  }

  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  const { data: existing } = await supabaseAdmin
    .from('app_users')
    .select('id, role')
    .eq('id', id)
    .maybeSingle()

  if (!existing) {
    return NextResponse.json({ error: 'That account no longer exists' }, { status: 404 })
  }

  const checked = await validateUser(body, existing.role as string)
  if ('error' in checked) {
    return NextResponse.json({ error: checked.error }, { status: 400 })
  }
  if (Object.keys(checked.row).length === 0) {
    return NextResponse.json({ error: 'Nothing to change' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('app_users')
    .update(checked.row)
    .eq('id', id)
    .select(USER_SELECT)
    .single()

  if (error) {
    const msg =
      error.code === '23505'
        ? 'That PIN is already used by another account'
        : error.message
    return NextResponse.json({ error: msg }, { status: 400 })
  }
  return NextResponse.json({ user: flattenUser(data) })
}

// DELETE — remove the account entirely.
//
// Turning an account off is almost always the better move: it stops the
// person immediately and keeps the record of who they were. Deleting is
// for an account created by mistake. Entries they made are kept either
// way; the entry simply stops naming an account.
export async function DELETE(req: Request, { params }: Ctx) {
  if ((await getSession())?.role !== 'super') {
    return NextResponse.json({ error: 'Super Admin only' }, { status: 403 })
  }

  const { id } = await params
  const body = await req.json().catch(() => null)

  const { data: user } = await supabaseAdmin
    .from('app_users')
    .select('id, name')
    .eq('id', id)
    .maybeSingle()

  if (!user) {
    return NextResponse.json({ error: 'That account no longer exists' }, { status: 404 })
  }

  // The name has to be typed back. The list is a column of near-identical
  // rows, and deleting the wrong one is invisible afterwards.
  if (String(body?.confirm ?? '').trim().toLowerCase() !== String(user.name).toLowerCase()) {
    return NextResponse.json(
      { error: `Type "${user.name}" exactly to confirm` },
      { status: 400 },
    )
  }

  const { count } = await supabaseAdmin
    .from('vehicles')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', id)

  const { error } = await supabaseAdmin.from('app_users').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ ok: true, entries_kept: count ?? 0 })
}
