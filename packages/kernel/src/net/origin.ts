/**
 * Who may talk to the API once they can reach it.
 *
 * The bind decides WHERE you can reach this daemon from. It says nothing about WHO
 * is talking once inside: any page the owner opens on any machine in the tailnet can
 * do `fetch('http://100.64.x.y:7777/…', { method: 'POST', mode: 'no-cors' })`, which
 * is a simple request — no preflight — and it executes even though the attacker
 * cannot read the reply. With no credential in the system, this file is the only
 * defence against that.
 *
 * THE RULE IS: SAME HOST, SAME PORT.
 *
 * Decided by shape rather than by a list of names, and that is the whole design.
 * A host is legitimately reachable by three names — its tailnet IP, its MagicDNS
 * name and `localhost` — and a list built from the config only ever knows one of
 * them. The predecessor project carries the warning in its own source: "the client
 * is opened by the Tailscale IP or by localhost:7777 while the config says the
 * MagicDNS name, and a 403 there would be the worst possible symptom".
 *
 * Requiring the same PORT is what does the real work. It rejects `192.168.1.1`
 * (another machine on your LAN) and `localhost:3000` (another service on your own),
 * and it closes Tailscale Funnel, which hands out public `*.ts.net` names to anyone
 * with a free account but serves them over HTTPS on 443.
 *
 * WHAT THIS IS NOT: a credential. It defends against someone else's browser, not
 * against someone on the network with `curl`. That is exactly the trade the owner
 * chose. `Host` is not checked either — see §11 of the design for why, and for the
 * DNS-rebinding gap that leaves.
 */

import { isLoopback, sameAddress } from './ranges.ts'

export interface OriginPolicy {
  /** The address this daemon listens on. */
  readonly address: string
  readonly port: number
  /** Extra whole origins, for anyone putting a reverse proxy in front. */
  readonly extra: readonly string[]
}

export function originPolicy(
  address: string,
  port: number,
  extra: readonly string[] = [],
): OriginPolicy {
  return { address, port, extra }
}

const DEFAULT_PORTS: Readonly<Record<string, number>> = { 'http:': 80, 'https:': 443 }

/** `[fd7a::1]` arrives bracketed from `URL.hostname`; comparisons want it bare. */
function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
}

export function originAllowed(origin: string, policy: OriginPolicy): boolean {
  // An exact match on a whole origin the operator wrote down themselves.
  if (policy.extra.includes(origin)) return true

  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }

  const port = url.port === '' ? DEFAULT_PORTS[url.protocol] : Number(url.port)
  if (port !== policy.port) return false

  const hostname = unbracket(url.hostname)

  // Exact equality, never a substring test: `endsWith('127.0.0.1')` would admit
  // `http://127.0.0.1.attacker.com`, which is a name the attacker owns.
  if (sameAddress(hostname, policy.address)) return true

  // MagicDNS. The suffix carries its own dot so `evilts.net` cannot match.
  if (hostname.endsWith('.ts.net')) return true

  // localhost only when the daemon actually listens there. Otherwise that address
  // does not answer, and admitting it would accept an origin that could not have
  // loaded the client. The predecessor accepts localhost unconditionally, but it
  // opens a second listener on loopback; this one does not, so the policy follows
  // the bind instead of copying the precedent.
  if (isLoopback(policy.address)) {
    if (hostname === 'localhost' || isLoopback(hostname)) return true
  }

  return false
}

/** What `doctor` prints, and what a 403 message can point at. */
export function describePolicy(policy: OriginPolicy): readonly string[] {
  const lines = [
    `same host and same port (${policy.port})`,
    `  the bind address: ${policy.address}`,
    '  any *.ts.net name (MagicDNS)',
  ]
  if (isLoopback(policy.address)) lines.push('  localhost, because the bind is loopback')
  for (const extra of policy.extra) lines.push(`  ${extra} (from listen.extraOrigins)`)
  return lines
}
