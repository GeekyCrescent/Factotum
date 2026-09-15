/**
 * Turning the config and the resolved bind into an origin policy.
 *
 * THIS FILE EXISTS BECAUSE THE RULE IS NEEDED IN TWO PLACES.
 *
 * `boot` needs it to decide what the daemon accepts. `doctor` needs it to print what
 * the daemon accepts. If `doctor` reimplemented the condition, the first time the two
 * drifted `doctor` would print a `localOrigin` that `boot` had left `undefined` — and
 * it would be lying in exactly the situation the tool exists for. So there is one
 * function, both call it, and `doctor` cannot answer differently from `boot` without
 * this file changing.
 *
 * It is also what keeps `isLoopback` out of `origin.ts`. The policy is now a set of
 * VALUES, not a set of rules; deciding whether the rescue route exists is a
 * composition-time question, and this is composition time.
 */

import { isLoopback } from './ranges.ts'
import { localUrl } from './url.ts'
import { originPolicy, type OriginPolicy } from './origin.ts'

export interface PolicyInput {
  /** From the config, already validated canonical and free of a trailing dot. */
  readonly publicOrigin: string
  /** The RESOLVED bind address — what step 4 worked out, not what the config declared. */
  readonly address: string
  readonly port: number
  readonly extraOrigins: readonly string[]
}

/**
 * The local origin is composed ONLY when the bind is loopback.
 *
 * Deriving it unconditionally is the trap. With `listen.interface: "tailscale0"` the
 * bind resolves to something like `100.87.1.2`, and an unconditional `localUrl` would
 * hand the policy `http://100.87.1.2:7777` as though it were a local rescue route —
 * re-opening, as a declared value, the tailnet-IP origin this spec just removed.
 */
export function policyFor(input: PolicyInput): OriginPolicy {
  const local = isLoopback(input.address) ? localUrl(input.address, input.port) : undefined
  return originPolicy(input.publicOrigin, local, input.extraOrigins)
}
