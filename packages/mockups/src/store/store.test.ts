import assert from 'node:assert/strict'
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { captureLog, mockup, NOW } from '../test-support.ts'
import type { MockupsFile } from '../types.ts'
import { MOCKUPS_FILE, openStore } from './store.ts'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mockups-store-'))
})
afterEach(async () => {
  await chmod(dir, 0o700).catch(() => undefined)
  await rm(dir, { recursive: true, force: true })
})

const add = (id: string) => (file: MockupsFile) => ({ ok: true as const, value: { file: { ...file, mockups: [...file.mockups, mockup({ id })] } } })

test('no file yet: an empty one is written, and the store opens on it', async () => {
  const opened = await openStore({ dir, now: NOW, log: captureLog() })
  assert.equal(opened.ok, true)
  const written = JSON.parse(await readFile(join(dir, MOCKUPS_FILE), 'utf8'))
  assert.deepEqual(written, { version: 1, mockups: [] })
})

test('a change lands on disk before it lands in memory, and both carry it', async () => {
  const opened = await openStore({ dir, now: NOW, log: captureLog() })
  assert.ok(opened.ok)
  const result = await opened.store.change(add('m1'))
  assert.equal(result.ok, true)
  assert.equal(opened.store.current().mockups.length, 1)
  const reopened = await openStore({ dir, now: NOW, log: captureLog() })
  assert.ok(reopened.ok)
  assert.equal(reopened.store.current().mockups[0]?.id, 'm1')
})

test('two changes that arrive together both land: each runs on the file of its moment', async () => {
  const opened = await openStore({ dir, now: NOW, log: captureLog() })
  assert.ok(opened.ok)
  await Promise.all([opened.store.change(add('a')), opened.store.change(add('b'))])
  assert.deepEqual(
    opened.store.current().mockups.map((m) => m.id),
    ['a', 'b'],
  )
})

test('an op that refuses leaves everything as it was; one that throws answers module-error', async () => {
  const log = captureLog()
  const opened = await openStore({ dir, now: NOW, log })
  assert.ok(opened.ok)
  const refused = await opened.store.change(() => ({ ok: false, error: { code: 'conflict', reason: 'no' } }))
  assert.deepEqual(refused, { ok: false, error: { code: 'conflict', reason: 'no' } })
  const thrown = await opened.store.change(() => {
    throw new Error('boom')
  })
  assert.equal(thrown.ok ? null : thrown.error.code, 'module-error')
  assert.equal(opened.store.current().mockups.length, 0)
})

test('a write that fails leaves memory as it was (criterion 3, the disk first)', async () => {
  const opened = await openStore({ dir, now: NOW, log: captureLog() })
  assert.ok(opened.ok)
  await chmod(dir, 0o500)
  const result = await opened.store.change(add('m1'))
  assert.equal(result.ok ? null : result.error.code, 'module-error')
  assert.equal(opened.store.current().mockups.length, 0)
})

test('crit. 3: a damaged file is never overwritten — copied to .bad-<date>, and the store refuses', async () => {
  await writeFile(join(dir, MOCKUPS_FILE), '{"version":1,"mockups":[{"id":3}]}')
  const opened = await openStore({ dir, now: NOW, log: captureLog() })
  assert.equal(opened.ok, false)
  assert.match(opened.ok ? '' : opened.reason, /damaged .* copy in mockups\.json\.bad-2026-11-12T/)
  const files = await readdir(dir)
  assert.ok(files.some((f) => f.startsWith(`${MOCKUPS_FILE}.bad-`)))
  assert.equal(await readFile(join(dir, MOCKUPS_FILE), 'utf8'), '{"version":1,"mockups":[{"id":3}]}')
})

test('a file that is not JSON is damaged too', async () => {
  await writeFile(join(dir, MOCKUPS_FILE), 'not json')
  const opened = await openStore({ dir, now: NOW, log: captureLog() })
  assert.match(opened.ok ? '' : opened.reason, /it is not JSON/)
})

test('a full mockup survives the schema: what the store writes, it reads back', async () => {
  const opened = await openStore({ dir, now: NOW, log: captureLog() })
  assert.ok(opened.ok)
  const full = mockup({
    id: 'm1',
    buildSiteId: 'mtc',
    buildRefused: 'inside a project',
    inputs: [{ name: 'a.pdf', kind: 'pdf', bytes: 3, private: false, at: NOW.toISOString() }],
    urls: { preview: 'https://a.vercel.app' },
  })
  const withRun = {
    ...full,
    stages: {
      ...full.stages,
      brief: {
        status: 'running' as const,
        version: 1,
        run: { id: 'r', kind: 'brief' as const, siteId: 'personal', startedAt: NOW.toISOString(), redo: { comment: 'c', fromVersion: 1 } },
        pendingComment: 'p',
        summary: 's',
        options: [{ id: 'a', title: 'A', blurb: 'b', url: 'https://x.vercel.app' }],
        chosen: 'a',
        history: [{ at: NOW.toISOString(), action: 'redo' as const, version: 1, comment: 'c' }],
      },
    },
  }
  await opened.store.change((file) => ({ ok: true, value: { file: { ...file, mockups: [withRun] } } }))
  const reopened = await openStore({ dir, now: NOW, log: captureLog() })
  assert.ok(reopened.ok)
  assert.deepEqual(reopened.store.current().mockups[0], withRun)
})
