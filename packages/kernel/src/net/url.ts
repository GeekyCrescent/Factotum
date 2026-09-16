/**
 * Composing the origin this process listens on.
 *
 * Two things have to be right, and the second one only started mattering when the
 * origin policy became a raw string comparison.
 *
 * An IPv6 address needs brackets in a URL. Without them the string is invalid and no
 * origin ever matches — a failure that surfaces as "the whole thing is broken"
 * rather than as a formatting bug.
 *
 * AND IT HAS TO BE CANONICAL. A bind written `0:0:0:0:0:0:0:1` in the config and the
 * `::1` a browser sends are the same place and two different strings, and the policy
 * compares with `===`. `new URL(...).origin` collapses both spellings to one, so the
 * canonicalisation happens ONCE here, at composition time, instead of on every
 * request — which is what lets `origin.ts` contain no parsing at all.
 */

import { isIPv6 } from 'node:net'
import { stripZone } from './ranges.ts'

export function localUrl(address: string, port: number): string {
  const bare = stripZone(address)
  const host = isIPv6(bare) ? `[${bare}]` : bare
  return new URL(`http://${host}:${port}`).origin
}
