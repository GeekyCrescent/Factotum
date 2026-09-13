/**
 * Turning what the config declares into the address this process will listen on.
 *
 * STARTUP NEVER GUESSES. There are two paths and no third: an address, or an
 * interface name. Auto-detection lives in `factotum init`, where it is help during
 * onboarding rather than an assumption at runtime. A config that declares neither
 * does not validate, so it never reaches here.
 */

import { networkInterfaces } from 'node:os'
import type { ListenConfig } from '@factotum/core'
import { BootError } from '../errors.ts'
import { classify, isLoopback, sameAddress, stripZone } from './ranges.ts'

/** Injectable so tests do not depend on the machine they run on. */
export type Interfaces = typeof networkInterfaces

export interface ResolvedListen {
  readonly address: string
  readonly port: number
  /** Where it came from, for the error messages and for `doctor`. */
  readonly from: { readonly kind: 'address' } | { readonly kind: 'interface'; readonly name: string }
}

interface Candidate {
  readonly iface: string
  readonly address: string
  readonly internal: boolean
}

function listCandidates(interfaces: Interfaces): readonly Candidate[] {
  const out: Candidate[] = []
  for (const [iface, addresses] of Object.entries(interfaces())) {
    for (const entry of addresses ?? []) {
      out.push({ iface, address: stripZone(entry.address), internal: entry.internal })
    }
  }
  return out
}

function seen(candidates: readonly Candidate[]): string {
  if (candidates.length === 0) return 'none'
  return candidates.map((c) => `${c.iface}=${c.address}`).join(', ')
}

export function resolveListen(
  listen: ListenConfig,
  interfaces: Interfaces = networkInterfaces,
): ResolvedListen {
  const candidates = listCandidates(interfaces)

  const resolved = listen.address !== undefined
    ? fromAddress(listen.address, candidates)
    : fromInterface(listen.interface!, candidates)

  // Loopback is allowed only when it was WRITTEN DOWN, never when something found
  // it. A failed detection must not quietly land on an address that answers but
  // cannot be reached from a phone.
  const loopbackAllowed = listen.address !== undefined && isLoopback(listen.address)

  const verdict = classify(resolved.address, loopbackAllowed)
  if (!verdict.ok) {
    if (verdict.why === 'wide-bind') {
      throw new BootError(
        'listen-out-of-range',
        `refusing to listen on ${resolved.address}: that is every interface`,
        'this is the one thing factotum never does — there is no credential, so ' +
          'reachability is the whole security model. Put a proxy in front instead',
      )
    }
    if (verdict.why === 'not-an-address') {
      throw new BootError(
        'listen-unresolvable',
        `${resolved.address} is not an IP address`,
        'set `listen.address` to an IP, or `listen.interface` to an interface name',
      )
    }
    throw new BootError(
      'listen-out-of-range',
      `${resolved.address} is not in a private range ` +
        `(Tailscale 100.64/10, RFC1918, ULA${loopbackAllowed ? ', loopback' : ''})`,
      'run `factotum init` to pick a Tailscale address on this machine',
    )
  }

  return { ...resolved, port: listen.port }
}

function fromAddress(address: string, candidates: readonly Candidate[]): Omit<ResolvedListen, 'port'> {
  // Criterion 14 bis: the address was valid when `init` wrote it, and then the
  // machine changed tailnets or reinstalled Tailscale. Saying so beats EADDRNOTAVAIL.
  const present = candidates.some((c) => sameAddress(c.address, address))
  if (!present) {
    throw new BootError(
      'listen-unresolvable',
      `listen.address is ${address}, but no interface on this machine has it ` +
        `(saw: ${seen(candidates)})`,
      'run `factotum init` again to pick an address that exists now',
    )
  }
  return { address, from: { kind: 'address' } }
}

function fromInterface(name: string, candidates: readonly Candidate[]): Omit<ResolvedListen, 'port'> {
  const onIt = candidates.filter((c) => c.iface === name && !c.internal)
  const first = onIt[0]
  if (first === undefined) {
    throw new BootError(
      'listen-unresolvable',
      `listen.interface is "${name}", which has no external address on this machine ` +
        `(saw: ${seen(candidates)})`,
      'run `factotum init`, or on macOS prefer `listen.address` — the utunN number ' +
        'that Tailscale gets changes across reboots',
    )
  }
  return { address: first.address, from: { kind: 'interface', name } }
}
