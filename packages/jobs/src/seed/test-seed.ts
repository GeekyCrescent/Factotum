/**
 * Test-only helpers of the seed import (tasks S5–S7): the fixture vault, a store with a profile, the
 * double of the generation queue (G2a) and a spy for the address checks (N4).
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadProfileSeed } from '../profile.ts'
import { openDb, type Db } from '../store/db.ts'
import { insertProfileVersion } from '../store/repo.ts'
import type { TempBase } from '../test-support.ts'
import { ok, type Profile } from '../types.ts'
import type { ImportContext, SeedPackage, SeedVault } from './import.ts'

export const NOW = new Date('2026-11-14T00:00:00.000Z')
export const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url))

export const ADS = 'package-ads.md'
export const WAVE1 = 'package-wave1.md'
export const WAVE2 = 'package-wave2.md'
export const HOLD = '2027-01-12'

/** The fixtures in their entry counts: 7 ads, 6 of wave 1, 9 of wave 2. */
export const COUNTS = { [ADS]: 7, [WAVE1]: 6, [WAVE2]: 9 } as const

export const DEFAULT_PACKAGES: readonly SeedPackage[] = [{ file: ADS }, { file: WAVE1 }, { file: WAVE2, holdUntil: HOLD }]

export function vaultOf(packages: readonly SeedPackage[] = DEFAULT_PACKAGES): SeedVault {
  return { root: FIXTURES, seed: { companies: 'companies.json', kit: 'kit.md', cvs: 'cvs.md', packages } }
}

export function seedProfile(identity: Partial<Profile['identity']> = {}): Profile {
  const seeded = loadProfileSeed()
  if (!seeded.ok) assert.fail(seeded.error.reason)
  return { ...seeded.value, identity: { ...seeded.value.identity, ...identity } }
}

/** A store with one profile version (the seed's, with a phone unless told otherwise). */
export async function storeWith(base: TempBase, profile: Profile = seedProfile()): Promise<Db> {
  const opened = await openDb({ dir: base.dir, now: () => NOW })
  if (!opened.ok) assert.fail(opened.error.reason)
  const db = opened.value
  const saved = db.tx((q) => {
    insertProfileVersion(q, { version: 1, createdAt: NOW.toISOString(), profile }, { kind: 'profile-saved' }, NOW)
    return ok(undefined)
  })
  if (!saved.ok) assert.fail(saved.error.reason)
  return db
}

export function context(overrides: Partial<ImportContext> = {}): ImportContext {
  return {
    now: () => NOW,
    timeZone: 'Australia/Sydney',
    vault: vaultOf(),
    ...overrides,
  }
}

/** A reader that serves `replace[file]` instead of the fixture of that name. */
export function readerWith(replace: Readonly<Record<string, string>>): (path: string) => Promise<string> {
  return async (path) => {
    const name = Object.keys(replace).find((file) => path.endsWith(`/${file}`))
    return name === undefined ? readFile(path, 'utf8') : (replace[name] ?? '')
  }
}

export const fixture = (name: string): Promise<string> => readFile(`${FIXTURES}${name}`, 'utf8')

export const count = (db: Db, table: string): number => db.read((q) => Number(q.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0))
