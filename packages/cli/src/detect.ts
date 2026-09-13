/**
 * Finding the address to listen on.
 *
 * THIS IS THE ONLY AUTO-DETECTION IN THE PROJECT, and it lives here rather than in
 * the daemon on purpose: at `init` time it is help during onboarding, at start time
 * it would be a guess about the network made every morning.
 */

import { networkInterfaces } from 'node:os'
import { classify, normalize } from '@factotum/kernel'

export interface Found {
  readonly iface: string
  readonly address: string
  /** Tailscale's CGNAT range, which is what almost everyone wants. */
  readonly tailscale: boolean
}

const CGNAT = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./

export function detect(interfaces = networkInterfaces): readonly Found[] {
  const found: Found[] = []

  for (const [iface, addresses] of Object.entries(interfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.internal) continue
      const address = normalize(entry.address)
      if (address === undefined) continue
      if (!classify(address, false).ok) continue
      found.push({ iface, address, tailscale: CGNAT.test(address) })
    }
  }

  // Tailscale first: it is the documented path, and on a laptop the LAN address
  // changes with every cafe while the tailnet address does not.
  return found.sort((a, b) => Number(b.tailscale) - Number(a.tailscale))
}

/**
 * What `init` writes is the ADDRESS, never the interface name.
 *
 * On macOS the Tailscale interface is `utunN` and the number changes across
 * reboots, while the 100.x address is stable for the life of the node. Writing the
 * name would mean the daemon stops starting one morning for no visible reason, and
 * the fix would be editing a file by hand — which is exactly what the "clone and go"
 * promise forbids.
 */
export const WRITES_ADDRESS_BECAUSE =
  'the utunN number that Tailscale gets on macOS changes across reboots; the 100.x address does not'
