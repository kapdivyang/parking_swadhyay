// Normalize a registration number.
// "GJ 06 KA 1234", "gj-06-ka-1234" and "GJ06KA1234" all become the same key.
export function normalizeReg(input: string): string {
  return input.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
}

// For display — what the admin typed, just tidied up
export function cleanDisplay(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toUpperCase()
}

// Phone: digits only, with the 91 country prefix stripped
export function normalizePhone(input: string): string {
  const d = input.replace(/\D/g, '')
  if (d.length === 12 && d.startsWith('91')) return d.slice(2)
  if (d.length === 11 && d.startsWith('0')) return d.slice(1)
  return d
}

// Village / taluka: trimmed, inner runs of space collapsed. Case is left
// alone — it is shown back to the operator — and search is case-insensitive.
// Returns null for an empty value, since both fields are optional.
export function cleanPlace(input: string): string | null {
  return input.trim().replace(/\s+/g, ' ') || null
}

// Deliberately loose. Real events see every kind of plate — other states,
// old formats, temporary registrations — so we only check that something
// number-like was actually typed.
export function isPlausibleReg(reg: string): boolean {
  const n = normalizeReg(reg)
  return n.length >= 4 && n.length <= 15 && /[0-9]/.test(n)
}
