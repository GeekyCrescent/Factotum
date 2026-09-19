/**
 * What the shell hands this module, declared HERE, structurally (spec 2026-09-18, design D3).
 *
 * A module imports nothing from `apps/web` (CLAUDE.md §1, criterion 9): the shell's
 * `ModuleViewProps` and these meet only where `modules.ts` puts `sessionsClient` in the barrel, and
 * the typecheck there is the link. Types only; no DOM (guardrail 11).
 */

import type { Pending } from './relevance.ts'

export interface Api {
  readonly get: <T>(path: string) => Promise<T>
  readonly post: <T>(path: string, body?: unknown) => Promise<T>
}

export interface ViewProps {
  readonly api: Api
  readonly rest: string
  readonly search: string
  readonly navigate: (rest: string, options?: { readonly replace?: boolean }) => void
  readonly openDrawer: () => void
  readonly overlay: string | undefined
  readonly setOverlay: (name: string | undefined) => void
  readonly pending: readonly Pending[]
  readonly pendingTotal: number
  readonly resolvePending: (tag: string) => void
}

export interface DrawerProps {
  readonly api: Api
  readonly rest: string
  readonly navigate: (rest: string) => void
  readonly pending: readonly Pending[]
}
