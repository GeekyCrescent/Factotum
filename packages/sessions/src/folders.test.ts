import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NotificationMessage, Timers } from '@factotum/core'
import { createEngine, REMOVING } from './engine.ts'
import { uuidv7 } from './id.ts'
import { SiteLocks } from './locks.ts'
import { sessionPaths } from './paths.ts'
import { SessionStore } from './store.ts'
import { memoryRegistry, type MemoryRegistry } from './test-registry.ts'
import type { SessionEngine, SiteConfig } from './types.ts'

/**
 * Adding, changing and removing projects through the engine (spec 2026-09-29, blocks C and D). Real
 * folders in a temp dir, the in-memory registry, and a notifier that records: the push service is
 * not here, and what matters is what the engine ASKED to send.
 */

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'fake-claude.mjs')

const timers: Timers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms)
    handle.unref()
    return { [Symbol.dispose]: () => clearInterval(handle) }
  },
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref()
    return { [Symbol.dispose]: () => clearTimeout(handle) }
  },
}

interface World {
  readonly engine: SessionEngine
  readonly registry: MemoryRegistry
  readonly root: string
  readonly home: string
  readonly stateDir: string
  readonly notices: NotificationMessage[]
  readonly reach: { value: boolean }
  readonly folder: (name: string) => Promise<string>
}

async function world(
  options: {
    sites?: (root: string) => readonly SiteConfig[]
    broken?: string
    reconcile?: boolean
    before?: (stateDir: string) => Promise<void>
    candidateTimeoutMs?: number
    disk?: Parameters<typeof createEngine>[1] extends infer D ? (D extends { disk?: infer K } ? K : never) : never
  } = {},
): Promise<World> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'factotum-folders-')))
  const home = join(root, 'home')
  const stateDir = join(home, '.factotum', 'prod', 'modules', 'sessions')
  await mkdir(stateDir, { recursive: true })
  await options.before?.(stateDir)
  const registry = memoryRegistry({ sites: options.sites?.(root) ?? [] }, options.broken === undefined ? {} : { broken: options.broken })
  const notices: NotificationMessage[] = []
  const reach = { value: true }
  const engine = await createEngine(
    {
      titles: { enabled: false, model: 'haiku', effort: 'low' },
      stateDir,
      registry,
      home,
      factotumRoot: join(home, '.factotum'),
      installRoot: undefined,
      catalog: [{ id: 'free', label: 'Free prompt', invoke: { kind: 'none' } }],
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => new Date(),
      timers,
      hookUrl: () => 'http://127.0.0.1:7778',
      notify: { canReach: () => reach.value, send: async (message) => void notices.push(message) },
    },
    {
      bin: FAKE,
      caseInsensitive: false,
      ...(options.candidateTimeoutMs === undefined ? {} : { candidateTimeoutMs: options.candidateTimeoutMs }),
      ...(options.disk === undefined ? {} : { disk: options.disk }),
    },
  )
  if (options.reconcile !== false) await engine.reconcile()
  const folder = async (name: string): Promise<string> => {
    const path = join(root, name)
    await mkdir(path, { recursive: true })
    return path
  }
  return { engine, registry, root, home, stateDir, notices, reach, folder }
}

/** The token the engine put in the notice — the only place it exists outside memory. */
function tokenOf(notices: readonly NotificationMessage[], requestId: string): string {
  const notice = notices.find((n) => n.tag === `grant:${requestId}`)
  const token = notice?.data?.['grantId']
  assert.equal(typeof token, 'string', 'the approval notice carries the token')
  return token as string
}

async function requested(engine: SessionEngine, path: string, extra: { id?: string; name?: string } = {}) {
  const result = await engine.requestProject({ path, id: extra.id, name: extra.name, color: undefined })
  assert.equal(result.outcome, 'requested', JSON.stringify(result))
  return result.outcome === 'requested' ? result : { requestId: '', expiresAt: '' }
}

async function settle(engine: SessionEngine, id: string): Promise<void> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const page = await engine.read(id, 0)
    if ('state' in page && page.state !== 'running') return
    if (Date.now() > deadline) throw new Error(`session ${id} never settled`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// ---------------------------------------------------------------------------
// asking (criteria 8, 10, 12, 13, 14, 17, 21)
// ---------------------------------------------------------------------------

test('THE RESPONSE DOES NOT AUTHORISE: a request id and a deadline, and the token appears in no field of it (criterion 8)', async () => {
  const { engine, notices, folder } = await world()
  const result = await engine.requestProject({ path: await folder('web'), id: undefined, name: undefined, color: undefined })
  assert.equal(result.outcome, 'requested')
  if (result.outcome !== 'requested') return
  const token = tokenOf(notices, result.requestId)
  assert.equal(JSON.stringify(result).includes(token), false)
  assert.deepEqual(Object.keys(result).sort(), ['expiresAt', 'outcome', 'requestId'])
})

test('THE NOTICE NAMES THE FOLDER, NEVER ITS PATH, and asks until the deadline (criterion 17)', async () => {
  const { engine, notices, folder, root } = await world()
  const { requestId, expiresAt } = await requested(engine, await folder('web'))
  const notice = notices[0]
  assert.match(notice?.body ?? '', /^Add project · web \(in factotum-folders-[^/]+\)$/)
  assert.equal(notice?.until, expiresAt)
  assert.equal(notice?.tag, `grant:${requestId}`)
  assert.match(notice?.path ?? '', /^\/m\/sessions\/projects\?grant=[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(Object.keys(notice?.data ?? {}).sort(), ['grantId', 'kind', 'name', 'requestId'])
  assert.equal(JSON.stringify(notice).includes(root), false, 'no path anywhere in it')
})

test('NOBODY TO ASK: a 409 that names Device and the way by hand, and nothing is pushed (criterion 10)', async () => {
  const { engine, notices, folder, reach } = await world()
  reach.value = false
  const result = await engine.requestProject({ path: await folder('web'), id: undefined, name: undefined, color: undefined })
  assert.equal(result.outcome, 'conflict')
  assert.equal(result.outcome === 'conflict' ? result.conflict : '', 'no-device')
  assert.match(result.outcome === 'conflict' ? result.reason : '', /Device.*by hand/)
  assert.deepEqual(notices, [])
})

test('THE DISK RULES are a 400 and push nothing: missing, the home, ~/.factotum, inside another project (criterion 12)', async () => {
  const { engine, notices, folder, home, root } = await world({ sites: (r) => [{ id: 'a', path: join(r, 'a') }] })
  await folder('a/inner')
  for (const path of [join(root, 'nope'), home, join(home, '.factotum'), join(root, 'a', 'inner'), join(root, 'a')]) {
    const result = await engine.requestProject({ path, id: undefined, name: undefined, color: undefined })
    assert.equal(result.outcome, 'invalid', path)
  }
  assert.deepEqual(notices, [])
})

test('A SYMLINK REGISTERS WHERE IT LANDS: resolved path, id and notice from the target’s name (criterion 13)', async () => {
  const { engine, notices, registry, folder, root } = await world()
  const target = await folder('real-name')
  await symlink(target, join(root, 'alias'))
  const { requestId } = await requested(engine, join(root, 'alias'))
  assert.match(notices[0]?.body ?? '', /^Add project · real-name \(in /)
  await engine.answerGrant(tokenOf(notices, requestId), 'allow')
  assert.deepEqual(registry.current().projects.map((p) => [p.id, p.path]), [['real-name', target]])
})

test('AN ID WITH OLD HISTORY is taken: delete it first or pick another (criterion 14)', async () => {
  const { engine, folder } = await world({
    before: async (stateDir) => {
      const store = new SessionStore(sessionPaths(stateDir), () => new Date())
      await store.ensureRoots()
      const id = uuidv7()
      await store.create({ id, siteId: 'demo', entryId: 'free', startedAt: new Date().toISOString(), sitePath: undefined, prompt: 'x' })
      await store.patchMeta(id, (m) => ({ ...m, state: 'finished' }))
    },
  })
  const result = await engine.requestProject({ path: await folder('demo'), id: undefined, name: undefined, color: undefined })
  assert.equal(result.outcome, 'invalid')
  assert.match(result.outcome === 'invalid' ? result.reason : '', /its old history is still there: delete it first, or pick another id/)
  const other = await engine.requestProject({ path: await folder('demo'), id: 'demo-2', name: undefined, color: undefined })
  assert.equal(other.outcome, 'requested')
})

test('BEFORE THE INDEX IS READY a request is a 409 “starting” (criterion 14)', async () => {
  const { engine, folder } = await world({ reconcile: false })
  const result = await engine.requestProject({ path: await folder('web'), id: undefined, name: undefined, color: undefined })
  assert.deepEqual(result.outcome === 'conflict' ? result.conflict : result.outcome, 'starting')
})

test('A BROKEN REGISTRY refuses a request BEFORE anything is pushed; removed is empty and its delete a 409 (criterion 6)', async () => {
  const { engine, notices, folder } = await world({ broken: 'projects.json is not valid JSON' })
  const result = await engine.requestProject({ path: await folder('web'), id: undefined, name: undefined, color: undefined })
  assert.equal(result.outcome === 'conflict' ? result.conflict : result.outcome, 'broken')
  assert.equal((await engine.requestShared(await folder('notes'))).outcome, 'conflict')
  assert.deepEqual(notices, [])
  const page = await engine.projects()
  assert.deepEqual(page.removed, [])
  assert.match(page.registryError ?? '', /not valid JSON/)
  assert.equal((await engine.removeHistory('demo')).outcome, 'conflict')
})

test('THREE WAITING IS THE CEILING: the fourth is a 409 (criterion 21)', async () => {
  const { engine, folder } = await world()
  for (const name of ['a', 'b', 'c']) await requested(engine, await folder(name))
  const fourth = await engine.requestProject({ path: await folder('d'), id: undefined, name: undefined, color: undefined })
  assert.equal(fourth.outcome === 'conflict' ? fourth.reason : fourth.outcome, 'too many pending requests')
})

// ---------------------------------------------------------------------------
// answering (criteria 9, 15, 16, 19)
// ---------------------------------------------------------------------------

test('ONLY THE TOKEN APPROVES, and the project launches without a restart (criterion 9)', async () => {
  const { engine, notices, folder } = await world()
  const path = await folder('web')
  const { requestId } = await requested(engine, path, { name: 'Web app' })
  assert.deepEqual(await engine.answerGrant(requestId, 'allow'), { outcome: 'unknown' })
  const answered = await engine.answerGrant(tokenOf(notices, requestId), 'allow')
  assert.deepEqual(answered, { outcome: 'approved', reason: undefined, first: true })
  assert.deepEqual(await engine.requestStatus(requestId), { status: 'approved', reason: undefined })

  const launched = await engine.launch({ siteId: 'web', entryId: 'free', text: 'quick', force: false })
  assert.equal(launched.outcome, 'started')
  await settle(engine, launched.outcome === 'started' ? launched.sessionId : '')
  assert.equal(engine.view().sites.find((s) => s.id === 'web')?.name, 'Web app')
})

test('“ADDED” IS SAID, with its own tag, no deadline and no token (criterion 19)', async () => {
  const { engine, notices, folder } = await world()
  const { requestId } = await requested(engine, await folder('web'))
  await engine.answerGrant(tokenOf(notices, requestId), 'allow')
  const added = notices.find((n) => n.tag === `added:${requestId}`)
  assert.equal(added?.body, 'Added · web')
  assert.equal(added?.until, undefined)
  assert.equal(added?.data, undefined)
  assert.equal(added?.path, '/m/sessions/projects')
})

test('TWO ANSWERS GIVE ONE RESULT, and a write that fails is `rejected` with why, for both (criterion 9)', async () => {
  const { engine, notices, registry, folder } = await world()
  const { requestId } = await requested(engine, await folder('web'))
  const token = tokenOf(notices, requestId)
  registry.failNextWrite('could not write projects.json: EACCES')
  const [a, b] = await Promise.all([engine.answerGrant(token, 'allow'), engine.answerGrant(token, 'allow')])
  assert.deepEqual(a, { outcome: 'rejected', reason: 'could not write projects.json: EACCES', first: true })
  assert.deepEqual(b, { outcome: 'rejected', reason: 'could not write projects.json: EACCES', first: false })
  assert.deepEqual(registry.current().projects, [])
})

test('/a AND /a/b APPROVED ONE AFTER THE OTHER: one lands, the other is rejected in the queue (criterion 15)', async () => {
  const { engine, notices, registry, folder } = await world()
  const outer = await requested(engine, await folder('a'))
  const inner = await requested(engine, await folder('a/b'))
  const [first, second] = await Promise.all([
    engine.answerGrant(tokenOf(notices, outer.requestId), 'allow'),
    engine.answerGrant(tokenOf(notices, inner.requestId), 'allow'),
  ])
  assert.equal(first.outcome, 'approved')
  assert.equal(second.outcome, 'rejected')
  assert.deepEqual(registry.current().projects.map((p) => p.id), ['a'])
  // The notice says it could not, WITHOUT the reason; the reason is on the status.
  const refused = notices.find((n) => n.tag === `added:${inner.requestId}`)
  assert.equal(refused?.body, 'Could not add · b')
  const status = await engine.requestStatus(inner.requestId)
  assert.equal(status.status, 'rejected')
  assert.match('reason' in status ? (status.reason ?? '') : '', /inside the project "a"/)
})

test('A FOLDER THAT VANISHED BEFORE THE ANSWER is rejected and nothing is written (criterion 15)', async () => {
  const { engine, notices, registry, folder } = await world()
  const path = await folder('web')
  const { requestId } = await requested(engine, path)
  await rename(path, `${path}-gone`)
  const answered = await engine.answerGrant(tokenOf(notices, requestId), 'allow')
  assert.equal(answered.outcome, 'rejected')
  assert.deepEqual(registry.current().projects, [])
})

test('A CHECK THAT DOES NOT END inside the queue is rejected at its ceiling (criterion 15, R11)', async () => {
  let hang = false
  const disk = {
    realpath: async (path: string) => (hang ? new Promise<string>(() => undefined) : await realpath(path)),
    isDirectory: async () => true,
  }
  const { engine, notices, registry, folder } = await world({ candidateTimeoutMs: 50, disk })
  const { requestId } = await requested(engine, await folder('web'))
  hang = true
  const answered = await engine.answerGrant(tokenOf(notices, requestId), 'allow')
  assert.deepEqual(answered, { outcome: 'rejected', reason: 'checking that folder timed out', first: true })
  assert.deepEqual(registry.current().projects, [])
})

test('deny writes nothing and says denied', async () => {
  const { engine, notices, registry, folder } = await world()
  const { requestId } = await requested(engine, await folder('web'))
  assert.equal((await engine.answerGrant(tokenOf(notices, requestId), 'deny')).outcome, 'denied')
  assert.deepEqual(registry.current().projects, [])
  assert.equal(notices.some((n) => n.tag === `added:${requestId}`), false)
})

test('GET BY TOKEN: the full path while pending, `settled` after, `unknown` for anything else', async () => {
  const { engine, notices, folder } = await world()
  const path = await folder('web')
  const { requestId } = await requested(engine, path, { name: 'W' })
  const token = tokenOf(notices, requestId)
  const pending = await engine.inspectGrant(token)
  assert.equal(pending.kind, 'pending')
  assert.deepEqual(pending.kind === 'pending' ? pending.request : undefined, { kind: 'project', path, id: 'web', name: 'W', color: undefined })
  await engine.answerGrant(token, 'deny')
  assert.deepEqual(await engine.inspectGrant(token), { kind: 'settled' })
  assert.deepEqual(await engine.inspectGrant('z'.repeat(43)), { kind: 'unknown' })
})

test('stop expires every waiting request: nobody can approve into a stopped engine', async () => {
  const { engine, notices, folder } = await world()
  const { requestId } = await requested(engine, await folder('web'))
  await engine.stop()
  assert.equal((await engine.requestStatus(requestId)).status, 'expired')
  await assert.rejects(() => engine.answerGrant(tokenOf(notices, requestId), 'allow'), /engine stopped/)
})

// ---------------------------------------------------------------------------
// shared folders (criterion 20)
// ---------------------------------------------------------------------------

test('A SHARED FOLDER: asked, approved into the gate, and removed — none of it with a session running (criterion 20)', async () => {
  const { engine, notices, registry, folder } = await world({ sites: (r) => [{ id: 'a', path: join(r, 'a') }] })
  await folder('a')
  const notes = await folder('notes')
  const asked = await engine.requestShared(notes)
  assert.equal(asked.outcome, 'requested')
  const requestId = asked.outcome === 'requested' ? asked.requestId : ''
  assert.match(notices[0]?.body ?? '', /^Share folder · notes \(in /)

  // A session starts before the answer: approving is refused in the queue.
  const live = await engine.launch({ siteId: 'a', entryId: 'free', text: 'linger', force: false })
  const liveId = live.outcome === 'started' ? live.sessionId : ''
  const refused = await engine.answerGrant(tokenOf(notices, requestId), 'allow')
  assert.equal(refused.outcome, 'rejected')
  assert.equal((await engine.requestShared(notes)).outcome, 'conflict', 'asking with one running is a 409')
  await engine.cancel(liveId)

  const again = await engine.requestShared(notes)
  const againId = again.outcome === 'requested' ? again.requestId : ''
  assert.equal((await engine.answerGrant(tokenOf(notices, againId), 'allow')).outcome, 'approved')
  assert.deepEqual(registry.current().shared.map((s) => s.path), [notes])
  assert.equal((await engine.projects()).shared[0]?.status, 'ok')

  const busy = await engine.launch({ siteId: 'a', entryId: 'free', text: 'linger', force: false })
  const busyId = busy.outcome === 'started' ? busy.sessionId : ''
  assert.equal((await engine.removeShared(notes)).outcome, 'conflict')
  await engine.cancel(busyId)
  assert.equal((await engine.removeShared(notes)).outcome, 'ok')
  assert.deepEqual(registry.current().shared, [])
  assert.equal((await engine.removeShared(notes)).outcome, 'unknown')
})

// ---------------------------------------------------------------------------
// changing and deleting (criteria 11, 26, 27, 28)
// ---------------------------------------------------------------------------

test('NAME AND COLOUR persist and reach the view; an unknown id is a 404 before anything (criteria 11, 26)', async () => {
  const { engine, registry, root, stateDir } = await world({ sites: (r) => [{ id: 'web', path: join(r, 'web') }] })
  await mkdir(join(root, 'web'))
  assert.equal((await engine.updateProject('web', { name: 'Web app', color: 4 })).outcome, 'ok')
  assert.deepEqual(registry.current().projects[0], { id: 'web', path: join(root, 'web'), name: 'Web app', color: 4 })
  assert.equal(engine.view().sites[0]?.color, 4)
  assert.equal((await engine.updateProject('nope', { name: 'x', color: undefined })).outcome, 'unknown')
  assert.deepEqual(await readdir(join(stateDir, 'locks')), [], 'no lock was taken for it')
})

test('THE ORDER AND THE CATEGORIES persist and reach GET projects in the owner\'s order; no approval, nothing pushed', async () => {
  const { engine, registry, root, notices } = await world({
    sites: (r) => ['a', 'b', 'c'].map((id) => ({ id, path: join(r, id) })),
  })
  for (const id of ['a', 'b', 'c']) await mkdir(join(root, id))
  const layout = {
    categories: [{ id: 'work', name: 'Work' }],
    order: [
      { id: 'c', category: 'work' },
      { id: 'a', category: undefined },
      { id: 'b', category: 'work' },
    ],
  }
  assert.deepEqual(await engine.setLayout(layout), { outcome: 'ok', removedSessions: 0 })
  assert.deepEqual(registry.current().categories, [{ id: 'work', name: 'Work' }])
  const page = await engine.projects()
  assert.deepEqual(page.projects.map((p) => [p.id, p.category]), [['c', 'work'], ['a', undefined], ['b', 'work']])
  assert.deepEqual(page.categories, [{ id: 'work', name: 'Work' }])
  assert.deepEqual(engine.view().sites.map((s) => s.id), ['c', 'a', 'b'])
  assert.deepEqual(notices, [])
  // Renaming afterwards keeps both the place and the category.
  await engine.updateProject('a', { name: 'Ay', color: undefined })
  assert.deepEqual((await engine.projects()).projects.map((p) => p.id), ['c', 'a', 'b'])
})

test('A STALE LAYOUT is a conflict and changes nothing: a project missing from it, one too many, one twice', async () => {
  const { engine, registry } = await world({ sites: (r) => ['a', 'b'].map((id) => ({ id, path: join(r, id) })) })
  const place = (...ids: string[]) => ({ categories: [], order: ids.map((id) => ({ id, category: undefined })) })
  for (const layout of [place('a'), place('a', 'b', 'c'), place('a', 'a')]) {
    const result = await engine.setLayout(layout)
    assert.equal(result.outcome, 'conflict')
    assert.match(result.outcome === 'conflict' ? result.reason : '', /reload/)
  }
  assert.equal(registry.writes(), 0)
  // A write that fails is a conflict too, with why.
  registry.failNextWrite('could not write projects.json: EACCES')
  assert.deepEqual(await engine.setLayout(place('b', 'a')), { outcome: 'conflict', reason: 'could not write projects.json: EACCES' })
  assert.deepEqual(registry.current().projects.map((p) => p.id), ['a', 'b'])
})

test('A BROKEN REGISTRY refuses a layout', async () => {
  const { engine } = await world({ broken: 'projects.json is not valid JSON' })
  assert.equal((await engine.setLayout({ categories: [], order: [] })).outcome, 'conflict')
})

test('DELETING A PROJECT deletes its history, never its folder; the lock says `removing` while it runs (criterion 27)', async () => {
  const { engine, registry, root, stateDir } = await world({ sites: (r) => [{ id: 'web', path: join(r, 'web') }] })
  const web = join(root, 'web')
  await mkdir(join(web, 'src'), { recursive: true })
  await writeFile(join(web, 'src', 'index.ts'), 'export {}')
  const before = await readdir(web, { recursive: true })

  const launched = await engine.launch({ siteId: 'web', entryId: 'free', text: 'quick', force: false })
  const id = launched.outcome === 'started' ? launched.sessionId : ''
  await settle(engine, id)
  const locks = new SiteLocks(sessionPaths(stateDir))
  while ((await locks.heldBy('web')) !== undefined) await new Promise((resolve) => setTimeout(resolve, 10))

  const removed = await engine.removeProject('web')
  assert.deepEqual(removed, { outcome: 'ok', removedSessions: 1 })
  assert.deepEqual(registry.current().projects, [])
  assert.deepEqual(await readdir(web, { recursive: true }), before, 'the folder is exactly as it was')
  assert.equal(await locks.heldBy('web'), undefined, 'the lock was let go')
  assert.deepEqual((await engine.summary(id)).kind, 'unknown')
  assert.equal((await engine.removeProject('web')).outcome, 'unknown')
})

test('A LAUNCH WHILE A PROJECT IS BEING REMOVED is refused “being removed”; a live session makes the delete a 409 (criterion 27)', async () => {
  const { engine, root, stateDir } = await world({ sites: (r) => [{ id: 'web', path: join(r, 'web') }] })
  await mkdir(join(root, 'web'))
  const locks = new SiteLocks(sessionPaths(stateDir))
  await locks.acquire('web', REMOVING, new Date().toISOString())
  const refused = await engine.launch({ siteId: 'web', entryId: 'free', text: 'quick', force: false })
  assert.deepEqual(refused, { outcome: 'rejected', reason: 'this project is being removed' })
  await locks.release('web', REMOVING)

  const live = await engine.launch({ siteId: 'web', entryId: 'free', text: 'linger', force: false })
  const liveId = live.outcome === 'started' ? live.sessionId : ''
  const busy = await engine.removeProject('web')
  assert.equal(busy.outcome, 'conflict')
  await engine.cancel(liveId)
})

test('THE SWITCH persists with the whole body, a rename keeps it, false drops it, and the view says so (criterion 12)', async () => {
  const { engine, registry, root } = await world({ sites: (r) => [{ id: 'web', path: join(r, 'web') }] })
  await mkdir(join(root, 'web'))

  assert.equal((await engine.updateProject('web', { name: 'Web', color: 3, concurrent: true })).outcome, 'ok')
  assert.deepEqual(registry.current().projects[0], { id: 'web', path: join(root, 'web'), name: 'Web', color: 3, concurrent: true })
  assert.equal((await engine.projects()).projects[0]?.concurrent, true)

  await engine.updateProject('web', { name: 'Web app', color: 3 })
  assert.equal(registry.current().projects[0]?.concurrent, true, 'a body without it changes nothing')

  await engine.updateProject('web', { name: 'Web app', color: 3, concurrent: false })
  assert.equal('concurrent' in (registry.current().projects[0] ?? {}), false)
  assert.equal((await engine.projects()).projects[0]?.concurrent, false)
})

test('the patch is WHOLE for name and colour: { concurrent } alone clears them, as any partial patch always did', async () => {
  const { engine, registry, root } = await world({ sites: (r) => [{ id: 'web', path: join(r, 'web') }] })
  await mkdir(join(root, 'web'))
  await engine.updateProject('web', { name: 'Web', color: 3 })

  await engine.updateProject('web', { name: undefined, color: undefined, concurrent: true })

  const project = registry.current().projects[0]
  assert.deepEqual([project?.name, project?.color, project?.concurrent], [undefined, undefined, true])
})

test('DELETING a concurrent project with ONE or THREE live sessions is a 409; a shared launch while deleting is “being removed” (criterion 16)', async () => {
  const { engine, root, stateDir } = await world({ sites: (r) => [{ id: 'web', path: join(r, 'web') }] })
  await mkdir(join(root, 'web'))
  await engine.updateProject('web', { name: undefined, color: undefined, concurrent: true })
  const linger = async () => {
    const launched = await engine.launch({ siteId: 'web', entryId: 'free', text: 'linger', force: false })
    assert.equal(launched.outcome, 'started')
    return launched.outcome === 'started' ? launched.sessionId : ''
  }

  const ids = [await linger()]
  assert.deepEqual(await engine.removeProject('web'), { outcome: 'conflict', reason: 'a session is running in that project' })
  ids.push(await linger(), await linger())
  assert.deepEqual(await engine.removeProject('web'), { outcome: 'conflict', reason: 'a session is running in that project' })
  for (const id of ids) await engine.cancel(id)

  const locks = new SiteLocks(sessionPaths(stateDir))
  await locks.acquire('web', REMOVING, new Date().toISOString())
  const refused = await engine.launch({ siteId: 'web', entryId: 'free', text: 'quick', force: false })
  assert.deepEqual(refused, { outcome: 'rejected', reason: 'this project is being removed' })
  await locks.release('web', REMOVING)
})

test('REMOVED PROJECTS: “Delete history” deletes their conversations; a registered id or an unknown one is a 404 (criterion 28)', async () => {
  const { engine, folder } = await world({
    sites: (r) => [{ id: 'web', path: join(r, 'web') }],
    before: async (stateDir) => {
      const store = new SessionStore(sessionPaths(stateDir), () => new Date())
      await store.ensureRoots()
      for (let i = 0; i < 2; i++) {
        const id = uuidv7()
        await store.create({ id, siteId: 'demo', entryId: 'free', startedAt: new Date().toISOString(), sitePath: undefined, prompt: 'x' })
        await store.patchMeta(id, (m) => ({ ...m, state: 'finished' }))
      }
    },
  })
  await folder('web')
  assert.deepEqual((await engine.projects()).removed, [{ siteId: 'demo', count: 2 }])
  assert.deepEqual(await engine.removeHistory('demo'), { outcome: 'ok', removedSessions: 2 })
  assert.deepEqual((await engine.projects()).removed, [])
  assert.equal((await engine.removeHistory('demo')).outcome, 'unknown')
  assert.equal((await engine.removeHistory('web')).outcome, 'unknown')
})

test('ONE REQUEST PER FOLDER: asking again while one waits is a 409, and it does not eat the ceiling', async () => {
  const { engine, folder, notices } = await world()
  const path = await folder('web')
  await requested(engine, path)
  const again = await engine.requestProject({ path, id: 'web-2', name: undefined, color: undefined })
  assert.equal(again.outcome === 'conflict' ? again.conflict : again.outcome, 'already-waiting')
  assert.equal(notices.length, 1)
  for (const name of ['a', 'b']) await requested(engine, await folder(name))
})
