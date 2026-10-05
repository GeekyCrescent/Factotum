/**
 * Which configured source a mail came through (spec 2026-10-05, D4; criterion 7). Pure.
 *
 * MEASURED, NOT ASSUMED (tasks §M, A5 and A5 bis):
 * - Outlook (Tec, MQ), when it redirects, puts the forwarding mailbox in `Resent-From` and leaves
 *   `To` as it was. A mail that reached you by Bcc or a list does not name you in `To`, but does in
 *   `Resent-From`. No `Delivered-To` or `X-Forwarded-To` carries the institutional address.
 * - Gmail, when it forwards, writes no `Resent-From`. The origin is the FIRST address of
 *   `X-Forwarded-For: <origin> <destination>`, and a second `Delivered-To`.
 *
 * `From` NEVER MAKES A SOURCE: somebody at bwr.mx writing straight to the Gmail is mail of the account.
 */

import type { SourceConfig } from '../config.ts'

/** Lower-cased addresses, as `addressesIn` returns them. */
export interface Addressing {
  readonly resentFrom: readonly string[]
  readonly forwardedFor: readonly string[]
  readonly deliveredTo: readonly string[]
  readonly to: readonly string[]
  readonly cc: readonly string[]
}

/**
 * The first source whose address shows up, looking in this order: `Resent-From`; then the first
 * address of `X-Forwarded-For` or any `Delivered-To` that is not the account itself; then `To` and
 * `Cc`. `undefined`: the mail is the account's own.
 */
export function sourceOf(
  addressing: Addressing,
  sources: readonly SourceConfig[],
  accountUser: string,
): SourceConfig | undefined {
  const own = accountUser.toLowerCase()
  const forwarded = [
    ...addressing.forwardedFor.slice(0, 1),
    ...addressing.deliveredTo.filter((address) => address !== own),
  ]
  const steps: readonly (readonly string[])[] = [addressing.resentFrom, forwarded, [...addressing.to, ...addressing.cc]]
  for (const step of steps) {
    const found = sources.find((source) => step.includes(source.address.toLowerCase()))
    if (found !== undefined) return found
  }
  return undefined
}
