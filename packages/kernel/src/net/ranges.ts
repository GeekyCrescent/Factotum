/**
 * Which addresses this daemon is allowed to listen on, and the normalisations that
 * make that question answerable.
 *
 * The whole security model of the project rests here. There is no credential: the
 * protection is that the process is unreachable from outside a private network. So
 * this file decides, and it decides by RANGE rather than by interface name — the
 * name differs across macOS (`utunN`), Linux (`tailscale0`) and Docker, while the
 * range is the property that actually matters.
 */

import { isIPv4, isIPv6 } from 'node:net'

/** A parsed address: 4 bytes for IPv4, 16 for IPv6. */
type Bytes = readonly number[]

export interface Range {
  readonly cidr: string
  readonly what: string
}

/**
 * Loopback is NOT here. It is allowed only when it was written down explicitly as
 * `address`, never when something auto-detected it — a failed detection must not
 * quietly land on a working-but-useless bind.
 */
export const PRIVATE_RANGES: readonly Range[] = [
  { cidr: '100.64.0.0/10', what: 'CGNAT — this is where Tailscale lives' },
  { cidr: '10.0.0.0/8', what: 'RFC1918' },
  { cidr: '172.16.0.0/12', what: 'RFC1918' },
  { cidr: '192.168.0.0/16', what: 'RFC1918' },
  // Contains Tailscale's IPv6 range fd7a:115c:a1e0::/48, which therefore needs no
  // row of its own — it is named in docs/networking.md for the reader, not here.
  { cidr: 'fc00::/7', what: 'unique local addresses' },
]

export const LOOPBACK_RANGES: readonly Range[] = [
  { cidr: '127.0.0.0/8', what: 'IPv4 loopback' },
  { cidr: '::1/128', what: 'IPv6 loopback' },
]

/**
 * Strips an IPv6 zone suffix. `os.networkInterfaces()` returns `fe80::1%utun4`, and
 * the `%utun4` must not survive into a comparison or into a URL.
 */
export function stripZone(address: string): string {
  const at = address.indexOf('%')
  return at === -1 ? address : address.slice(0, at)
}

function parseIPv4(address: string): Bytes | undefined {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  const bytes: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const value = Number(part)
    if (value > 255) return undefined
    bytes.push(value)
  }
  return bytes
}

function parseIPv6(address: string): Bytes | undefined {
  const [head = '', tail, extra] = address.split('::')
  if (extra !== undefined) return undefined

  const readGroups = (text: string): number[] | undefined => {
    if (text === '') return []
    const out: number[] = []
    const groups = text.split(':')
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i]!
      // A trailing IPv4 form, as in ::ffff:127.0.0.1
      if (i === groups.length - 1 && group.includes('.')) {
        const v4 = parseIPv4(group)
        if (v4 === undefined) return undefined
        out.push(v4[0]! * 256 + v4[1]!, v4[2]! * 256 + v4[3]!)
        continue
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined
      out.push(Number.parseInt(group, 16))
    }
    return out
  }

  const left = readGroups(head)
  const right = tail === undefined ? [] : readGroups(tail)
  if (left === undefined || right === undefined) return undefined

  const missing = 8 - left.length - right.length
  if (tail === undefined ? missing !== 0 : missing < 0) return undefined

  const words = [...left, ...Array<number>(tail === undefined ? 0 : missing).fill(0), ...right]
  if (words.length !== 8) return undefined

  return words.flatMap((word) => [word >> 8, word & 0xff])
}

/** `undefined` when the text is not an address at all. */
export function toBytes(address: string): Bytes | undefined {
  const bare = stripZone(address)
  if (isIPv4(bare)) return parseIPv4(bare)
  if (isIPv6(bare)) return parseIPv6(bare)
  return undefined
}

/**
 * Canonical form for comparison.
 *
 * `100.64.0.1` and `::ffff:100.64.0.1` are the same address. Without collapsing
 * them, the post-listen check would abort on a correct dual-stack install — the
 * fail-closed remedy causing the failure it exists to prevent.
 */
export function normalize(address: string): string | undefined {
  const bytes = toBytes(address)
  if (bytes === undefined) return undefined

  if (bytes.length === 4) return bytes.join('.')

  // IPv4-mapped: ::ffff:a.b.c.d
  const isMapped =
    bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff
  if (isMapped) return bytes.slice(12).join('.')

  const words: string[] = []
  for (let i = 0; i < 16; i += 2) words.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16))
  return words.join(':')
}

/** True when two addresses denote the same host, whatever form they arrived in. */
export function sameAddress(a: string, b: string): boolean {
  const left = normalize(a)
  const right = normalize(b)
  return left !== undefined && left === right
}

/**
 * Every form of "listen on everything".
 *
 * A string comparison against `'0.0.0.0'` lets almost all of these through — which
 * is precisely the hole in the predecessor project's `.refine(v => v !== '0.0.0.0')`,
 * the very check this project cites as the thing it already got right.
 */
export function isWideBind(address: string): boolean {
  // Normalise FIRST. `::ffff:0.0.0.0` is a wide bind, but its sixteen bytes are not
  // all zero — bytes 10 and 11 are 0xff. Checking the raw bytes misses it, which is
  // the kind of near-miss that makes a security check feel done while it is not.
  const canonical = normalize(address)
  if (canonical === undefined) return false
  const bytes = toBytes(canonical)
  return bytes !== undefined && bytes.every((byte) => byte === 0)
}

function inRange(bytes: Bytes, range: Range): boolean {
  const [cidrAddress, prefixText] = range.cidr.split('/')
  const cidrBytes = toBytes(cidrAddress!)
  if (cidrBytes === undefined || cidrBytes.length !== bytes.length) return false

  let bits = Number(prefixText)
  for (let i = 0; i < bytes.length && bits > 0; i += 1) {
    const take = Math.min(8, bits)
    const mask = (0xff << (8 - take)) & 0xff
    if ((bytes[i]! & mask) !== (cidrBytes[i]! & mask)) return false
    bits -= take
  }
  return true
}

export type RangeVerdict =
  | { readonly ok: true; readonly what: string }
  | { readonly ok: false; readonly why: 'wide-bind' | 'not-an-address' | 'out-of-range' }

/**
 * `loopbackAllowed` is true only when the address was written down as `address` in
 * the config, never when it was auto-detected.
 */
export function classify(address: string, loopbackAllowed: boolean): RangeVerdict {
  const bytes = toBytes(address)
  if (bytes === undefined) return { ok: false, why: 'not-an-address' }

  // Checked before the ranges: 0.0.0.0 is not "out of range", it is the one thing
  // this project never negotiates, and it deserves its own message.
  if (isWideBind(address)) return { ok: false, why: 'wide-bind' }

  const candidates = loopbackAllowed
    ? [...PRIVATE_RANGES, ...LOOPBACK_RANGES]
    : PRIVATE_RANGES

  for (const range of candidates) {
    if (inRange(bytes, range)) return { ok: true, what: range.what }
  }
  return { ok: false, why: 'out-of-range' }
}

export function isLoopback(address: string): boolean {
  const bytes = toBytes(address)
  if (bytes === undefined) return false
  return LOOPBACK_RANGES.some((range) => inRange(bytes, range))
}
