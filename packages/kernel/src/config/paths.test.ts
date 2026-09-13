import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { moduleStateDir, resolveEnvironment, statePaths } from './paths.ts'

test('each environment gets its own root, config and module directory', () => {
  const dev = statePaths('dev', '/home/x')
  const prod = statePaths('prod', '/home/x')

  assert.equal(dev.root, join('/home/x', '.factotum', 'dev'))
  assert.equal(prod.root, join('/home/x', '.factotum', 'prod'))
  assert.notEqual(dev.root, prod.root)
  assert.equal(dev.config, join(dev.root, 'config.json'))
})

test('a module writes under its own id inside its environment', () => {
  const paths = statePaths('prod', '/home/x')
  assert.equal(moduleStateDir(paths, 'example'), join(paths.modules, 'example'))
})

test('--env beats the environment variable, which beats prod', () => {
  assert.equal(resolveEnvironment('dev', 'prod'), 'dev')
  assert.equal(resolveEnvironment(undefined, 'dev'), 'dev')
  assert.equal(resolveEnvironment(undefined, undefined), 'prod')
})

test('an unrecognised environment is refused, naming where it came from', () => {
  assert.throws(() => resolveEnvironment('staging', undefined), /--env=staging/)
  assert.throws(() => resolveEnvironment(undefined, 'staging'), /FACTOTUM_ENV=staging/)
})

test('creating the state roots is idempotent', async () => {
  const { mkdtemp, stat } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { ensureStateRoots } = await import('./paths.ts')

  const home = await mkdtemp(join(tmpdir(), 'factotum-'))
  const paths = statePaths('prod', home)

  await ensureStateRoots(paths)
  await ensureStateRoots(paths) // twice: restarting must not fail

  assert.equal((await stat(paths.modules)).isDirectory(), true)
})
