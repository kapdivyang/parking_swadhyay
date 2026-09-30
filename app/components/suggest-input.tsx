'use client'

import { useEffect, useRef, useState } from 'react'
import { matchSuggestions, suggestKey, type Suggestion } from '@/lib/suggest'

/**
 * A text field that offers back what has already been entered — by anyone,
 * on any phone.
 *
 * Deliberately not `<datalist>`, which is what this replaced. A datalist is
 * one line of markup, but on a phone it is the browser's own dropdown: tiny
 * rows, no control over ordering, and on iOS Safari it is unreliable enough
 * that some volunteers would simply never see it. Nine entries in ten are
 * made on a phone, so the suggestion list is drawn here — thumb-sized rows,
 * commonest first, and the same on every device.
 *
 * Two things earn their keep:
 *
 *   - **The list opens on focus, before a single letter.** Vehicles arrive
 *     village by village, so the value wanted is usually one of the last
 *     few used. Tapping the field and tapping a row is the whole entry.
 *   - **Suggestions never steal what is being typed.** A row is only
 *     applied when it is tapped. Nothing is auto-completed into the field
 *     under the operator's finger, because the next keystroke would then
 *     land on the end of a word they did not ask for.
 */
export default function SuggestInput({
  value,
  onChange,
  onPick,
  suggestions,
  placeholder,
  quick = 0,
  inputMode,
  autoCapitalize = 'words',
  className = '',
  limit = 6,
}: {
  value: string
  onChange: (value: string) => void
  /** Called instead of onChange when a suggestion is tapped, if given —
   *  a village pick also fills the taluka in, and that is not a keystroke. */
  onPick?: (suggestion: Suggestion) => void
  suggestions: Suggestion[]
  placeholder?: string
  /** How many of the commonest values to show as always-visible chips.
   *  Worth it for a short, repetitive field like vehicle type; not for a
   *  landmark, where every block has its own. */
  quick?: number
  inputMode?: 'text' | 'numeric' | 'tel'
  autoCapitalize?: 'none' | 'words' | 'characters'
  className?: string
  limit?: number
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (closing.current) clearTimeout(closing.current)
  }, [])

  const matches = matchSuggestions(suggestions, value, limit)
  const typed = suggestKey(value)

  // Nothing to add once the field already holds the only suggestion left —
  // a one-row list under a finished word is just something in the way.
  const worthShowing =
    matches.length > 0 && !(matches.length === 1 && suggestKey(matches[0].value) === typed)

  const chips = quick > 0 ? suggestions.slice(0, quick) : []

  function pick(s: Suggestion) {
    if (onPick) onPick(s)
    else onChange(s.value)
    setOpen(false)
    // The keyboard is in the way of the SAVE button, and the value is
    // already right — there is nothing left to type here.
    ref.current?.blur()
  }

  return (
    <div>
      {chips.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {chips.map((s) => {
            const on = suggestKey(s.value) === typed
            return (
              <button
                key={s.value}
                type="button"
                onClick={() => (on ? onChange('') : pick(s))}
                className={`rounded-full border-2 px-4 py-2 text-base font-medium ${
                  on
                    ? 'border-blue-600 bg-blue-600 text-white'
                    : 'border-slate-300 bg-white text-slate-600'
                }`}
              >
                {s.value}
              </button>
            )
          })}
        </div>
      )}

      <input
        ref={ref}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => {
          if (closing.current) clearTimeout(closing.current)
          setOpen(true)
        }}
        // Closed a moment late, not immediately. The row below is meant to
        // keep the focus (see onMouseDown there), but a browser that skips
        // the compatibility mouse event would blur first and the tap would
        // land on nothing — which reads as the app ignoring you.
        onBlur={() => {
          closing.current = setTimeout(() => setOpen(false), 150)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
          // Enter with the list open closes it instead of saving. Someone
          // half way through choosing a village should not have the entry
          // written by the same key. A second Enter then saves as usual.
          if (e.key === 'Enter' && open && worthShowing) {
            e.preventDefault()
            setOpen(false)
          }
        }}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize={autoCapitalize}
        inputMode={inputMode}
        enterKeyHint="done"
        spellCheck={false}
        className={
          className ||
          'w-full rounded-lg border-2 border-slate-300 bg-white px-3 py-3 text-lg outline-none focus:border-blue-600'
        }
      />

      {open && worthShowing && (
        <div className="mt-1 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
          {matches.map((s) => (
            <button
              key={s.value}
              type="button"
              // Keeps the field focused, so the tap lands on this row
              // instead of being eaten by the blur that would otherwise
              // close the list first. mousedown rather than pointerdown:
              // it is the compatibility event every touch browser fires
              // before the click, and preventing it stops the blur while
              // leaving the click itself alone.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s)}
              className="flex w-full items-baseline justify-between gap-3 border-b border-slate-100 px-4 py-3 text-left last:border-b-0 active:bg-blue-50"
            >
              <span className="truncate text-lg text-slate-900">{s.value}</span>
              {s.pair && <span className="shrink-0 text-sm text-slate-400">{s.pair}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
