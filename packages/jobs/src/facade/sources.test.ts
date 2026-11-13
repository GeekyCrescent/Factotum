import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'

import { queueStore } from '../ai/test-queue.ts'
import { builderStore, FAKE_CHROMIUM, FAKE_CLAUDE, FAKE_PDFINFO, FAKE_PDFTOPPM, FONT, scriptChromium } from '../build/test-builder.ts'
import { DOC } from '../build/test-cv.ts'
import { parseJobsConfig, type HostConfig } from '../config.ts'
import { rigIn } from '../test-jobs.ts'
import { errorOf, valueOf } from '../test-state.ts'
import { capturedLog, realTimers, tempBase } from '../test-support.ts'
import { checkPaths, confinedArtifact, pathWarnings, printer, readFont, vaultReader } from './sources.ts'

const ALL_OK = { vault: 'ok', cvMaster: 'ok', guide: 'ok', seedCompanies: 'ok', seedKit: 'ok', seedCvs: 'ok', seedPackages: 'ok', chromium: 'ok', pdfinfo: 'ok', pdftoppm: 'ok', font: 'ok', claude: 'ok' } as const

function hostOf(raw: unknown): HostConfig {
  const parsed = parseJobsConfig(raw)
  if (!parsed.ok || parsed.config.mode !== 'host') return assert.fail(parsed.ok ? 'not a host' : parsed.reason)
  return parsed.config
}

const vaultIn = (root: string): HostConfig['vault'] => ({
  root,
  cvMaster: 'cv-maestro.md',
  guide: 'guide.md',
  seed: { companies: 'companies.json', kit: 'kit.md', cvs: 'cvs.md', packages: [] },
})

test('C1 sources: the master CV, the guide and the base CVs are read at each call; a missing one says which, without the path', () => {
  using base = tempBase()
  const reader = vaultReader(vaultIn(base.dir))
  errorOf(reader.master(), 'module-error', 'jobs: the master CV cannot be read (ENOENT)')

  writeFileSync(join(base.dir, 'cv-maestro.md'), '# Master')
  assert.equal(valueOf(reader.master()), '# Master')
  errorOf(reader.fixed(), 'module-error', 'jobs: the guide cannot be read (ENOENT)')
  errorOf(reader.sources(), 'module-error')

  writeFileSync(join(base.dir, 'guide.md'), '# Guide')
  assert.deepEqual(valueOf(reader.sources()), { master: '# Master', guide: '# Guide', bases: {} }, 'no base CVs file: no bases')
  writeFileSync(join(base.dir, 'cvs.md'), '## A\nBase A.\n')
  assert.equal(typeof valueOf(reader.sources()).bases, 'object')
})

test('C1 sources: the font that cannot be read is null; the path lines name no path', () => {
  assert.equal(
    readFont(() => {
      throw new Error('EACCES')
    }),
    null,
  )
  assert.ok((readFont()?.byteLength ?? 0) > 0, 'the real asset reads')
  const lines = pathWarnings({ ...ALL_OK, cvMaster: 'missing', pdfinfo: 'missing', font: 'missing' })
  assert.equal(lines.length, 3)
  assert.ok(lines.every((line) => !line.includes('/')))
})

test('review 1a: the guide, each seed file and the claude binary are checked; a missing one is named, without its path', () => {
  // Arrange: a vault with only the master CV; claude on no PATH.
  using base = tempBase()
  writeFileSync(join(base.dir, 'cv-maestro.md'), '# Master')
  const config = hostOf({ ...rigIn(base.dir).config, vault: { ...vaultIn(base.dir), seed: { companies: 'companies.json', kit: 'kit.md', cvs: 'cvs.md', packages: [{ file: 'p1.md' }] } } })
  const bin = join(base.dir, 'bin')
  mkdirSync(bin)

  // Act
  const missing = checkPaths(config, FONT, { claudeBin: undefined, envPath: bin })

  // Assert
  assert.equal(missing.cvMaster, 'ok')
  for (const key of ['guide', 'seedCompanies', 'seedKit', 'seedCvs', 'seedPackages', 'claude'] as const) assert.equal(missing[key], 'missing', key)
  const lines = pathWarnings(missing)
  assert.ok(lines.includes('Vault: the guide for the agent is missing; every CV generation fails until it is there'))
  assert.ok(lines.includes('Claude: the claude binary is not on the daemon\'s PATH; every CV generation fails'))
  assert.ok(lines.includes('Vault: the base CVs file is missing'))
  assert.ok(lines.includes('Vault: a seed package file is missing; the import cannot read it'))
  assert.ok(lines.every((line) => !line.includes(base.dir)))

  // Arrange: all of them there, claude an executable on PATH.
  for (const name of ['guide.md', 'companies.json', 'kit.md', 'cvs.md', 'p1.md']) writeFileSync(join(base.dir, name), 'x')
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n')
  chmodSync(join(bin, 'claude'), 0o755)

  // Act
  const present = checkPaths(config, FONT, { claudeBin: undefined, envPath: `/nowhere${delimiter}${bin}` })

  // Assert
  for (const key of ['guide', 'seedCompanies', 'seedKit', 'seedCvs', 'seedPackages', 'claude'] as const) assert.equal(present[key], 'ok', key)
  assert.equal(checkPaths(config, FONT, { claudeBin: FAKE_CLAUDE, envPath: '' }).claude, 'ok', 'a configured binary by its path')
  assert.equal(checkPaths(config, FONT, { claudeBin: join(base.dir, 'guide.md'), envPath: '' }).claude, 'missing', 'not executable')
})

test('review 1a: a missing vault folder is one line, not one per file under it', () => {
  using base = tempBase()
  const config = hostOf({ ...rigIn(base.dir).config, vault: vaultIn(join(base.dir, 'gone')) })
  const lines = pathWarnings(checkPaths(config, FONT, { claudeBin: FAKE_CLAUDE, envPath: '' }))
  assert.deepEqual(
    lines.filter((line) => line.startsWith('Vault:')),
    ['Vault: the vault folder is missing'],
  )
})

test('C1 sources: a stored file is served only as a regular file of its kind under artifacts/', () => {
  using base = tempBase()
  const dir = join(base.dir, 'artifacts', 'a1', 'v1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cv.pdf'), '%PDF')
  writeFileSync(join(dir, 'preview.png'), 'png')
  writeFileSync(join(base.dir, 'outside.pdf'), '%PDF')
  symlinkSync(join(base.dir, 'outside.pdf'), join(dir, 'link.pdf'))
  mkdirSync(join(dir, 'folder.pdf'))

  assert.ok(confinedArtifact(base.dir, join(dir, 'cv.pdf'), '.pdf')?.endsWith('cv.pdf'))
  assert.ok(confinedArtifact(base.dir, 'artifacts/a1/v1/preview.png', '.png')?.endsWith('preview.png'), 'relative to the state folder')
  assert.equal(confinedArtifact(base.dir, join(dir, 'preview.png'), '.pdf'), null, 'not its kind')
  assert.equal(confinedArtifact(base.dir, join(base.dir, 'outside.pdf'), '.pdf'), null, 'outside artifacts/')
  assert.equal(confinedArtifact(base.dir, join(dir, 'link.pdf'), '.pdf'), null, 'a symlink out')
  assert.equal(confinedArtifact(base.dir, join(dir, 'folder.pdf'), '.pdf'), null, 'not a file')
  assert.equal(confinedArtifact(base.dir, join(dir, 'gone.pdf'), '.pdf'), null)
  assert.equal(confinedArtifact(join(base.dir, 'nowhere'), join(dir, 'cv.pdf'), '.pdf'), null)
})

test('C1 sources: the rewrite\'s printer prints with today\'s profile into the version folder; failures are results', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  const deps = { stateDir: base.dir, timers: realTimers, log: capturedLog().log, font: FONT, chromium: FAKE_CHROMIUM, poppler: { pdfinfo: FAKE_PDFINFO, pdftoppm: FAKE_PDFTOPPM } }
  const signal = new AbortController().signal

  const printed = valueOf(await printer(db, deps)({ applicationId: 'app-1', version: 2, cv: DOC, signal }))
  assert.ok(existsSync(printed.pdf ?? '') && existsSync(printed.png ?? ''))
  assert.equal(printed.pages, 1)
  assert.match(printed.contactHash ?? '', /^[0-9a-f]{64}$/)

  scriptChromium(base.dir, 'fail')
  errorOf(await printer(db, deps)({ applicationId: 'app-1', version: 3, cv: DOC, signal }), 'module-error')
  errorOf(await printer(db, deps)({ applicationId: '../escape', version: 3, cv: DOC, signal }), 'module-error')

  using empty = tempBase()
  const bare = await queueStore(empty)
  bare.tx((q) => (q.run('DELETE FROM profile_versions'), { ok: true, value: undefined }))
  errorOf(await printer(bare, { ...deps, stateDir: empty.dir })({ applicationId: 'app-1', version: 2, cv: DOC, signal }), 'module-error', 'there is no profile to print with')
})
