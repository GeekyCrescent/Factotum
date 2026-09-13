/**
 * The check nobody writes: comparing where we MEANT to listen against where we
 * ACTUALLY ended up.
 *
 * Resolution and range validation decide the intent. This decides the outcome, and
 * it is the only thing that catches a wide bind arriving from a mistyped argument, a
 * platform default, or a refactor two years from now. It is also what makes the
 * decision to ship no credential rest on something checked rather than something
 * believed.
 *
 * Pure on purpose: `boot.ts` supplies whatever `server.address()` returned.
 */

import { sameAddress } from './ranges.ts'

export interface BoundAddress {
  readonly address: string
  readonly port: number
}

export type BindVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly expected: string; readonly actual: string }

export function verifyBound(expected: BoundAddress, actual: BoundAddress | null): BindVerdict {
  if (actual === null) {
    return { ok: false, expected: describe(expected), actual: 'nothing (the socket reported no address)' }
  }
  // Normalising comparison: a dual-stack listen on 100.64.0.1 can report back as
  // ::ffff:100.64.0.1, and a naive string compare would abort a correct install.
  if (sameAddress(expected.address, actual.address) && expected.port === actual.port) {
    return { ok: true }
  }
  return { ok: false, expected: describe(expected), actual: describe(actual) }
}

function describe(bound: BoundAddress): string {
  return `${bound.address}:${bound.port}`
}
