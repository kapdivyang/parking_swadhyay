'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

type User = {
  id: string
  name: string
  pin: string
  role: 'entry' | 'search'
  block_id: string | null
  block_name: string | null
  is_active: boolean
  created_at: string
  last_login_at: string | null
}

type Block = { id: string; name: string }

type Draft = {
  name: string
  pin: string
  role: 'entry' | 'search'
  block_id: string
}

const EMPTY: Draft = { name: '', pin: '', role: 'entry', block_id: '' }

export default function UsersClient() {
  const [users, setUsers] = useState<User[]>([])
  const [blocks, setBlocks] = useState<Block[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [editing, setEditing] = useState<User | null>(null)
  const [busy, setBusy] = useState(false)
  const [showPins, setShowPins] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [u, b] = await Promise.all([
        fetch('/api/users').then((r) => r.json()),
        fetch('/api/blocks').then((r) => r.json()),
      ])
      if (u.error) setError(u.error)
      else {
        setUsers(u.users ?? [])
        setError('')
      }
      setBlocks(b.blocks ?? [])
    } catch {
      setError('Could not load the accounts')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // A PIN nobody else has. Suggested rather than imposed, so a supervisor
  // who wants memorable numbers for their own team can still choose them.
  function suggestPin() {
    const taken = new Set(users.map((u) => u.pin))
    for (let i = 0; i < 200; i++) {
      const pin = String(Math.floor(100000 + Math.random() * 900000))
      if (!taken.has(pin)) return pin
    }
    return ''
  }

  async function save() {
    setBusy(true)
    setError('')
    try {
      const url = editing ? `/api/users/${editing.id}` : '/api/users'
      const res = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draft.name,
          pin: draft.pin,
          role: draft.role,
          block_id: draft.role === 'entry' ? draft.block_id : null,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Could not save')
        return
      }
      setCreating(false)
      setEditing(null)
      setDraft(EMPTY)
      await load()
    } catch {
      setError('Network problem — nothing was saved')
    } finally {
      setBusy(false)
    }
  }

  // The switch this whole screen exists for. It takes effect on that
  // account's next request, not at its next login.
  async function toggle(u: User) {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/users/${u.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !u.is_active }),
      })
      const json = await res.json()
      if (!res.ok) setError(json.error ?? 'Could not change the account')
      else await load()
    } catch {
      setError('Network problem — nothing changed')
    } finally {
      setBusy(false)
    }
  }

  async function remove(u: User) {
    const typed = window.prompt(
      `Deleting removes the account for good. Turning it off instead stops it just as fast and keeps the record.\n\nType "${u.name}" to delete:`,
    )
    if (typed == null) return

    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/users/${u.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: typed }),
      })
      const json = await res.json()
      if (!res.ok) setError(json.error ?? 'Could not delete')
      else await load()
    } catch {
      setError('Network problem — nothing was deleted')
    } finally {
      setBusy(false)
    }
  }

  function startEdit(u: User) {
    setEditing(u)
    setCreating(false)
    setDraft({ name: u.name, pin: u.pin, role: u.role, block_id: u.block_id ?? '' })
  }

  function startCreate() {
    setEditing(null)
    setCreating(true)
    setDraft({ ...EMPTY, pin: suggestPin(), block_id: blocks[0]?.id ?? '' })
  }

  const entryUsers = users.filter((u) => u.role === 'entry')
  const searchUsers = users.filter((u) => u.role === 'search')
  const blocksWithout = blocks.filter((b) => !entryUsers.some((u) => u.block_id === b.id))

  return (
    <main className="mx-auto max-w-lg pb-24">
      <div className="sticky top-0 z-10 bg-rose-800 px-5 py-4 text-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="rounded-lg border border-white/30 px-3 py-1.5 text-sm">
              ←
            </Link>
            <h1 className="text-xl font-bold">Manage Users</h1>
          </div>
          <span className="text-sm text-white/70">{users.length} accounts</span>
        </div>
      </div>

      <div className="px-5 pt-4">
        {error && (
          <p className="mb-4 rounded-xl bg-red-50 px-4 py-3 font-medium text-red-700">{error}</p>
        )}

        {!creating && !editing && (
          <button
            onClick={startCreate}
            className="w-full rounded-2xl bg-rose-700 py-5 text-xl font-bold text-white active:bg-rose-800"
          >
            + New account
          </button>
        )}

        {(creating || editing) && (
          <div className="rounded-2xl border-2 border-rose-200 bg-white p-4">
            <div className="mb-3 font-bold text-slate-700">
              {editing ? `Edit ${editing.name}` : 'New account'}
            </div>

            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-500">Name</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Ramesh — P5 gate"
                autoComplete="off"
                className="w-full rounded-xl border-2 border-slate-300 px-4 py-3 text-lg outline-none focus:border-rose-600"
              />
            </label>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-500">PIN</span>
                <input
                  value={draft.pin}
                  onChange={(e) => setDraft({ ...draft, pin: e.target.value.replace(/\D/g, '') })}
                  inputMode="numeric"
                  autoComplete="off"
                  className="w-full rounded-xl border-2 border-slate-300 px-4 py-3 text-center font-mono text-lg font-bold outline-none focus:border-rose-600"
                />
              </label>
              <button
                type="button"
                onClick={() => setDraft({ ...draft, pin: suggestPin() })}
                className="mt-6 rounded-xl border-2 border-slate-300 py-3 font-medium text-slate-600"
              >
                Suggest
              </button>
            </div>

            <div className="mt-3">
              <span className="mb-1 block text-sm font-medium text-slate-500">Can do</span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, role: 'entry' })}
                  className={`rounded-xl border-2 px-3 py-3 text-left ${
                    draft.role === 'entry'
                      ? 'border-rose-600 bg-rose-50'
                      : 'border-slate-300 bg-white'
                  }`}
                >
                  <div className="font-bold">Entry</div>
                  <div className="text-xs text-slate-500">Enter and correct, one block</div>
                </button>
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, role: 'search' })}
                  className={`rounded-xl border-2 px-3 py-3 text-left ${
                    draft.role === 'search'
                      ? 'border-rose-600 bg-rose-50'
                      : 'border-slate-300 bg-white'
                  }`}
                >
                  <div className="font-bold">View only</div>
                  <div className="text-xs text-slate-500">Search only — help desk</div>
                </button>
              </div>
            </div>

            {draft.role === 'entry' && (
              <label className="mt-3 block">
                <span className="mb-1 block text-sm font-medium text-slate-500">Block</span>
                <select
                  value={draft.block_id}
                  onChange={(e) => setDraft({ ...draft, block_id: e.target.value })}
                  className="w-full rounded-xl border-2 border-slate-300 bg-white px-4 py-3 text-lg outline-none focus:border-rose-600"
                >
                  <option value="">Choose a block…</option>
                  {blocks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="mt-4 grid grid-cols-2 gap-3">
              <button
                onClick={() => {
                  setCreating(false)
                  setEditing(null)
                  setError('')
                }}
                disabled={busy}
                className="rounded-2xl border-2 border-slate-300 bg-white py-4 font-bold text-slate-600"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={busy}
                className="rounded-2xl bg-rose-700 py-4 font-bold text-white disabled:bg-slate-400"
              >
                {busy ? 'Saving…' : editing ? 'Save' : 'Create'}
              </button>
            </div>
          </div>
        )}

        {/* Every block should have somebody who can enter into it. Saying
            which do not is far more useful than making the Super Admin
            cross-check seventeen blocks against a list by eye. */}
        {!loading && blocksWithout.length > 0 && (
          <div className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <span className="font-bold">No account yet for:</span>{' '}
            {blocksWithout.map((b) => b.name).join(', ')}
          </div>
        )}

        {loading ? (
          <p className="py-10 text-center text-slate-400">Loading…</p>
        ) : (
          <>
            <div className="mt-6 mb-2 flex items-baseline justify-between">
              <span className="text-sm font-medium text-slate-500">
                Entry accounts ({entryUsers.length})
              </span>
              <button onClick={() => setShowPins((s) => !s)} className="text-sm text-blue-600">
                {showPins ? 'Hide PINs' : 'Show PINs'}
              </button>
            </div>
            <UserList
              users={entryUsers}
              showPins={showPins}
              busy={busy}
              onEdit={startEdit}
              onToggle={toggle}
              onRemove={remove}
              empty="No entry accounts yet"
            />

            <div className="mt-6 mb-2 text-sm font-medium text-slate-500">
              View-only accounts ({searchUsers.length})
            </div>
            <UserList
              users={searchUsers}
              showPins={showPins}
              busy={busy}
              onEdit={startEdit}
              onToggle={toggle}
              onRemove={remove}
              empty="No help-desk accounts yet"
            />
          </>
        )}

        <p className="mt-8 rounded-xl bg-slate-100 px-4 py-3 text-sm text-slate-600">
          The Super Admin PIN is not on this list. It lives in the server settings, so no
          account here can lock you out of your own system.
        </p>

        <Link href="/" className="mt-6 block text-center text-slate-500">
          ← Back to Home
        </Link>
      </div>
    </main>
  )
}

function UserList({
  users,
  showPins,
  busy,
  onEdit,
  onToggle,
  onRemove,
  empty,
}: {
  users: User[]
  showPins: boolean
  busy: boolean
  onEdit: (u: User) => void
  onToggle: (u: User) => void
  onRemove: (u: User) => void
  empty: string
}) {
  if (users.length === 0) {
    return <p className="rounded-xl bg-white px-4 py-4 text-center text-slate-400">{empty}</p>
  }

  return (
    <div className="divide-y divide-slate-200 overflow-hidden rounded-2xl bg-white">
      {users.map((u) => (
        <div key={u.id} className={`px-4 py-3 ${u.is_active ? '' : 'bg-slate-50'}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={`font-bold ${u.is_active ? '' : 'text-slate-400 line-through'}`}>
                  {u.name}
                </span>
                {!u.is_active && (
                  <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600">
                    off
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-sm text-slate-500">
                {u.block_name ?? 'All blocks · search only'}
                {' · '}
                <span className="font-mono">{showPins ? u.pin : '••••••'}</span>
              </div>
              <div className="mt-0.5 text-xs text-slate-400">
                {u.last_login_at
                  ? `Last used ${new Date(u.last_login_at).toLocaleString('en-IN', { hour12: true })}`
                  : 'Never signed in'}
              </div>
            </div>

            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <button
                onClick={() => onToggle(u)}
                disabled={busy}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  u.is_active
                    ? 'border border-amber-300 bg-amber-50 text-amber-800'
                    : 'bg-emerald-600 text-white'
                }`}
              >
                {u.is_active ? 'Turn off' : 'Turn on'}
              </button>
              <div className="flex gap-1.5">
                <button
                  onClick={() => onEdit(u)}
                  disabled={busy}
                  className="rounded-lg border border-slate-300 px-3 py-1 text-sm text-slate-600"
                >
                  Edit
                </button>
                <button
                  onClick={() => onRemove(u)}
                  disabled={busy}
                  className="rounded-lg border border-red-200 px-3 py-1 text-sm text-red-600"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
