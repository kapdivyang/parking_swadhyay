import { cookies, headers } from 'next/headers'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { supabaseAdmin } from '@/lib/supabase'

export type Role = 'entry' | 'search' | 'super'

export type Session = {
  role: Role
  // Null for the Super Admin, who signs in with the PIN held in the
  // environment rather than with an account in the table. That is
  // deliberate: an account can be disabled, and locking the only person
  // who can re-enable accounts out of the system is not recoverable.
  userId: string | null
  name: string
  // The one block an entry account may write to. Null for search and
  // super. This is the whole point of the session carrying it: the
  // browser can no longer claim a block it was not given.
  blockId: string | null
}

const COOKIE = 'parking_session'
const MAX_AGE = 60 * 60 * 24 * 3 // 3 days — covers the whole event window

// Bumped when the cookie's shape changes. Old cookies then fail to parse
// and everybody signs in again, which is exactly what should happen when
// the meaning of a session changes.
const VERSION = 'v2'

// --- Rate limiting -----------------------------------------------------
// Per IP, because an attacker guessing PINs simply tries the next one;
// limiting per PIN would not slow that down at all.
const WINDOW_MINUTES = 15
const MAX_FAILURES = 10

function secret(): string {
  return process.env.SUPABASE_SECRET_KEY || 'dev-only-fallback'
}

// Sign the cookie so nobody can hand themselves the "super" role — or,
// now, somebody else's block.
function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

function superPin(): string {
  return process.env.SUPER_ADMIN_PIN ?? ''
}

// ============================================================
//  Signing in
// ============================================================

export type LoginResult =
  | { ok: true; session: Session }
  | { ok: false; error: string; status: number }

export async function attemptLogin(rawPin: string, ip: string): Promise<LoginResult> {
  const pin = rawPin.trim()

  if (await tooManyFailures(ip)) {
    return {
      ok: false,
      status: 429,
      error: `Too many wrong PINs. Wait ${WINDOW_MINUTES} minutes and try again.`,
    }
  }

  // Super first — if the same PIN were ever set in both places, the more
  // powerful role is the safer one to resolve to.
  const sp = superPin()
  if (sp && safeEqual(pin, sp)) {
    await recordAttempt(ip, true)
    return {
      ok: true,
      session: { role: 'super', userId: null, name: 'Super Admin', blockId: null },
    }
  }

  // Digits only ever reach the query, so the PIN cannot carry a filter
  // expression into it.
  const clean = pin.replace(/\D/g, '')
  if (!clean) {
    await recordAttempt(ip, false)
    return { ok: false, status: 401, error: 'Incorrect PIN' }
  }

  const { data: user } = await supabaseAdmin
    .from('app_users')
    .select('id, name, role, block_id, is_active')
    .eq('pin', clean)
    .maybeSingle()

  if (!user) {
    await recordAttempt(ip, false)
    return { ok: false, status: 401, error: 'Incorrect PIN' }
  }

  // A disabled account is told so plainly. "Incorrect PIN" would send the
  // volunteer to find a supervisor to re-read them a PIN that is correct.
  if (!user.is_active) {
    await recordAttempt(ip, false)
    return {
      ok: false,
      status: 403,
      error: 'This account has been turned off. Ask the Super Admin.',
    }
  }

  await recordAttempt(ip, true)
  await supabaseAdmin
    .from('app_users')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', user.id)

  return {
    ok: true,
    session: {
      role: user.role as Role,
      userId: user.id as string,
      name: user.name as string,
      blockId: (user.block_id as string | null) ?? null,
    },
  }
}

async function tooManyFailures(ip: string): Promise<boolean> {
  if (!ip) return false
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString()
  const { count } = await supabaseAdmin
    .from('login_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('ip', ip)
    .eq('succeeded', false)
    .gte('at', since)
  return (count ?? 0) >= MAX_FAILURES
}

async function recordAttempt(ip: string, succeeded: boolean) {
  if (!ip) return
  await supabaseAdmin.from('login_attempts').insert({ ip, succeeded })
  // Cheap, and only on a path taken a few dozen times a day
  if (!succeeded) await supabaseAdmin.rpc('prune_login_attempts')
}

/** The caller's IP, as far as the proxy in front of us reports it. */
export async function callerIp(): Promise<string> {
  const h = await headers()
  const fwd = h.get('x-forwarded-for') ?? ''
  return (fwd.split(',')[0] || h.get('x-real-ip') || '').trim()
}

// ============================================================
//  The cookie
// ============================================================

export async function createSession(session: Session) {
  const issued = Date.now().toString()
  // Fields are joined with a character that cannot appear in any of them:
  // ids and roles are hex and lowercase words, names never reach here.
  const payload = [
    VERSION,
    session.role,
    session.userId ?? '-',
    session.blockId ?? '-',
    issued,
  ].join('.')
  const value = `${payload}.${sign(payload)}`

  const store = await cookies()
  store.set(COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE,
    path: '/',
  })
}

/**
 * The signed-in user, or null.
 *
 * For an account-backed session this re-reads the account on every call.
 * That is the cost of "disable takes effect now": a signed cookie alone
 * would keep working for three days after the Super Admin switched the
 * account off, which would make the switch decorative.
 */
export async function getSession(): Promise<Session | null> {
  const store = await cookies()
  const raw = store.get(COOKIE)?.value
  if (!raw) return null

  const parts = raw.split('.')
  if (parts.length !== 6) return null // including anything signed before v2

  const [version, role, userId, blockId, issued, sig] = parts
  if (version !== VERSION) return null
  if (!safeEqual(sig, sign(`${version}.${role}.${userId}.${blockId}.${issued}`))) return null

  const age = Date.now() - Number(issued)
  if (!Number.isFinite(age) || age > MAX_AGE * 1000) return null
  if (role !== 'entry' && role !== 'search' && role !== 'super') return null

  if (role === 'super') {
    // Still gated on the environment PIN existing. Clearing it in Vercel
    // revokes every super session immediately.
    if (!superPin()) return null
    return { role, userId: null, name: 'Super Admin', blockId: null }
  }

  if (userId === '-') return null

  const { data: user } = await supabaseAdmin
    .from('app_users')
    .select('id, name, role, block_id, is_active')
    .eq('id', userId)
    .maybeSingle()

  // Deleted, disabled, or changed underneath the cookie — in every case
  // the cookie stops being worth anything from this request onward.
  if (!user || !user.is_active) return null
  if (user.role !== role) return null
  if ((user.block_id ?? '-') !== blockId) return null

  return {
    role,
    userId: user.id as string,
    name: user.name as string,
    blockId: (user.block_id as string | null) ?? null,
  }
}

export async function clearSession() {
  const store = await cookies()
  store.delete(COOKIE)
}

// --- Guards used by the API routes -------------------------------------

/** Any signed-in user. Throws when there is none. */
export async function requireSession(): Promise<Session> {
  const s = await getSession()
  if (!s) throw new Error('UNAUTHORIZED')
  return s
}

/** True when this session may create or change vehicle entries at all. */
export function canWrite(s: Session | null): boolean {
  return s?.role === 'entry' || s?.role === 'super'
}

/**
 * Which block this session may write to, given the one it is asking about.
 *
 * An entry account is pinned to its own block and the request's opinion is
 * ignored. The Super Admin may act on any block. Anyone else may not write
 * at all.
 */
export function blockForWrite(s: Session | null, requested: string | null): string | null {
  if (!s) return null
  if (s.role === 'super') return requested
  if (s.role === 'entry') return s.blockId
  return null
}
