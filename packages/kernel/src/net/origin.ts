/**
 * Who may talk to the API once they can reach it.
 *
 * The bind decides WHERE this daemon can be reached from. It says nothing about WHO
 * is talking once inside: any page the owner opens on any machine can do
 * `fetch('http://…/…', { method: 'POST', mode: 'no-cors' })`, which is a simple
 * request — no preflight — and it executes even though the attacker cannot read the
 * reply. With no credential in the system, this file is the only defence against that.
 *
 * THE RULE IS: TWO EXACT ORIGINS, BOTH DECLARED. NOTHING IS DECIDED BY SHAPE.
 *
 * ---------------------------------------------------------------------------
 * WHAT USED TO BE HERE, AND WHY IT IS GONE
 *
 * Until TLS, factotum was reached directly and a host had three legitimate names —
 * its tailnet IP, its MagicDNS name, and localhost — so the policy could not be a
 * list and had to be decided by shape: SAME HOST, SAME PORT.
 *
 * With `tailscale serve` terminating TLS in front, that reasoning stops applying.
 * There is exactly ONE name the client can have been loaded from, and it is the one
 * the certificate covers. So four things were deleted rather than redesigned:
 *
 *   - `hostname.endsWith('.ts.net')` — the MagicDNS suffix rule. It was not a
 *     defence at all: it admitted ANY name in ANY tailnet, including every name
 *     Tailscale Funnel hands out for free. The only thing holding it shut was the
 *     port comparison below, which is exactly what TLS on 443 takes away. Deleting
 *     it is the whole point of this file's rewrite.
 *   - The port comparison. It was doing the real work — it rejected
 *     `192.168.1.1:7777` (another machine) and `localhost:3000` (another service) —
 *     and exact equality now does that work instead, without needing a rule.
 *   - `sameAddress(hostname, policy.address)` — arriving by IP. Nobody arrives by
 *     the tailnet IP any more; the bind is loopback. Its other job, normalising the
 *     two spellings of an IPv6 address, moved to `localUrl` in `url.ts`, which
 *     canonicalises once at composition time instead of on every request.
 *   - The `isLoopback(policy.address)` branch that let `localhost` in. There is no
 *     longer an address to ask about: `localOrigin` is A VALUE, not a rule, and the
 *     condition that decides whether it exists lives in `net/policy.ts` — in ONE
 *     place, because `doctor` needs the same answer and two copies is how `doctor`
 *     ends up lying about what `boot` does.
 *
 * WHAT THIS IS NOT: a credential. It defends against someone else's browser, not
 * against someone on the machine with `curl` — and the loopback bind is what reduces
 * that second set to local processes, which is exactly what the permission hook
 * relies on. `Host` is not checked either; see `docs/networking.md` for the
 * DNS-rebinding gap that leaves.
 * ---------------------------------------------------------------------------
 */

export interface OriginPolicy {
  /**
   * The origin the client is served on: what `tailscale serve` puts TLS in front of.
   *
   * Declared in the config, never derived, and validated there as canonical AND
   * free of a trailing dot. Both halves matter, because the comparison below is raw:
   * `tailscale status --json` returns `Self.DNSName` WITH a trailing dot, a browser
   * sends the origin without one, and two strings that look identical to the eye
   * would 403 every POST in silence.
   */
  readonly publicOrigin: string
  /**
   * The bind's own origin, already canonical — e.g. `http://127.0.0.1:7777`.
   *
   * THIS IS THE RESCUE ROUTE: if `tailscale serve` stops, it is the only way left to
   * open the client from this machine, and it is what the permission hook talks to
   * so that a gate decision never depends on the proxy being alive.
   *
   * `undefined` when the bind is NOT loopback. The condition does not live here — it
   * lives in `net/policy.ts`, because `doctor` needs it too.
   */
  readonly localOrigin: string | undefined
  /** The operator's hatch for a third-party proxy. Not the mechanism. */
  readonly extra: readonly string[]
}

export function originPolicy(
  publicOrigin: string,
  localOrigin: string | undefined,
  extra: readonly string[] = [],
): OriginPolicy {
  return { publicOrigin, localOrigin, extra }
}

/**
 * Exact string equality against at most three declared values, and nothing else.
 *
 * NOT `new URL(origin).origin === …`. That would silently accept a path, embedded
 * credentials, and any mix of upper case, because `.origin` discards the first two
 * and lower-cases the third — so a policy written that way would answer `true` to
 * three things a browser never sends. Anything not already canonical did not come
 * from a browser, and the only reason to be lenient with it would be to let
 * something in.
 *
 * Nothing here parses, so nothing here throws: text that is not an origin simply
 * fails to equal any of the three.
 */
export function originAllowed(origin: string, policy: OriginPolicy): boolean {
  if (origin === policy.publicOrigin) return true
  if (policy.localOrigin !== undefined && origin === policy.localOrigin) return true
  // On the ARRAY, not on the origin string — a membership test, never a substring one.
  return policy.extra.includes(origin)
}

/** What `doctor` prints, and what a 403 message can point at. */
export function describePolicy(policy: OriginPolicy): readonly string[] {
  const lines = [`${policy.publicOrigin} (publicOrigin)`]
  if (policy.localOrigin !== undefined) {
    lines.push(`${policy.localOrigin} (the bind — the way in if serve stops)`)
  }
  for (const extra of policy.extra) lines.push(`${extra} (from listen.extraOrigins)`)
  return lines
}
