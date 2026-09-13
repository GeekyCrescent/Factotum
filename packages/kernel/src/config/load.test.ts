import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { FactotumModule } from '@factotum/core'
import { BootError } from '../errors.ts'
import { composeModules, loadRootConfig } from './load.ts'
import { statePaths } from './paths.ts'

async function tempHome(config?: unknown): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'factotum-'))
  if (config !== undefined) {
    const paths = statePaths('prod', home)
    await mkdir(paths.root, { recursive: true })
    await writeFile(paths.config, JSON.stringify(config), 'utf8')
  }
  return home
}

const valid = {
  environment: 'prod',
  listen: { address: '100.87.1.2', port: 7777 },
  modules: { example: { enabled: true, greeting: 'hi' } },
}

// ---------------------------------------------------------------------------
// loadRootConfig
// ---------------------------------------------------------------------------

test('reads and validates a good config', async () => {
  const home = await tempHome(valid)
  const config = await loadRootConfig('prod', statePaths('prod', home))
  assert.equal(config.listen.port, 7777)
})

test('a missing config tells you to run init', async () => {
  const home = await tempHome()
  await assert.rejects(
    () => loadRootConfig('prod', statePaths('prod', home)),
    (error: BootError) => {
      assert.equal(error.code, 'config-unreadable')
      assert.match(error.remedy, /factotum init/)
      return true
    },
  )
})

test('broken JSON says so instead of throwing a parse error', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-'))
  const paths = statePaths('prod', home)
  await mkdir(paths.root, { recursive: true })
  await writeFile(paths.config, '{ not json', 'utf8')

  await assert.rejects(
    () => loadRootConfig('prod', paths),
    (error: BootError) => error.code === 'config-invalid',
  )
})

test('an invalid root config names the key that is wrong', async () => {
  const home = await tempHome({ ...valid, listen: { port: 7777 } })
  await assert.rejects(
    () => loadRootConfig('prod', statePaths('prod', home)),
    (error: BootError) => {
      assert.equal(error.code, 'config-invalid')
      assert.match(error.message, /listen/)
      return true
    },
  )
})

test('a config from the other environment aborts with both values named', async () => {
  // The foot-gun this exists for: copying prod/config.json into dev/ to test quickly.
  const home = await mkdtemp(join(tmpdir(), 'factotum-'))
  const devPaths = statePaths('dev', home)
  await mkdir(devPaths.root, { recursive: true })
  await writeFile(devPaths.config, JSON.stringify(valid), 'utf8')

  await assert.rejects(
    () => loadRootConfig('dev', devPaths),
    (error: BootError) => {
      assert.equal(error.code, 'environment-mismatch')
      assert.match(error.message, /"prod"/)
      assert.match(error.message, /"dev"/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// composeModules — abort versus degrade
// ---------------------------------------------------------------------------

const example: FactotumModule<{ greeting: string }> = {
  id: 'example',
  configSchema: z.object({ greeting: z.string() }),
}

const other: FactotumModule = { id: 'other' }

test('an enabled module gets its parsed fragment', () => {
  const [composed] = composeModules([example], { example: { enabled: true, greeting: 'hi' } })
  assert.equal(composed?.status.kind, 'enabled')
  assert.deepEqual(composed?.config, { greeting: 'hi' })
})

test('a module that is off is not loaded at all', () => {
  assert.deepEqual(composeModules([example], { example: { enabled: false, greeting: 'hi' } }), [])
  assert.deepEqual(composeModules([example], {}), [])
})

test('an invalid fragment disables that module and leaves the rest running', () => {
  const composed = composeModules([example, other], {
    example: { enabled: true, greeting: 42 },
    other: { enabled: true },
  })

  const bad = composed.find((c) => c.module.id === 'example')
  assert.equal(bad?.status.kind, 'disabled')
  assert.match(
    bad?.status.kind === 'disabled' ? bad.status.reason : '',
    /modules\.example\.greeting/,
  )

  // The whole point: one bad credential path cannot leave its owner with nothing.
  assert.equal(composed.find((c) => c.module.id === 'other')?.status.kind, 'enabled')
})

test('an off module with a broken fragment is not even validated', () => {
  assert.deepEqual(composeModules([example], { example: { enabled: false, greeting: 42 } }), [])
})

test('two modules with the same id abort, naming the id', () => {
  assert.throws(
    () => composeModules([example, { id: 'example' }], {}),
    (error: BootError) => {
      assert.equal(error.code, 'module-id-duplicate')
      assert.match(error.message, /"example"/)
      return true
    },
  )
})

test('an id that would escape the state directory aborts', () => {
  assert.throws(
    () => composeModules([{ id: '../etc' }], {}),
    (error: BootError) => error.code === 'module-id-invalid',
  )
})

test('a module without a schema still runs when enabled', () => {
  const [composed] = composeModules([other], { other: { enabled: true } })
  assert.equal(composed?.status.kind, 'enabled')
  assert.equal(composed?.config, undefined)
})
