import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { commitAll, put, sh, world, type World } from '../test-repos.ts'
import { addSession, fakePeer, makeHost, testTimers, worldProjects, type Route, type TestHost } from '../test-handoff.ts'
import { compute, createPreviews, PreviewError } from './preview.ts'
import { sessionsCheck, targetProjects } from './snapshot.ts'
import type { Plan } from './plan.ts'

/** The target's two read routes, as `handoff-routes.ts` serves them. */
function targetRoutes(target: TestHost): Route {
  return async (method, path, body) => {
    if (method === 'GET' && path === 'handoff/projects') return { kind: 'ok', body: await targetProjects(target.host) }
    if (method === 'POST' && path === 'handoff/sessions-check') return { kind: 'ok', body: await sessionsCheck(target.host, (body as { ids: unknown[] }).ids) }
    return undefined
  }
}

async function twoHosts(w: World) {
  const projects = worldProjects(w)
  const state: { route: Route | undefined; reachable: boolean; delay?: () => Promise<void> } = { route: undefined, reachable: true }
  const peer = fakePeer('omarchy', state)
  const source = await makeHost({ name: 'mac', projects: projects.source, env: w.env, peers: peer })
  const target = await makeHost({ name: 'omarchy', projects: projects.target, env: w.env, peers: fakePeer('mac', { route: undefined, reachable: false }) })
  state.route = targetRoutes(target)
  return { source, target, state, peer }
}

async function everything(w: World, hosts: readonly TestHost[]) {
  const repo = async (dir: string) => ({
    status: await sh(w.env, dir, 'status', '--porcelain', '--ignored'),
    head: await sh(w.env, dir, 'rev-parse', 'HEAD'),
    refs: await sh(w.env, dir, 'for-each-ref'),
  })
  return {
    source: await repo(w.source),
    target: await repo(w.target),
    state: await Promise.all(hosts.map(async (h) => (await readdir(h.host.paths.root, { recursive: true })).sort())),
  }
}

test('the preview: what goes, the local commits and the untracked files by name — and NOTHING changes on either host, with no fetch (criterion 23)', async () => {
  const w = await world()
  const { source, target } = await twoHosts(w)
  await put(w.source, 'local.md', 'local\n')
  await commitAll(w.env, w.source, 'not pushed')
  await put(w.source, 'notes/SEMBRADO-untracked.md', 'new\n')
  const session = await addSession(source, { siteId: 'vault', transcript: '{"t":1}\n' })
  // The remote moves on behind both: a fetch would change refs/remotes.
  await put(`${w.home}/seed`, 'remote-only.md', 'r\n')
  await commitAll(w.env, `${w.home}/seed`, 'remote only')
  await sh(w.env, `${w.home}/seed`, 'push', '--quiet')

  const before = await everything(w, [source, target])
  const { plan } = await compute(source.host, 'omarchy')
  assert.deepEqual(await everything(w, [source, target]), before)

  assert.deepEqual(plan.skipped, [])
  assert.equal(plan.projects.length, 1)
  assert.deepEqual(plan.projects[0]?.sessions, [session.id])
  assert.equal(plan.projects[0]?.targetSiteId, 'obsidian')
  assert.equal(plan.projects[0]?.localCommits, 1)
  assert.deepEqual(plan.projects[0]?.newUntracked, ['notes/SEMBRADO-untracked.md'])
  // The names are for the screen, never the log (criterion 36).
  assert.doesNotMatch([...source.lines, ...target.lines].join('\n'), /SEMBRADO/)
})

test('a session the target already has, whose log here does not extend its own, is history-diverged', async () => {
  const w = await world()
  const { source, target } = await twoHosts(w)
  const session = await addSession(source, { siteId: 'vault', transcript: 'x\n' })
  // The target has a copy of it that went another way.
  await target.host.store.create({ id: session.id, siteId: 'obsidian', entryId: 'free', startedAt: session.startedAt, sitePath: w.target, agent: undefined, prompt: 'p' })
  await target.host.store.append(session.id, { kind: 'message', role: 'user', text: 'something else' })
  const { plan } = await compute(source.host, 'omarchy')
  assert.deepEqual(plan.skipped, [{ siteId: 'vault', sessionId: session.id, reason: 'history-diverged' }])
})

test('a target branch ahead of the source is target-ahead, checked in the source’s own repo', async () => {
  const w = await world()
  const { source } = await twoHosts(w)
  await addSession(source, { siteId: 'vault', transcript: 'x\n' })
  await put(w.target, 'ahead.md', 'the plugin pushed from here\n')
  await commitAll(w.env, w.target, 'ahead')
  const { plan } = await compute(source.host, 'omarchy')
  assert.deepEqual(plan.skipped, [{ siteId: 'vault', reason: 'target-ahead' }])
})

test('a peer that is down, slow past the timeout, or not a peer: a failure with its reason, never half a plan', async () => {
  const w = await world()
  const { source, state } = await twoHosts(w)
  await addSession(source, { siteId: 'vault', transcript: 'x\n' })
  state.reachable = false
  await assert.rejects(compute(source.host, 'omarchy'), (error: unknown) => error instanceof PreviewError && error.reason === 'peer-unreachable')
  await assert.rejects(compute(source.host, 'nobody'), (error: unknown) => error instanceof PreviewError && error.reason === 'unknown-peer')
  state.reachable = true
  state.route = async () => ({ kind: 'ok', body: [{ not: 'a project' }] })
  await assert.rejects(compute(source.host, 'omarchy'), (error: unknown) => error instanceof PreviewError && error.reason === 'peer-error')
})

test('the two calls to the peer go with HANDOFF_PEER_READ_TIMEOUT_MS, never the 10 s default', async () => {
  const w = await world()
  const { source } = await twoHosts(w)
  await addSession(source, { siteId: 'vault', transcript: 'x\n' })
  const seen: (number | undefined)[] = []
  const peers = source.host.peers
  const watched = { ...source.host, peers: { ...peers, json: ((peer, method, path, body, options) => (seen.push(options?.timeoutMs), peers.json(peer, method, path, body, options))) as typeof peers.json } }
  await compute(watched, 'omarchy')
  assert.deepEqual(seen, [120_000, 120_000])
})

// ---------------------------------------------------------------------------
// The previews in memory (v4.3)
// ---------------------------------------------------------------------------

const EMPTY: Plan = { projects: [], skipped: [], totals: { archived: 0, tooOld: 0 } }

function slowRun() {
  let release: (plan: Plan) => void = () => undefined
  let fail: (error: unknown) => void = () => undefined
  let calls = 0
  const run = () => {
    calls += 1
    return new Promise<Plan>((resolve, reject) => {
      release = resolve
      fail = reject
    })
  }
  return { run, release: (plan: Plan) => release(plan), fail: (error: unknown) => fail(error), calls: () => calls }
}

const log = { info: () => undefined, warn: () => undefined, error: () => undefined }

test('a slow peer: `running` at once, every GET answered at once, then `ready`; a second POST meanwhile gets the same id', async () => {
  const slow = slowRun()
  const previews = createPreviews({ run: slow.run, timers: testTimers, now: () => new Date(), log })
  const id = previews.start('omarchy')
  assert.deepEqual(previews.get(id), { state: 'running' })
  assert.equal(previews.start('omarchy'), id)
  assert.equal(slow.calls(), 1)
  slow.release(EMPTY)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(previews.get(id), { state: 'ready', plan: EMPTY })
  assert.notEqual(previews.start('omarchy'), id, 'once finished, a POST starts another')
})

test('a failed run is `failed` with its reason; anything unexpected is `internal`', async () => {
  const slow = slowRun()
  const previews = createPreviews({ run: slow.run, timers: testTimers, now: () => new Date(), log })
  const id = previews.start('omarchy')
  slow.fail(new PreviewError('peer-timeout'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(previews.get(id), { state: 'failed', reason: 'peer-timeout' })
  const other = previews.start('omarchy')
  slow.fail(new Error('/Users/ferro/some/path broke'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(previews.get(other), { state: 'failed', reason: 'internal' })
})

test('a preview past HANDOFF_PREVIEW_KEEP_MS is gone, and a restart knows none', async () => {
  const slow = slowRun()
  const previews = createPreviews({ run: slow.run, timers: testTimers, now: () => new Date(), log, keepMs: 20 })
  const id = previews.start('omarchy')
  slow.release(EMPTY)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(previews.get(id), undefined)
  assert.equal(createPreviews({ run: slow.run, timers: testTimers, now: () => new Date(), log }).get(id), undefined)
})
