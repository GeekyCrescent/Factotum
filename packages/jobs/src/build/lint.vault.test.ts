import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { importSeed, type SeedVault } from '../seed/import.ts'
import { context, NOW, queueDouble, seedProfile, storeWith } from '../seed/test-seed.ts'
import * as repo from '../store/repo.ts'
import { tempBase } from '../test-support.ts'
import { ok, type Warning } from '../types.ts'
import { createLinter } from './relint.ts'

// tasks L5: the REAL linter (L1–L2, external-link and every rule) over the 43 real entries the module
// sends — the 18 of the ads (02) and the 25 of wave 1 (03) — imported from the S7 dry run, with the
// seed profile as it ships (phone, portfolio, suburb, timezone). READ ONLY: the store is a temp one
// and the vault's files are checked unchanged after. SKIPPED unless JOBS_VAULT_ROOT points at the
// vault (`JOBS_VAULT_ROOT=~/Ferro/Obsidian/Personal`), so CI never reads it.
//
// The CVs are not generated here (no Claude): every entry has `missing-cv`, which is expected and set
// apart. What it reports is every OTHER block — what would still hold an entry once its CV is back.

const RAW_ROOT = process.env.JOBS_VAULT_ROOT
const ROOT = RAW_ROOT?.startsWith('~/') ? join(homedir(), RAW_ROOT.slice(2)) : RAW_ROOT
const skip = ROOT === undefined || ROOT === '' ? 'JOBS_VAULT_ROOT is not set: the real vault is only read on demand' : false

const PACKAGE = '03-life/carrera/postulaciones/paquete-2027'
const MASTER = '03-life/carrera/cv-maestro.md'

/** design D13, the config of `jobs.vault.seed`, relative to the root (as S7). */
const VAULT: SeedVault = {
  root: ROOT ?? '',
  seed: {
    companies: '03-life/carrera/postulaciones/datos/empresas-2026-11-10.json',
    kit: `${PACKAGE}/00-kit-base.md`,
    cvs: `${PACKAGE}/01-cvs.md`,
    packages: [
      { file: `${PACKAGE}/02-postulaciones-anuncios.md` },
      { file: `${PACKAGE}/03-emails-ola-1.md` },
      { file: `${PACKAGE}/04-emails-ola-2.md`, holdUntil: '2027-01-12' },
    ],
  },
}

const FILES = [MASTER, VAULT.seed.companies, VAULT.seed.kit, VAULT.seed.cvs, ...VAULT.seed.packages.map((p) => p.file)]
const stamps = (): readonly string[] => FILES.map((file) => `${file} ${statSync(join(VAULT.root, file)).mtimeMs}`)

/** Expected before the CV comes back: set apart from what this test reports. */
const BEFORE_THE_CV = 'missing-cv'

const blocking = (warnings: readonly Warning[]): readonly Warning[] => warnings.filter((w) => w.blocks && w.code !== BEFORE_THE_CV)

test('L5: the real linter over the 43 real entries (ads + wave 1) with the seed profile', { skip }, async (t) => {
  using base = tempBase()
  const before = stamps()
  const db = await storeWith(base, seedProfile())
  const queue = queueDouble()
  const imported = await importSeed(db, context({ vault: VAULT, timeZone: 'Australia/Sydney', enqueueCv: queue.enqueueCv }), { dryRun: false })
  if (!imported.ok) assert.fail(`${imported.error.code}: ${imported.error.reason}`)
  assert.equal(queue.cv.length, 43, 'the 43 entries the module sends')

  const master = readFileSync(join(VAULT.root, MASTER), 'utf8')
  const linter = createLinter({ master: () => ok(master), pdfExists: () => false })
  const linted = db.read((q) =>
    queue.cv.map((id) => {
      const application = repo.getApplication(q, id)
      if (application === undefined) assert.fail(`no application ${id}`)
      const artifacts = repo.getArtifacts(q, id, application.version)
      if (artifacts === undefined) assert.fail(`no artifacts for ${id}`)
      const seedKey = q.get<{ seed_key: string }>('SELECT seed_key FROM applications WHERE id = ?', id)?.seed_key ?? id
      return { seedKey, channel: application.channel, warnings: linter.lint(q, { kind: 'application', application, artifacts }, NOW) }
    }),
  )
  db.close()
  assert.deepEqual(stamps(), before, 'the vault is not written')
  assert.equal(linted.length, 43)
  assert.ok(linted.every((entry) => entry.warnings.some((w) => w.code === BEFORE_THE_CV)), 'no CV yet: missing-cv on every one')

  const blocked = linted.filter((entry) => blocking(entry.warnings).length > 0)
  const byCode = new Map<string, number>()
  for (const entry of blocked) for (const code of new Set(blocking(entry.warnings).map((w) => w.code))) byCode.set(code, (byCode.get(code) ?? 0) + 1)
  const details = [...new Set(linted.flatMap((entry) => blocking(entry.warnings).map((w) => `${w.code} · ${w.where} · ${w.detail}`)))].sort()

  t.diagnostic(`blocked (besides ${BEFORE_THE_CV}): ${blocked.length} of ${linted.length}`)
  t.diagnostic(`by code (entries): ${JSON.stringify(Object.fromEntries([...byCode].sort()))}`)
  for (const detail of details) t.diagnostic(`detail: ${detail}`)
  for (const entry of blocked) t.diagnostic(`entry ${entry.seedKey} (${entry.channel}): ${blocking(entry.warnings).map((w) => `${w.code}[${w.where}] ${w.detail}`).join(' | ')}`)
  const advisory = [...new Set(linted.flatMap((entry) => entry.warnings.filter((w) => !w.blocks).map((w) => `${w.code} · ${w.where} · ${w.detail}`)))].sort()
  for (const line of advisory) t.diagnostic(`advisory: ${line}`)
})
