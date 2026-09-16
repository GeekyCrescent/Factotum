import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addSite, deriveId, listSites, removeSite } from './site.ts'

/**
 * The editing is pure and tested here; the disk, the prompt and the restart live in
 * `site-command.ts`. That split is the same one `supervise.ts` and `install.ts` have,
 * and for the same reason: these are decisions about the permission boundary, and a
 * decision should not need a home directory to be tested.
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
      catalog: [{ id: 'free', label: 'Free prompt', invoke: { kind: 'none' } }],
    },
  },
}

const sessions = (config: unknown) =>
  (config as { modules: { sessions: { sites: { id: string; path: string }[]; sharedPaths?: string[] } } }).modules
    .sessions

// ---------------------------------------------------------------------------
// deriveId — the name you did not have to type
// ---------------------------------------------------------------------------

test('the id comes from the directory name, in the shape a lock file can have', () => {
  assert.equal(deriveId('/home/me/Ferro/Personal/Factotum'), 'factotum')
  assert.equal(deriveId('/home/me/My Notes'), 'my-notes')
  assert.equal(deriveId('/home/me/proyecto_2026'), 'proyecto-2026')
})

test('a name that derives to nothing usable is refused rather than guessed', () => {
  // `--id` exists for exactly this, and inventing `site-1` would produce ids nobody
  // can read in a denial message.
  assert.equal(deriveId('/home/me/___'), undefined)
  assert.equal(deriveId('/'), undefined)
})

// ---------------------------------------------------------------------------
// addSite
// ---------------------------------------------------------------------------

test('adding a site leaves every other part of the config alone', () => {
  // The whole risk of editing a config for someone: this must not be a rewrite.
  const result = addSite(CONFIG, { path: '/home/me/work' })
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.notEqual(result.config, CONFIG, 'the input is not mutated')
  assert.deepEqual(sessions(CONFIG).sites.length, 1, 'the original still has one site')
  assert.deepEqual(sessions(result.config).sites, [
    { id: 'notes', path: '/home/me/notes' },
    { id: 'work', path: '/home/me/work' },
  ])
  const modules = (result.config as { modules: Record<string, unknown> }).modules
  assert.deepEqual(modules['example'], { enabled: true })
})

test('an explicit id wins over the derived one', () => {
  const result = addSite(CONFIG, { path: '/home/me/work', id: 'chamba' })
  assert.equal(result.ok && sessions(result.config).sites[1]?.id, 'chamba')
})

test('a duplicate id is refused, because two directories cannot share one lock', () => {
  const result = addSite(CONFIG, { path: '/home/me/other', id: 'notes' })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.error, /notes/)
})

test('the same PATH twice is refused too, and says which id already has it', () => {
  // Not a schema rule — two ids on one directory is two locks over one tree, which is
  // the overlap trap in miniature. Caught here because here it is cheap.
  const result = addSite(CONFIG, { path: '/home/me/notes', id: 'notas' })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.error, /already declared as "notes"/)
})

test('a relative path is refused by the REAL schema, not by a copy of its rule', () => {
  const result = addSite(CONFIG, { path: 'relative/path' })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.error, /absolute/)
})

test('--shared puts the path in sharedPaths, which has no id', () => {
  const result = addSite(CONFIG, { path: '/home/me/vault', shared: true })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(sessions(result.config).sharedPaths, ['/home/me/vault'])
  assert.equal(sessions(result.config).sites.length, 1, 'sites untouched')
})

test('a shared path already declared is refused rather than duplicated', () => {
  const once = addSite(CONFIG, { path: '/home/me/vault', shared: true })
  assert.equal(once.ok, true)
  if (!once.ok) return
  const twice = addSite(once.config, { path: '/home/me/vault', shared: true })
  assert.equal(twice.ok, false)
})

test('a config with no sessions module gets one, switched ON and launchable', () => {
  // Adding a site to a config where sessions is absent has one sensible meaning. A
  // fragment with sites and an EMPTY catalog would be a module that starts and can
  // launch nothing, which looks broken and is the more surprising outcome.
  const bare = { ...CONFIG, modules: { example: { enabled: true } } }
  const result = addSite(bare, { path: '/home/me/work' })
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.equal((sessions(result.config) as unknown as { enabled: boolean }).enabled, true)
  assert.deepEqual(sessions(result.config).sites, [{ id: 'work', path: '/home/me/work' }])
  assert.deepEqual(
    (sessions(result.config) as unknown as { catalog: { id: string }[] }).catalog.map((e) => e.id),
    ['free'],
  )
})

test('the result validates against the ROOT schema, so it is a config that starts', () => {
  // The property `init` already holds and the reason this returns a result instead of
  // writing: nothing leaves here that `factotum start` would refuse.
  const result = addSite({ ...CONFIG, publicOrigin: 'https://x.ts.net/' }, { path: '/home/me/work' })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.error, /publicOrigin/)
})

// ---------------------------------------------------------------------------
// removeSite and listSites
// ---------------------------------------------------------------------------

test('removing a site by id leaves the rest, and removing a shared path works by path', () => {
  const removed = removeSite(CONFIG, 'notes')
  assert.equal(removed.ok, true)
  assert.deepEqual(removed.ok ? sessions(removed.config).sites : null, [])

  const withVault = addSite(CONFIG, { path: '/home/me/vault', shared: true })
  assert.equal(withVault.ok, true)
  if (!withVault.ok) return
  const gone = removeSite(withVault.config, '/home/me/vault')
  assert.deepEqual(gone.ok ? sessions(gone.config).sharedPaths : null, [])
})

test('removing something that is not there says so instead of succeeding quietly', () => {
  const result = removeSite(CONFIG, 'nope')
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.error, /nope/)
})

test('listing reports sites and shared paths, and what they are for', () => {
  const withVault = addSite(CONFIG, { path: '/home/me/vault', shared: true })
  assert.equal(withVault.ok, true)
  if (!withVault.ok) return

  assert.deepEqual(listSites(withVault.config), {
    sites: [{ id: 'notes', path: '/home/me/notes' }],
    sharedPaths: ['/home/me/vault'],
  })
})

test('listing a config without the module is empty, not an error', () => {
  assert.deepEqual(listSites({ ...CONFIG, modules: {} }), { sites: [], sharedPaths: [] })
})
