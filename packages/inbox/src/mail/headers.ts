/**
 * The few raw headers a digest reads (spec 2026-10-05, D4), out of the block `FETCH BODY.PEEK[HEADER.FIELDS (…)]`
 * returns. Pure.
 */

/** Lower-cased names; a header that comes twice (`Delivered-To` does) keeps every value, in order. */
export function parseHeaderBlock(block: string): ReadonlyMap<string, readonly string[]> {
  const headers = new Map<string, string[]>()
  // Unfold first: a continuation line starts with a blank and belongs to the line above (RFC 5322 §2.2.3).
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ')
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    headers.set(name, [...(headers.get(name) ?? []), value])
  }
  return headers
}

const ADDRESS = /[^\s<>",;:()[\]]+@[^\s<>",;:()[\]]+/g

/** Every address in some header values, lower-cased, in order. Display names are dropped. */
export function addressesIn(values: readonly string[] | undefined): readonly string[] {
  return (values ?? []).flatMap((value) => (value.match(ADDRESS) ?? []).map((address) => address.toLowerCase()))
}
