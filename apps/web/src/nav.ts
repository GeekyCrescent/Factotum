/**
 * Which modules the drawer lists, in what order, and where `/` lands — pure, so a test decides it.
 *
 * THE SHELL KNOWS NO MODULE BY NAME: `/` goes to whichever enabled module has the lowest
 * `nav.order`, and that module decides what its root shows (spec 2026-09-18, design D4).
 */

import type { ModuleSummary } from './api.ts'

/** A new array in `nav.order`. No order goes last; a tie falls back to the id, so it is stable. */
export function ordered(modules: readonly ModuleSummary[]): readonly ModuleSummary[] {
  return [...modules].sort((a, b) => {
    const left = a.nav?.order ?? Number.MAX_SAFE_INTEGER
    const right = b.nav?.order ?? Number.MAX_SAFE_INTEGER
    return left === right ? a.id.localeCompare(b.id) : left - right
  })
}

/** Where `/` goes. `undefined` when nothing is enabled, which the shell says in words. */
export function landing(modules: readonly ModuleSummary[]): ModuleSummary | undefined {
  return ordered(modules).find((module) => module.status.kind === 'enabled')
}
