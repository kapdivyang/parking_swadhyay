'use client'

// Shared suggestions for the free-text fields — village, taluka, landmark
// and vehicle type.
//
// Why this exists at all: better than nine entries in ten are made on a
// phone, one-handed, with a car waiting. "Savli" is eleven taps on a phone
// keyboard and two on a suggestion; over a few thousand entries that is the
// difference between keeping up with the queue and not. It also keeps one
// spelling per village, which is what makes a village search find every car
// from that village rather than a third of them.
//
// Three rules the design follows:
//
//   1. **It must work offline.** The entry screen does, so this does too:
//      the last list is kept in localStorage and read back synchronously,
//      before any network call. A phone in a dead spot still suggests.
//   2. **What this phone just typed counts immediately.** A value entered
//      here is remembered locally the moment it is saved, so the second car
//      from a new village is a tap — without waiting for a sync, a poll and
//      a round trip.
//   3. **Most-used first.** With the field empty the commonest few are
//      shown straight away, so the common case is zero letters typed.

export const SUGGEST_FIELDS = ['village', 'taluka', 'landmark', 'vehicle_type'] as const
export type SuggestField = (typeof SUGGEST_FIELDS)[number]

export type Suggestion = {
  value: string
  // For a village: the taluka it is usually entered with, so picking the
  // village can fill the taluka in as well.
  pair?: string | null
  uses: number
}

export type SuggestionSet = Record<SuggestField, Suggestion[]>

// The server's copy, and this phone's own additions. Kept apart on purpose:
// a refresh replaces the server half wholesale, and anything typed here
// that has not come back from the server yet must survive that.
const SERVER_KEY = 'parking_suggestions'
const LOCAL_KEY = 'parking_suggestions_local'

// A phone holds one row per distinct value, not per entry, so these are
// generous. The cap exists so a long event cannot grow localStorage without
// bound, not because the lists are expected to get near it.
const MAX_PER_FIELD = 500
const MAX_LOCAL_PER_FIELD = 200

// On day one the table is empty and there is nothing to suggest, which is
// exactly when a volunteer is slowest. These are offered until real entries
// outrank them.
//
// Ordered by how often they actually turn up at an event, **not**
// alphabetically. Only the first few become chips, and sorting these by
// name pushes "Car" — the commonest vehicle on the ground — off the end of
// the row behind "Auto".
const SEED_VEHICLE_TYPES = ['Car', 'Bike', 'Bus', 'Tractor', 'Auto', 'Tempo', 'Jeep']

export function emptySuggestions(): SuggestionSet {
  return { village: [], taluka: [], landmark: [], vehicle_type: [] }
}

/** Lower-cased, trimmed, inner spaces collapsed — the matching key. */
export function suggestKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

// --- storage ----------------------------------------------------------

function read(key: string): Partial<SuggestionSet> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Partial<SuggestionSet>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    // Corrupt or unreadable — an empty list is a fair fallback, the
    // operator can still type
    return {}
  }
}

function write(key: string, set: Partial<SuggestionSet>) {
  try {
    localStorage.setItem(key, JSON.stringify(set))
  } catch {
    // Storage full or blocked. Suggestions are a convenience; losing them
    // must never stop an entry being made.
  }
}

// --- merging ----------------------------------------------------------

function mergeLists(...lists: Suggestion[][]): Suggestion[] {
  const by = new Map<string, Suggestion>()

  for (const list of lists) {
    for (const s of list ?? []) {
      if (!s?.value) continue
      const key = suggestKey(s.value)
      if (!key) continue
      const seen = by.get(key)
      if (!seen) {
        by.set(key, { value: s.value, pair: s.pair ?? null, uses: s.uses ?? 0 })
        continue
      }
      // The counts add up, and the spelling kept is the one carrying more
      // of them — the same rule the database applies across phones.
      const uses = seen.uses + (s.uses ?? 0)
      by.set(key, {
        value: (s.uses ?? 0) > seen.uses ? s.value : seen.value,
        pair: seen.pair ?? s.pair ?? null,
        uses,
      })
    }
  }

  return [...by.values()]
    .sort((a, b) => b.uses - a.uses || a.value.localeCompare(b.value))
    .slice(0, MAX_PER_FIELD)
}

function seedFor(field: SuggestField): Suggestion[] {
  if (field !== 'vehicle_type') return []
  // A fraction of a use each. That keeps the order above intact while
  // staying below one, so the first vehicle type anybody actually enters
  // outranks every seed — which is the whole point. These are a nudge for
  // the first morning, not a list to choose from.
  const n = SEED_VEHICLE_TYPES.length
  return SEED_VEHICLE_TYPES.map((value, i) => ({ value, uses: (n - i) / (n + 1) }))
}

function combine(server: Partial<SuggestionSet>, local: Partial<SuggestionSet>): SuggestionSet {
  const out = emptySuggestions()
  for (const field of SUGGEST_FIELDS) {
    out[field] = mergeLists(server[field] ?? [], local[field] ?? [], seedFor(field))
  }
  return out
}

/**
 * What this phone already knows, with no network call. Synchronous on
 * purpose: the entry screen shows suggestions from the first paint rather
 * than a beat later, and it is the whole answer when there is no signal.
 */
export function cachedSuggestions(): SuggestionSet {
  return combine(read(SERVER_KEY), read(LOCAL_KEY))
}

/**
 * Ask the server for the current list. Returns the merged set, or the
 * cached one unchanged if the call failed — never null, so a caller has
 * nothing to branch on.
 */
export async function refreshSuggestions(): Promise<SuggestionSet> {
  try {
    const res = await fetch('/api/suggestions')
    if (!res.ok) return cachedSuggestions()
    const json = (await res.json()) as { suggestions?: Partial<SuggestionSet> }
    const server = json.suggestions ?? {}

    const trimmed: Partial<SuggestionSet> = {}
    for (const field of SUGGEST_FIELDS) {
      trimmed[field] = (server[field] ?? []).slice(0, MAX_PER_FIELD)
    }
    write(SERVER_KEY, trimmed)

    // Anything this phone typed that the server now knows about is dropped
    // from the local half — otherwise its count would be added twice, and
    // a village entered here would climb the list faster than one entered
    // on the phone next to it.
    const local = read(LOCAL_KEY)
    const pruned: Partial<SuggestionSet> = {}
    for (const field of SUGGEST_FIELDS) {
      const known = new Set((trimmed[field] ?? []).map((s) => suggestKey(s.value)))
      pruned[field] = (local[field] ?? []).filter((s) => !known.has(suggestKey(s.value)))
    }
    write(LOCAL_KEY, pruned)

    return combine(trimmed, pruned)
  } catch {
    // Offline. The cached list is the right answer, not an error.
    return cachedSuggestions()
  }
}

/**
 * Record values this phone has just used, so they are suggested here from
 * the very next entry — before any sync, and with no network at all.
 *
 * @param values what was entered, field by field. Empty values are ignored.
 * @param pair the taluka to remember alongside the village, if any.
 */
export function rememberSuggestions(
  values: Partial<Record<SuggestField, string | null | undefined>>,
  pair?: string | null,
): SuggestionSet {
  const local = read(LOCAL_KEY)

  for (const field of SUGGEST_FIELDS) {
    const value = (values[field] ?? '').trim()
    if (!value) continue

    const list = local[field] ?? []
    const key = suggestKey(value)
    const at = list.findIndex((s) => suggestKey(s.value) === key)

    if (at >= 0) {
      list[at] = {
        ...list[at],
        uses: (list[at].uses ?? 0) + 1,
        pair: field === 'village' ? (pair?.trim() || list[at].pair || null) : list[at].pair,
      }
    } else {
      list.unshift({
        value,
        uses: 1,
        pair: field === 'village' ? pair?.trim() || null : null,
      })
    }

    local[field] = list.slice(0, MAX_LOCAL_PER_FIELD)
  }

  write(LOCAL_KEY, local)
  return combine(read(SERVER_KEY), local)
}

/** Thrown away with everything else when the Super Admin clears the data. */
export function clearSuggestions() {
  try {
    localStorage.removeItem(SERVER_KEY)
    localStorage.removeItem(LOCAL_KEY)
  } catch {
    // Nothing to do — the next refresh overwrites them anyway
  }
}

// --- matching ---------------------------------------------------------

/**
 * The suggestions worth showing for what has been typed so far.
 *
 * Ranked by where the match falls, not just whether it matched: someone
 * typing "sav" means a village starting with those letters, and a landmark
 * that merely contains them somewhere in the middle should not push it off
 * a six-row list. Within each band, most-used first.
 *
 * With nothing typed the list is simply the commonest values — which is the
 * point: the usual entry needs no letters at all.
 */
export function matchSuggestions(list: Suggestion[], query: string, limit = 6): Suggestion[] {
  const q = suggestKey(query ?? '')
  if (!q) return list.slice(0, limit)

  const starts: Suggestion[] = []
  const word: Suggestion[] = []
  const inside: Suggestion[] = []

  for (const s of list) {
    const v = suggestKey(s.value)
    if (v.startsWith(q)) starts.push(s)
    else if (v.includes(' ' + q)) word.push(s)
    else if (v.includes(q)) inside.push(s)
  }

  // `list` arrives sorted by uses, so concatenating the bands keeps that
  // order inside each one
  return [...starts, ...word, ...inside].slice(0, limit)
}

/** The taluka a village is usually entered with, if it is known. */
export function pairFor(villages: Suggestion[], village: string): string | null {
  const key = suggestKey(village)
  if (!key) return null
  return villages.find((s) => suggestKey(s.value) === key)?.pair ?? null
}
