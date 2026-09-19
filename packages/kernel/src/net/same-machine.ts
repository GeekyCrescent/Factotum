/**
 * Whether a subscription comes from a browser on THIS machine (spec 2026-09-18, design D12).
 *
 * It matters because a pending approval keeps its token on the device it arrives at (ADR-0010),
 * and on the daemon's own machine an agent could read it. The client asks, and a browser here
 * keeps no token. Defence in depth over a risk already accepted in proportion: the kernel does
 * NOT refuse the subscription.
 *
 * TWO SIGNALS, AND NO GUESS:
 * - the page was loaded from the loopback origin: only a browser on this machine can do that;
 * - through `tailscale serve`, the source IP it forwards is one of this machine's addresses.
 * Anything else is "not this machine". Missing data never classifies a browser as this machine:
 * that would take the token away from the phone.
 */

import type { IncomingHttpHeaders } from 'node:http'
import type { OriginPolicy } from './origin.ts'
import { normalize } from './ranges.ts'
import type { Interfaces } from './resolve.ts'

export function isSameMachine(input: {
  readonly origin: string | undefined
  readonly policy: OriginPolicy
  readonly sourceIp: string | undefined
  readonly interfaces: Interfaces
}): boolean {
  // The same exact comparison as `originAllowed`: nothing normalised.
  if (input.origin !== undefined && input.origin === input.policy.localOrigin) return true
  if (input.sourceIp === undefined) return false
  const source = normalize(input.sourceIp)
  if (source === undefined) return false
  return Object.values(input.interfaces())
    .flatMap((entries) => entries ?? [])
    .some((entry) => normalize(entry.address) === source)
}

/**
 * The source IP `tailscale serve` forwards, or `undefined`.
 *
 * MEASURED, NOT ASSUMED (tasks, A6): serve OVERWRITES `x-forwarded-for` and adds
 * `tailscale-headers-info`, so the pair together means serve put the IP there. A request straight
 * to the loopback bind can carry any header it likes, so without `tailscale-headers-info` the IP
 * is not believed.
 */
export function sourceIpOf(headers: Readonly<Record<string, string | string[] | undefined>> | IncomingHttpHeaders): string | undefined {
  if (headers['tailscale-headers-info'] === undefined) return undefined
  const forwarded = headers['x-forwarded-for']
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
  const first = value?.split(',')[0]?.trim()
  return first === undefined || first === '' ? undefined : first
}
