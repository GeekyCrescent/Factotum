import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { sessionPaths } from './paths.ts'

const ROOT = '/state/modules/sessions'

test('every path hangs off the root it was handed, and nothing composes one from ~', () => {
  const paths = sessionPaths(ROOT)
  assert.equal(paths.root, ROOT)
  assert.equal(paths.locks, join(ROOT, 'locks'))
  assert.equal(paths.sessions, join(ROOT, 'sessions'))
})

test('the lock is per SITE, because the lock is what makes a site exclusive', () => {
  assert.equal(sessionPaths(ROOT).lockFile('work'), join(ROOT, 'locks', 'work.json'))
})

test('a session owns a directory with its three files', () => {
  const paths = sessionPaths(ROOT)
  const id = '019965aa-0000-7000-8000-000000000001'
  assert.equal(paths.sessionDir(id), join(ROOT, 'sessions', id))
  assert.equal(paths.metaFile(id), join(ROOT, 'sessions', id, 'meta.json'))
  assert.equal(paths.eventsFile(id), join(ROOT, 'sessions', id, 'events.jsonl'))
  assert.equal(paths.settingsFile(id), join(ROOT, 'sessions', id, 'settings.json'))
})

test('two roots never meet, which is how dev and prod keep separate sessions', () => {
  const dev = sessionPaths('/home/.factotum/dev/modules/sessions')
  const prod = sessionPaths('/home/.factotum/prod/modules/sessions')
  assert.notEqual(dev.lockFile('work'), prod.lockFile('work'))
})
