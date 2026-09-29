import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enableSessions, FREE_ENTRY, listSites, sessionsState } from './site.ts'

/**
 * What is left of editing the config from `factotum site`: reading it, and switching the module on
 * (spec 2026-09-29, D1). Adding and removing projects is the daemon's alone now; see
 * `site-command.test.ts` for what `add` and `rm` say instead.
 */

const CONFIG = {
  environment: 'prod',
  listen: { address: '127.0.0.1', port: 7777 },
  publicOrigin: 'https://mimac.tail1234.ts.net',
  modules: {
    example: { enabled: true },
    sessions: {
      enabled: true,
      sites: [{ id: 'notes', path: '/home/me/notes' }],
      sharedPaths: ['/home/me/vault'],
      catalog: [{ id: 'review', label: 'Review', invoke: { kind: 'command', name: 'code-review' } }],
    },
  },
}

const sessions = (config: unknown) =>
  (config as { modules: { sessions: { enabled?: boolean; sites?: unknown[]; catalog: { id: string }[] } } }).modules.sessions

test('listing reports the config’s sites and shared paths', () => {
  assert.deepEqual(listSites(CONFIG), { sites: [{ id: 'notes', path: '/home/me/notes' }], sharedPaths: ['/home/me/vault'] })
})

test('listing a config without the module is empty, not an error', () => {
  assert.deepEqual(listSites({ ...CONFIG, modules: {} }), { sites: [], sharedPaths: [] })
})

test('the module is on, off by somebody’s decision, or absent', () => {
  assert.equal(sessionsState(CONFIG), 'on')
  assert.equal(sessionsState({ ...CONFIG, modules: { sessions: { enabled: false } } }), 'off')
  assert.equal(sessionsState({ ...CONFIG, modules: { sessions: { sites: [] } } }), 'absent')
  assert.equal(sessionsState({ ...CONFIG, modules: {} }), 'absent')
})

test('switching it on gives an empty catalog the free prompt, and keeps the sites that will seed the registry', () => {
  const bare = { ...CONFIG, modules: { example: { enabled: true }, sessions: { sites: [{ id: 'w', path: '/home/me/w' }] } } }
  const result = enableSessions(bare)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(sessions(result.config).enabled, true)
  assert.deepEqual(sessions(result.config).catalog, [FREE_ENTRY])
  assert.deepEqual(sessions(result.config).sites, [{ id: 'w', path: '/home/me/w' }])
})

test('switching it on keeps a catalog that already has entries', () => {
  const result = enableSessions({ ...CONFIG, modules: { sessions: { ...CONFIG.modules.sessions, enabled: undefined } } })
  assert.deepEqual(result.ok ? sessions(result.config).catalog.map((e) => e.id) : null, ['review'])
})

test('the result validates against the ROOT schema AND the module’s, so it is a config that starts', () => {
  const root = enableSessions({ ...CONFIG, publicOrigin: 'https://x.ts.net/' })
  assert.equal(root.ok, false)
  assert.match(root.ok ? '' : root.error, /publicOrigin/)
  const fragment = enableSessions({ ...CONFIG, modules: { sessions: { sites: [{ id: 'Bad Id', path: '/x' }] } } })
  assert.equal(fragment.ok, false)
  assert.match(fragment.ok ? '' : fragment.error, /^sessions\./)
})
