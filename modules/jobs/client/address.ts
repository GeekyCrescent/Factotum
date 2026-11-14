/**
 * The «To:» line's buttons (spec 2026-11-12-postulaciones, design D3 «La dirección no bloquea la
 * revisión», v4 A2; v5 X4; v6 N2). Pure. The address is never a block of the linter: it is the
 * contact's state, and a guard of approving an email.
 *
 * STALE IS THE ENGINE'S RULE, copied: never checked, or checked more than `ADDRESS_STALE_DAYS` ago
 * (`packages/jobs/src/state.ts` `isStaleCheck`). The engine answers `409 check-pending` for it and
 * queues the check; the screen says «re-checking…» and keeps polling.
 */

import type { Address } from './contract.ts'

export const ADDRESS_STALE_DAYS = 14
const DAY_MS = 86_400_000

export function isStaleCheck(address: Address, now: Date): boolean {
  if (address.checkedAt === null) return true
  return now.getTime() - new Date(address.checkedAt).getTime() > ADDRESS_STALE_DAYS * DAY_MS
}

/** Ms until `isStaleCheck` turns true for this address; 0 when it already is. */
export function staleInMs(address: Address, now: Date): number {
  if (address.checkedAt === null) return 0
  const staleAt = new Date(address.checkedAt).getTime() + ADDRESS_STALE_DAYS * DAY_MS + 1
  return Math.max(0, staleAt - now.getTime())
}

/** `hidden`: not offered. `off`: shown, disabled. `on`: shown, enabled. */
export type Toggle = 'hidden' | 'off' | 'on'

export interface AddressControls {
  /** After «To: …»: verified, checking…, re-checking…, unverified, sent anyway, no address. */
  readonly label: string
  readonly approve: { readonly enabled: boolean; readonly why: string | null }
  /** «Send anyway», with a second click (T-D5). */
  readonly sendAnyway: Toggle
  /** «Switch to form» on an application (on only with a URL), «Switch to LinkedIn note» on a follow-up. */
  readonly switchChannel: Toggle
}

export interface AddressContext {
  readonly now: Date
  readonly entity: 'application' | 'followup'
  readonly formUrl: string | null
}

const CHECKING = 'checking address…'
const RECHECKING = 're-checking…'

/** One row of the D3 table. */
export function addressControls(address: Address | null, ctx: AddressContext): AddressControls {
  const canSwitch: Toggle = ctx.entity === 'followup' || ctx.formUrl !== null ? 'on' : 'off'
  const off = (why: string) => ({ enabled: false, why })
  const on = { enabled: true, why: null }
  if (address === null) return { label: 'no address', approve: off('no address'), sendAnyway: 'hidden', switchChannel: canSwitch }
  if (address.status === 'checking') return { label: 'checking…', approve: off(CHECKING), sendAnyway: 'off', switchChannel: canSwitch }
  if (address.status === 'verified') {
    if (isStaleCheck(address, ctx.now)) return { label: RECHECKING, approve: off(RECHECKING), sendAnyway: 'hidden', switchChannel: 'hidden' }
    return { label: 'verified', approve: on, sendAnyway: 'hidden', switchChannel: 'hidden' }
  }
  // Unverified from here on.
  if (address.checkedAt === null) return { label: 'checking…', approve: off(CHECKING), sendAnyway: 'off', switchChannel: canSwitch }
  if (isStaleCheck(address, ctx.now)) return { label: RECHECKING, approve: off(RECHECKING), sendAnyway: 'off', switchChannel: canSwitch }
  if (address.override !== null) return { label: 'sent anyway', approve: on, sendAnyway: 'hidden', switchChannel: 'hidden' }
  return { label: 'unverified', approve: off('address not found on their site'), sendAnyway: 'on', switchChannel: canSwitch }
}
