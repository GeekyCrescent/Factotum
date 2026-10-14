/**
 * The reminder's shortcuts (S6), PURE so `node --test` reaches it: a reminder is always an explicit
 * hour, and a due date alone never reminds — but from a due date, two hours are one tap away.
 * The values are what a `datetime-local` input holds: the hour on THIS device, turned into an instant
 * when saved (`reminderFrom` in `model.ts`).
 */

const DAY_MS = 24 * 60 * 60 * 1000

function isDay(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const parsed = new Date(`${date}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
}

export function reminderShortcuts(due: string): readonly { readonly label: string; readonly value: string }[] {
  if (!isDay(due)) return []
  const before = new Date(Date.parse(`${due}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10)
  return [
    { label: 'The due date, 9:00', value: `${due}T09:00` },
    { label: 'The day before, 18:00', value: `${before}T18:00` },
  ]
}
