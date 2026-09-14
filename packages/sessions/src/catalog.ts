/**
 * The catalog: what the owner declared they can launch, and how each one reaches the
 * CLI.
 *
 * THE DIVISION OF LABOUR WITH THE SCHEMA IS THE WHOLE DESIGN HERE. The module's zod
 * schema checks that an entry is `{id, label, invoke:{kind, name?}}` and stops there,
 * because a schema that rejected an unknown `kind` would fail the WHOLE fragment and
 * take the module down over one bad row. Criterion 14 says the opposite: that entry is
 * disabled with its reason and the rest of the catalog keeps working. So the judgement
 * about whether an entry can actually be invoked lives here, where it can be made one
 * entry at a time. It is ADR-0004 one level further down.
 */

import type { CatalogEntry } from './types.ts'

/** The three ways a catalog entry reaches the CLI. Reading `~/.claude` is out of scope. */
export type Invoke =
  /** The owner's text goes through untouched. */
  | { readonly kind: 'none' }
  /** A skill or slash command: `/<name> ` is prepended, and ONLY on the first turn. */
  | { readonly kind: 'command'; readonly name: string }
  /** `--agent <name>`, with the text untouched. */
  | { readonly kind: 'subagent'; readonly name: string }

export interface ResolvedEntry {
  readonly id: string
  readonly label: string
  /** `undefined` exactly when `disabledReason` is set, and the other way round. */
  readonly invoke: Invoke | undefined
  readonly disabledReason: string | undefined
}

const KINDS = ['none', 'command', 'subagent'] as const

/**
 * A name that reaches an argv slot. No whitespace, because `/my command x` would
 * silently become a different command with an argument; no leading slash, because the
 * caller adds it and `//name` invokes nothing.
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/

export function resolveCatalog(entries: readonly CatalogEntry[]): readonly ResolvedEntry[] {
  const seen = new Set<string>()

  return entries.map((entry) => {
    const disabled = (reason: string): ResolvedEntry => ({
      id: entry.id,
      label: entry.label,
      invoke: undefined,
      disabledReason: reason,
    })

    if (seen.has(entry.id)) return disabled(`another catalog entry already uses the id "${entry.id}"`)
    seen.add(entry.id)

    const kind = entry.invoke.kind
    if (!(KINDS as readonly string[]).includes(kind)) {
      return disabled(`invoke.kind "${kind}" is not one of ${KINDS.join(', ')}`)
    }

    if (kind === 'none') {
      return { id: entry.id, label: entry.label, invoke: { kind: 'none' }, disabledReason: undefined }
    }

    const name = entry.invoke.name
    if (name === undefined || name === '') {
      return disabled(`invoke.kind "${kind}" needs a name`)
    }
    if (!NAME.test(name)) {
      return disabled(`invoke.name ${JSON.stringify(name)} is not a name the CLI can be given`)
    }

    return {
      id: entry.id,
      label: entry.label,
      invoke: kind === 'command' ? { kind: 'command', name } : { kind: 'subagent', name },
      disabledReason: undefined,
    }
  })
}

export function findInvokable(
  resolved: readonly ResolvedEntry[],
  id: string,
): { readonly ok: true; readonly invoke: Invoke } | { readonly ok: false; readonly reason: string } {
  const entry = resolved.find((candidate) => candidate.id === id)
  if (entry === undefined) return { ok: false, reason: `no catalog entry "${id}"` }
  if (entry.invoke === undefined) {
    return { ok: false, reason: `catalog entry "${id}" is disabled: ${entry.disabledReason ?? ''}` }
  }
  return { ok: true, invoke: entry.invoke }
}
