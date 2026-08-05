import { supabaseAdmin } from '@/lib/supabase'

// What makes a valid account. Shared by create and edit so the two can
// never disagree — an account that could be edited into a shape it could
// not have been created in is a bug waiting for the day of the event.

const MIN_PIN = 4
const MAX_PIN = 8

export const USER_SELECT =
  'id, name, pin, role, block_id, is_active, created_at, last_login_at, blocks(name)'

type Joined = Record<string, unknown> & { blocks?: { name: string } | null }

/** Flatten the joined block name — screens want a string, not a nested object. */
export function flattenUser(row: unknown) {
  const { blocks, ...rest } = row as Joined
  return { ...rest, block_name: blocks?.name ?? null }
}

export function flattenUsers(rows: unknown[]) {
  return rows.map(flattenUser)
}

export type Validated = { row: Record<string, unknown> } | { error: string }

/**
 * @param existingRole the account's current role when editing, or null
 *                     when creating — which is what makes every field
 *                     required on create and optional on edit.
 */
export async function validateUser(
  body: Record<string, unknown>,
  existingRole: string | null,
): Promise<Validated> {
  const creating = existingRole === null
  const row: Record<string, unknown> = {}

  if (creating || body.name !== undefined) {
    const name = String(body.name ?? '').trim()
    if (!name) return { error: 'Name is required' }
    row.name = name
  }

  if (creating || body.pin !== undefined) {
    const pin = String(body.pin ?? '').replace(/\D/g, '')
    if (pin.length < MIN_PIN || pin.length > MAX_PIN) {
      return { error: `PIN must be ${MIN_PIN} to ${MAX_PIN} digits` }
    }
    // The Super Admin's PIN lives in the environment and login checks it
    // first. An account given the same digits would be unreachable — its
    // owner would silently sign in as Super Admin instead.
    if (pin === (process.env.SUPER_ADMIN_PIN ?? '').trim()) {
      return { error: 'That is the Super Admin PIN — choose another' }
    }
    row.pin = pin
  }

  const role = String(body.role ?? existingRole ?? '')
  if (creating || body.role !== undefined) {
    if (role !== 'entry' && role !== 'search') {
      return { error: 'Type must be either Entry or View only' }
    }
    row.role = role
  }

  // An entry account without a block could write nowhere; a help-desk
  // account with one would imply a restriction that does not exist.
  // Re-checked whenever the role moves, not only when the block is sent.
  if (creating || body.role !== undefined || body.block_id !== undefined) {
    if (role === 'entry') {
      const blockId = String(body.block_id ?? '')
      if (!blockId) return { error: 'Choose the block this person works in' }

      const { data: block } = await supabaseAdmin
        .from('blocks')
        .select('id')
        .eq('id', blockId)
        .maybeSingle()
      if (!block) return { error: 'That block no longer exists' }

      row.block_id = blockId
    } else {
      row.block_id = null
    }
  }

  if (body.is_active !== undefined) row.is_active = Boolean(body.is_active)

  return { row }
}
