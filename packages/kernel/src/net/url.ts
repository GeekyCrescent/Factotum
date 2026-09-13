/**
 * Composing the address the phone will be pointed at.
 *
 * An IPv6 address needs brackets in a URL. Without them the string is invalid: the
 * QR carries something no phone will open, and no origin ever matches — a failure
 * that would surface as "the whole thing is broken" rather than as a formatting bug.
 */

import { isIPv6 } from 'node:net'
import { stripZone } from './ranges.ts'

export function baseUrl(address: string, port: number): string {
  const bare = stripZone(address)
  const host = isIPv6(bare) ? `[${bare}]` : bare
  return `http://${host}:${port}`
}
