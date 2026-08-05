'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

type Entry = {
  id: string
  entry_no: number | null
  reg_no_display: string
  owner_name: string | null
  owner_phone: string | null
  village: string | null
  taluka: string | null
  landmark: string | null
  entered_at: string
  updated_at: string | null
  block_id: string
  block_name: string
}

type Block = { id: string; name: string }

const PAGE = 100
// Every block at once — Super Admin only, and never the default, because
// "my block" is what a block admin came here for.
const ALL = '__all__'

/**
 * @param fixedBlockId the block this account is tied to, from the signed
 *   session. Null for the Super Admin, who may look at any of them.
 */
export default function EntriesClient({
  isSuper,
  fixedBlockId,
}: {
  isSuper: boolean
  fixedBlockId: string | null
}) {
  const [blocks, setBlocks] = useState<Block[]>([])
  const [blockId, setBlockId] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  const [entries, setEntries] = useState<Entry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [open, setOpen] = useState<Entry | null>(null)

  // --- Which block is this account looking at --------------------------
  // The account decides, not the device. The server enforces the same
  // thing regardless, so this only keeps the screen honest about it.
  useEffect(() => {
    setBlockId(fixedBlockId ?? (isSuper ? ALL : null))
    setReady(true)

    fetch('/api/blocks')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setBlocks(j.blocks ?? []))
      .catch(() => setError('Could not load the block list'))
  }, [isSuper, fixedBlockId])

  // --- Load a page -----------------------------------------------------
  const load = useCallback(
    async (nextPage: number, replace: boolean) => {
      if (!blockId) return
      setLoading(true)
      setError('')
      try {
        const params = new URLSearchParams({ page: String(nextPage), limit: String(PAGE) })
        if (blockId !== ALL) params.set('block_id', blockId)
        if (q.trim()) params.set('q', q.trim())

        const res = await fetch(`/api/entries?${params}`)
        const json = await res.json()
        if (!res.ok) {
          setError(json.error ?? 'Could not load the entries')
          return
        }
        setEntries((prev) => (replace ? json.entries : [...prev, ...json.entries]))
        setTotal(json.total ?? 0)
        setPage(nextPage)
      } catch {
        setError('Network problem — please try again')
      } finally {
        setLoading(false)
      }
    },
    [blockId, q],
  )

  // Reload from the top whenever the block or the search term changes.
  // The search waits a moment so it does not fire on every keystroke.
  useEffect(() => {
    if (!ready || !blockId) return
    const timer = setTimeout(() => load(0, true), q ? 300 : 0)
    return () => clearTimeout(timer)
  }, [ready, blockId, q, load])

  function afterChange(updated: Entry | null, id: string) {
    setEntries((prev) =>
      updated ? prev.map((e) => (e.id === id ? { ...e, ...updated } : e)) : prev.filter((e) => e.id !== id),
    )
    if (!updated) setTotal((t) => Math.max(t - 1, 0))
    setOpen(null)
  }

  // --- An account with no block ----------------------------------------
  // Should not happen: an entry account cannot be created without one.
  // Worth saying plainly rather than showing an empty list if it does.
  if (ready && !blockId) {
    return (
      <main className="mx-auto max-w-lg p-5">
        <h1 className="text-2xl font-bold">My Entries</h1>
        <p className="mt-4 rounded-xl bg-amber-50 px-4 py-4 text-amber-800">
          No block is assigned to your account. Ask the Super Admin to set one.
        </p>
        <Link href="/" className="mt-6 block text-center text-slate-500">
          ← Back to Home
        </Link>
      </main>
    )
  }

  const blockName = blocks.find((b) => b.id === blockId)?.name
  const shown = entries.length
  const more = shown < total

  return (
    <main className="mx-auto max-w-lg pb-24">
      <div className="sticky top-0 z-10 bg-slate-900 px-5 py-4 text-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="rounded-lg border border-white/30 px-3 py-1.5 text-sm" aria-label="Home">
              ←
            </Link>
            <h1 className="text-xl font-bold">{isSuper ? 'All Entries' : 'My Entries'}</h1>
          </div>
          <span className="text-sm text-white/70">{total} total</span>
        </div>

        {/* The Super Admin picks a block; a block admin only ever sees
            the one their phone is set to, so there is nothing to pick. */}
        {isSuper ? (
          <select
            value={blockId ?? ALL}
            onChange={(e) => setBlockId(e.target.value)}
            className="mt-3 w-full rounded-xl bg-white px-4 py-3 text-lg font-medium text-slate-900 outline-none"
          >
            <option value={ALL}>All blocks</option>
            {blocks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        ) : (
          blockName && (
            <div className="mt-3 rounded-xl bg-white/10 px-4 py-3">
              <div className="text-xs uppercase tracking-wider text-white/60">Block</div>
              <div className="text-2xl font-bold leading-tight">{blockName}</div>
            </div>
          )
        )}

        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Entry no. / Vehicle no. / Name"
          autoComplete="off"
          className="mt-3 w-full rounded-xl bg-white px-4 py-3 text-lg text-slate-900 outline-none"
        />

        {isSuper && (
          <a
            href={`/api/export${blockId && blockId !== ALL ? `?block_id=${blockId}` : ''}`}
            className="mt-3 block rounded-xl border border-white/30 py-3 text-center text-sm font-medium"
          >
            ⬇ Download CSV{blockId && blockId !== ALL ? ` — ${blockName}` : ' — all blocks'}
          </a>
        )}
      </div>

      <div className="px-5 pt-4">
        {error && (
          <p className="mb-4 rounded-xl bg-red-50 px-4 py-4 text-center font-medium text-red-700">
            {error}
          </p>
        )}

        {!loading && entries.length === 0 && !error && (
          <p className="py-10 text-center text-slate-500">
            {q ? 'Nothing matched that' : 'No entries in this block yet'}
          </p>
        )}

        <div className="divide-y divide-slate-200 overflow-hidden rounded-2xl bg-white">
          {entries.map((e) => (
            <button
              key={e.id}
              onClick={() => setOpen(e)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-slate-50"
            >
              <span className="min-w-11 rounded-md bg-blue-100 px-2 py-1 text-center font-mono text-sm font-bold text-blue-800">
                #{e.entry_no ?? '–'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-mono font-bold">{e.reg_no_display}</span>
                <span className="block truncate text-sm text-slate-500">
                  {[e.owner_name, e.village, e.landmark].filter(Boolean).join(' · ') || '—'}
                </span>
              </span>
              <span className="shrink-0 text-right text-sm text-slate-400">
                {blockId === ALL && <span className="block font-bold text-slate-600">{e.block_name}</span>}
                {timeOf(e.entered_at)}
                {e.updated_at && <span className="block text-xs text-amber-600">edited</span>}
              </span>
            </button>
          ))}
        </div>

        {loading && <p className="py-6 text-center text-slate-400">Loading…</p>}

        {more && !loading && (
          <button
            onClick={() => load(page + 1, false)}
            className="mt-4 w-full rounded-xl border-2 border-slate-300 bg-white py-4 font-medium text-slate-600"
          >
            Load {Math.min(PAGE, total - shown)} more
          </button>
        )}

        <Link href="/" className="mt-8 block text-center text-slate-500">
          ← Back to Home
        </Link>
      </div>

      {open && (
        <EntrySheet
          entry={open}
          canDelete={isSuper}
          onClose={() => setOpen(null)}
          onChanged={afterChange}
        />
      )}
    </main>
  )
}

function timeOf(ts: string) {
  return new Date(ts).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}

// ============================================================
//  The edit sheet
//
//  Saving happens in two taps, never one. The list is hundreds of rows of
//  near-identical vehicle numbers, and an edit made on the wrong one is
//  invisible afterwards — so the second tap spells out what is about to
//  change, field by field.
// ============================================================

type Draft = {
  reg_no_display: string
  owner_name: string
  owner_phone: string
  village: string
  taluka: string
  landmark: string
}

const FIELDS: { key: keyof Draft; label: string; mono?: boolean; numeric?: boolean }[] = [
  { key: 'reg_no_display', label: 'Vehicle number', mono: true },
  { key: 'owner_name', label: 'Name' },
  { key: 'owner_phone', label: 'Mobile', numeric: true },
  { key: 'village', label: 'Village' },
  { key: 'taluka', label: 'Taluka' },
  { key: 'landmark', label: 'Landmark' },
]

function EntrySheet({
  entry,
  canDelete,
  onClose,
  onChanged,
}: {
  entry: Entry
  canDelete: boolean
  onClose: () => void
  onChanged: (updated: Entry | null, id: string) => void
}) {
  const [draft, setDraft] = useState<Draft>({
    reg_no_display: entry.reg_no_display ?? '',
    owner_name: entry.owner_name ?? '',
    owner_phone: entry.owner_phone ?? '',
    village: entry.village ?? '',
    taluka: entry.taluka ?? '',
    landmark: entry.landmark ?? '',
  })
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [typedReg, setTypedReg] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Only what actually differs is shown on the confirm step. A list that
  // repeats every unchanged field back would bury the one line that matters.
  const changes = FIELDS.map((f) => ({
    ...f,
    from: entry[f.key] ?? '',
    to: draft[f.key].trim(),
  })).filter((c) => c.from !== c.to)

  async function save() {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/vehicles/${entry.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // No block is sent. Which block this account may touch comes
          // from its signed session on the server, and an entry belonging
          // to another block is refused there — the browser has no say.
          reg_no: draft.reg_no_display,
          owner_name: draft.owner_name,
          owner_phone: draft.owner_phone,
          village: draft.village,
          taluka: draft.taluka,
          landmark: draft.landmark,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Could not save the change')
        setConfirming(false)
        return
      }
      onChanged({ ...entry, ...json.vehicle }, entry.id)
    } catch {
      setError('Network problem — the change was not saved')
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/vehicles/${entry.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: typedReg }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Could not delete the entry')
        return
      }
      onChanged(null, entry.id)
    } catch {
      setError('Network problem — the entry was not deleted')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex flex-col bg-black/50" onClick={onClose}>
      <div
        className="mt-auto max-h-[92vh] overflow-y-auto rounded-t-3xl bg-slate-50 p-5"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="text-sm text-slate-500">
              {entry.block_name} · Entry #{entry.entry_no ?? '–'}
            </div>
            <div className="font-mono text-2xl font-bold">{entry.reg_no_display}</div>
            <div className="mt-1 text-sm text-slate-500">
              Entered {new Date(entry.entered_at).toLocaleString('en-IN', { hour12: true })}
              {entry.updated_at && ' · edited since'}
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg border border-slate-300 bg-white px-3 py-2">
            ✕
          </button>
        </div>

        {error && (
          <p className="mb-4 rounded-xl bg-red-50 px-4 py-3 font-medium text-red-700">{error}</p>
        )}

        {/* --- Step 2: what is about to change ------------------------ */}
        {confirming ? (
          <div>
            <p className="mb-3 font-bold text-slate-700">Save these changes?</p>
            <div className="space-y-2 rounded-2xl bg-white p-4">
              {changes.map((c) => (
                <div key={c.key} className="text-sm">
                  <div className="text-slate-500">{c.label}</div>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-slate-400 line-through">{c.from || '(empty)'}</span>
                    <span>→</span>
                    <span className="font-bold text-slate-900">{c.to || '(empty)'}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <button
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="rounded-2xl border-2 border-slate-300 bg-white py-4 font-bold text-slate-600"
              >
                Go back
              </button>
              <button
                onClick={save}
                disabled={busy}
                className="rounded-2xl bg-blue-600 py-4 font-bold text-white disabled:bg-slate-400"
              >
                {busy ? 'Saving…' : 'Yes, save'}
              </button>
            </div>
          </div>
        ) : deleting ? (
          /* --- Deleting: the number has to be typed back ------------- */
          <div>
            <p className="mb-2 font-bold text-red-800">Delete this entry?</p>
            <p className="mb-3 text-sm text-slate-600">
              The entry is removed from the count and from search. A copy is kept in the
              database, so it can be recovered if this turns out to be the wrong one — but
              nobody will find the vehicle through the app any more.
            </p>
            <p className="mb-2 text-sm text-slate-600">
              Type <span className="font-mono font-bold">{entry.reg_no_display}</span> to confirm:
            </p>
            <input
              value={typedReg}
              onChange={(ev) => setTypedReg(ev.target.value.toUpperCase())}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="w-full rounded-xl border-2 border-red-300 bg-white px-4 py-4 text-center font-mono text-xl font-bold outline-none focus:border-red-600"
            />
            <div className="mt-4 grid grid-cols-2 gap-3">
              <button
                onClick={() => {
                  setDeleting(false)
                  setTypedReg('')
                }}
                disabled={busy}
                className="rounded-2xl border-2 border-slate-300 bg-white py-4 font-bold text-slate-600"
              >
                Keep it
              </button>
              <button
                onClick={remove}
                disabled={busy || !typedReg}
                className="rounded-2xl bg-red-600 py-4 font-bold text-white disabled:bg-slate-300"
              >
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        ) : (
          /* --- Step 1: the form -------------------------------------- */
          <div>
            <div className="space-y-3">
              {FIELDS.map((f) => (
                <label key={f.key} className="block">
                  <span className="mb-1 block text-sm font-medium text-slate-500">{f.label}</span>
                  <input
                    value={draft[f.key]}
                    onChange={(ev) =>
                      setDraft((d) => ({
                        ...d,
                        [f.key]: f.mono ? ev.target.value.toUpperCase() : ev.target.value,
                      }))
                    }
                    inputMode={f.numeric ? 'numeric' : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    className={`w-full rounded-xl border-2 border-slate-300 bg-white px-4 py-3 text-lg outline-none focus:border-blue-600 ${
                      f.mono ? 'font-mono font-bold' : ''
                    }`}
                  />
                </label>
              ))}
            </div>

            <button
              onClick={() => setConfirming(true)}
              disabled={changes.length === 0}
              className="mt-4 w-full rounded-2xl bg-blue-600 py-5 text-xl font-bold text-white disabled:bg-slate-300"
            >
              {changes.length === 0 ? 'Nothing changed' : `Save ${changes.length} change${changes.length > 1 ? 's' : ''}`}
            </button>

            {canDelete && (
              <button
                onClick={() => setDeleting(true)}
                className="mt-3 w-full rounded-2xl border-2 border-red-300 bg-white py-4 font-bold text-red-700"
              >
                Delete this entry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
