/**
 * What is still pending — pure, so a test can decide it (spec 2026-09-18, criterion 28).
 *
 * A PENDING is a notice that asked for something until a deadline (`NotificationMessage.until`),
 * stored by the service worker when it arrived. The shell counts them, and hands each module its
 * own. The shell drops the expired ones; a module drops the ones it knows are resolved.
 *
 * THE SAME SHAPE LIVES IN public/sw.js, which cannot import TypeScript. Five fields and a key; if
 * one side changes, the other does.
 */

export interface Pending {
  /** `${moduleId}:${tag}` — the same tag replaces the same pending. */
  readonly key: string
  readonly moduleId: string
  readonly tag: string
  /** Where the notice pointed, WITHOUT its query: navigating here never puts a token in the URL. */
  readonly path: string
  /** The notice's data, as the module sent it. May hold a token (ADR-0010); never logged. */
  readonly data: Readonly<Record<string, unknown>>
  /** ISO 8601. */
  readonly until: string
}

export interface Split {
  readonly alive: readonly Pending[]
  readonly expired: readonly Pending[]
}

/** Alive while its deadline is in the future. A deadline that cannot be read is expired. */
export function alive(records: readonly Pending[], now: number): Split {
  const live: Pending[] = []
  const dead: Pending[] = []
  for (const record of records) {
    const until = Date.parse(record.until)
    ;(Number.isFinite(until) && until > now ? live : dead).push(record)
  }
  live.sort((a, b) => Date.parse(b.until) - Date.parse(a.until))
  return { alive: live, expired: dead }
}

/**
 * How long until the next alive pending expires, so the shell can drop it on time and the ☰ badge
 * does not count something already over. `undefined` with nothing alive.
 */
export function nextExpiry(records: readonly Pending[], now: number): number | undefined {
  const deadlines = records.map((record) => Date.parse(record.until)).filter((until) => Number.isFinite(until) && until > now)
  return deadlines.length === 0 ? undefined : Math.min(...deadlines) - now
}

export function forModule(records: readonly Pending[], moduleId: string): readonly Pending[] {
  return records.filter((record) => record.moduleId === moduleId)
}

export function keyOf(moduleId: string, tag: string): string {
  return `${moduleId}:${tag}`
}

/** Anything read back from storage is checked: a stored record is untrusted input. */
export function isPending(value: unknown): value is Pending {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return (
    typeof r['key'] === 'string' &&
    typeof r['moduleId'] === 'string' &&
    typeof r['tag'] === 'string' &&
    typeof r['path'] === 'string' &&
    typeof r['until'] === 'string' &&
    r['data'] !== null &&
    typeof r['data'] === 'object' &&
    r['key'] === keyOf(r['moduleId'] as string, r['tag'] as string)
  )
}
