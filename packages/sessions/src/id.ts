/**
 * UUIDv7: a random id with the time in front of it.
 *
 * Written out rather than taken from a dependency because it is twelve lines and the
 * project has no runtime dependencies beyond zod.
 *
 * The time prefix is the whole reason. Sorting by id IS sorting by time, so listing
 * the most recent sessions costs the same with five thousand of them as with fifty,
 * and no in-memory index is needed to do it — which is the one thing the predecessor
 * needed an index for. `node:crypto`'s `randomUUID` is v4 and sorts arbitrarily.
 */

import { randomFillSync } from 'node:crypto'

const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16)
  randomFillSync(bytes)

  // 48 bits of milliseconds since the epoch, big-endian, in bytes 0-5.
  const ms = Math.max(0, Math.floor(now))
  bytes[0] = (ms / 2 ** 40) & 0xff
  bytes[1] = (ms / 2 ** 32) & 0xff
  bytes[2] = (ms / 2 ** 24) & 0xff
  bytes[3] = (ms / 2 ** 16) & 0xff
  bytes[4] = (ms / 2 ** 8) & 0xff
  bytes[5] = ms & 0xff

  // Version 7 in the high nibble of byte 6, variant 10 in the top bits of byte 8.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80

  const hex = Array.from(bytes, (byte) => HEX[byte] ?? '00').join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
