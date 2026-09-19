/**
 * The client half of every bundled module, and what the shell hands each one.
 *
 * Static imports, because a bundler cannot bundle what it cannot see in the import graph. The
 * consequence is accepted and measured later if it matters: the bundle carries the code of
 * modules that are switched off. What the shell will not do is RENDER one the server has not
 * declared — enabled is a server fact.
 *
 * THE CONTRACT GREW WITH THE CLIENT DESIGN (spec 2026-09-18, design D3; ADR-0010), and it grew
 * here, not in `packages/core`: a module meets it STRUCTURALLY, declaring the props it uses by
 * hand, and imports nothing new. A module that declares fewer props than these still fits — which
 * is why `modules/example` did not change.
 */

import type { ComponentType } from 'preact'
import { moduleApi, type ModuleApi } from './api.ts'
import type { Pending } from './pending.ts'
import { exampleClient } from '../../../modules/example/client.tsx'
import { sessionsClient } from '../../../modules/sessions/client/index.tsx'

export interface ModuleViewProps {
  readonly api: ModuleApi
  /**
   * What follows `/m/<id>/` in the path, `''` at the module's root. KEPT IN STEP WITH THE URL: when
   * the module navigates, or Back is pressed, the screen re-renders with the new value.
   *
   * This is NOT the open client edge of ADR-0005 — "a screen calling another module" — and does
   * not touch it: it tells a screen where it is.
   */
  readonly rest: string
  /**
   * The query the page LOADED with (`''` or `'?…'`), handed over once. The shell has already taken
   * it out of the address bar, before the first render, and it is `''` after the first navigation.
   * A module that needs a query value keeps it in memory; no query survives in the history.
   */
  readonly search: string
  /** Change what follows `/m/<id>/`, without a reload. `replace` leaves no history entry. */
  readonly navigate: (rest: string, options?: { readonly replace?: boolean }) => void
  readonly openDrawer: () => void
  /** The module's own overlay (a sheet), which Android's Back closes first. */
  readonly overlay: string | undefined
  readonly setOverlay: (name: string | undefined) => void
  /** This module's live pendings, and how many there are across all modules, for the ☰ badge. */
  readonly pending: readonly Pending[]
  readonly pendingTotal: number
  /** The module knows a pending is over — answered, refused, or its subject ended. */
  readonly resolvePending: (tag: string) => void
}

export interface ModuleDrawerProps {
  readonly api: ModuleApi
  readonly rest: string
  /** Navigates within the module and closes the drawer. */
  readonly navigate: (rest: string) => void
  readonly pending: readonly Pending[]
}

export interface ModuleClient {
  readonly id: string
  readonly View: ComponentType<ModuleViewProps>
  /** What the module adds to the drawer. Without it, the module only appears in the drawer's foot. */
  readonly Drawer?: ComponentType<ModuleDrawerProps>
  /**
   * `true` when the View draws its own `.topbar`, with a ☰ that calls `openDrawer`. Otherwise the
   * shell draws a fallback bar above it, so that NO screen leaves the drawer unreachable.
   */
  readonly ownsTopBar?: boolean
}

export const CLIENTS: readonly ModuleClient[] = [exampleClient, sessionsClient]

export function clientFor(id: string): ModuleClient | undefined {
  return CLIENTS.find((client) => client.id === id)
}

const APIS = new Map<string, ModuleApi>()

/**
 * One `ModuleApi` per module for the life of the page. A new object on every render would re-run
 * every effect a screen keys on `api` (Example's is `[api]`), and the shell now re-renders often.
 */
export function apiFor(id: string): ModuleApi {
  const known = APIS.get(id)
  if (known !== undefined) return known
  const created = moduleApi(id)
  APIS.set(id, created)
  return created
}
