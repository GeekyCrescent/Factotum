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

test('push state belongs to the daemon, so it hangs from the root and NOT from modules/', () => {
  // The VAPID pair identifies the daemon as a sender, and a module is promised it sees no
  // path outside its own stateDir — putting a key the kernel also reads under modules/
  // would break that sentence.
  const paths = statePaths('prod', '/home/x')

  assert.equal(paths.push, join(paths.root, 'push'))
  assert.equal(paths.push.startsWith(paths.modules), false)
})

test('the push directory is created owner-only, whatever the umask says', async () => {
  const { mkdtemp, stat } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { ensureStateRoots } = await import('./paths.ts')

  const home = await mkdtemp(join(tmpdir(), 'factotum-'))
  const paths = statePaths('prod', home)
  const previous = process.umask(0o000) // the loosest umask there is

  try {
    await ensureStateRoots(paths)
  } finally {
    process.umask(previous)
  }

  const mode = (await stat(paths.push)).mode & 0o777
  assert.equal(mode, 0o700, `push/ must be 0700, got ${mode.toString(8)}`)
})
