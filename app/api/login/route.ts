import { NextResponse } from 'next/server'
import { attemptLogin, createSession, clearSession, callerIp } from '@/lib/auth'

export async function POST(req: Request) {
  const { pin } = await req.json().catch(() => ({ pin: '' }))

  const result = await attemptLogin(String(pin ?? ''), await callerIp())
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  await createSession(result.session)
  return NextResponse.json({
    ok: true,
    role: result.session.role,
    name: result.session.name,
  })
}

export async function DELETE() {
  await clearSession()
  return NextResponse.json({ ok: true })
}
