/**
 * The digests on disk: one file per run, `<stateDir>/digests/<id>.json` (spec 2026-10-05, D8;
 * criterion 21).
 *
 * THE ID IS CHECKED BEFORE THE DISK IS TOUCHED. It arrives from a URL (`GET /digests/:id`), and only
 * `DIGEST_ID` reaches a path: no `..`, no `/`, nothing else.
 *
 * NOTHING HERE THROWS ON READ. A file that does not parse is skipped with a warning, the way a broken
 * line of a log is: one bad digest does not take the history with it.
 */

import { readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from '@factotum/core'
import type { Digest, DigestSummary } from '../types.ts'

/** Local start time, `YYYY-MM-DDTHHmm`, with `-2`, `-3`… when two runs share a minute. Sorts with `ls`. */
export const DIGEST_ID = /^\d{4}-\d{2}-\d{2}T\d{4}(-\d+)?$/

export interface DigestStore {
  /** Synchronous, so `runNow` can answer with the id at once. Never hands out the same id twice. */
  readonly nextId: (startedAt: Date) => string
  /** Temp + rename: a reader never sees half a digest. */
  readonly write: (digest: Digest) => Promise<void>
  readonly get: (id: string) => Promise<Digest | undefined>
  readonly latest: () => Promise<Digest | undefined>
  readonly list: (limit: number) => Promise<readonly DigestSummary[]>
  /** By the date in the NAME, not the mtime: a copied or touched file keeps its age. */
  readonly prune: (keepDays: number, now: Date) => Promise<number>
}

/** Reads the directory once, so `nextId` knows what is taken without touching the disk again. */
export async function openDigestStore(dir: string, log: Logger): Promise<DigestStore> {
  const taken = new Set(await idsIn(dir))

  const read = async (id: string): Promise<Digest | undefined> => {
    let text
    try {
      text = await readFile(join(dir, `${id}.json`), 'utf8')
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') log.warn(`digest ${id} could not be read`)
      return undefined
    }
    try {
      const value = JSON.parse(text) as Partial<Digest> | null
      if (value === null || typeof value !== 'object' || value.id !== id || !Array.isArray(value.entries)) throw new Error('shape')
      return value as Digest
    } catch {
      log.warn(`digest ${id} is broken and was skipped`)
      return undefined
    }
  }

  const newestFirst = async (): Promise<readonly string[]> => (await idsIn(dir)).sort(compareIds).reverse()

  return {
    nextId: (startedAt) => {
      const base = idFor(startedAt)
      let id = base
      for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`
      taken.add(id)
      return id
    },

    write: async (digest) => {
      if (!DIGEST_ID.test(digest.id)) throw new Error('a digest id must match DIGEST_ID')
      const file = join(dir, `${digest.id}.json`)
      const temp = `${file}.tmp`
      await writeFile(temp, `${JSON.stringify(digest)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temp, file)
      taken.add(digest.id)
    },

    get: async (id) => (DIGEST_ID.test(id) ? await read(id) : undefined),

    latest: async () => {
      for (const id of await newestFirst()) {
        const digest = await read(id)
        if (digest !== undefined) return digest
      }
      return undefined
    },

    list: async (limit) => {
      const summaries: DigestSummary[] = []
      for (const id of await newestFirst()) {
        if (summaries.length >= limit) break
        const digest = await read(id)
        if (digest === undefined) continue
        const todo = digest.entries.filter((entry) => entry.category === 'action')
        summaries.push({
          id: digest.id,
          state: digest.state,
          startedAt: digest.startedAt,
          todo: todo.length,
          high: todo.filter((entry) => entry.priority === 'high').length,
        })
      }
      return summaries
    },

    prune: async (keepDays, now) => {
      // CALENDAR days, like the local times in the names: `keepDays × 24 h` is off by an hour across
      // a daylight-saving change (measured: Sydney moved on 2026-10-04).
      const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - keepDays, now.getHours(), now.getMinutes()).getTime()
      let removed = 0
      for (const id of await idsIn(dir)) {
        if (dateOf(id).getTime() >= cutoff) continue
        try {
          await unlink(join(dir, `${id}.json`))
          removed += 1
        } catch (error) {
          log.warn(`digest ${id} could not be pruned: ${(error as { code?: unknown }).code ?? 'error'}`)
        }
      }
      return removed
    },
  }
}

async function idsIn(dir: string): Promise<string[]> {
  const names = await readdir(dir)
  return names.flatMap((name) => {
    const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : ''
    return DIGEST_ID.test(id) ? [id] : []
  })
}

/** `…T0812` < `…T0812-2` < `…T0812-10`: by the minute, then by the suffix as a NUMBER. */
function compareIds(a: string, b: string): number {
  const [baseA = '', suffixA = '1'] = a.split('-').length > 3 ? [a.slice(0, a.lastIndexOf('-')), a.slice(a.lastIndexOf('-') + 1)] : [a]
  const [baseB = '', suffixB = '1'] = b.split('-').length > 3 ? [b.slice(0, b.lastIndexOf('-')), b.slice(b.lastIndexOf('-') + 1)] : [b]
  return baseA === baseB ? Number(suffixA) - Number(suffixB) : baseA < baseB ? -1 : 1
}

function idFor(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}`
}

/** The local time in the name. */
function dateOf(id: string): Date {
  const [year, month, day, hour, minute] = [id.slice(0, 4), id.slice(5, 7), id.slice(8, 10), id.slice(11, 13), id.slice(13, 15)].map(Number)
  return new Date(year!, month! - 1, day!, hour!, minute!)
}
