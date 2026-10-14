/**
 * Two hosts in one process, for the handoff's tests (spec 2026-10-07-dos-hosts, H and J). Each has a
 * real store, real locks, a real index and real repos; they talk through a `PeerCaller` that calls
 * the other side's handoff in-process instead of over HTTP — what J11 asks for: «dos engines en el
 * mismo proceso, unidos por un PeerCaller de mentira».
 *
 * The status of each answer is mapped HERE the way `modules/sessions/handoff-routes.ts` maps it:
 * five kinds, five statuses. The two lists are short on purpose.
 */

import { copyFile, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PeerCaller, PeerResponse, Timers } from '@factotum/core'
import { SessionIndex } from './index-cache.ts'
import { uuidv7 } from './id.ts'
import { SiteLocks } from './locks.ts'
import { sessionPaths } from './paths.ts'
import { SessionStore, type SessionMeta } from './store.ts'
import type { EventInput } from './types.ts'
import type { HandoffHost, HandoffProject } from './handoff/host.ts'
import type { Wire } from './handoff/wire.ts'

export type { Wire }
import { sh, world, type World } from './test-repos.ts'
import { KeyedQueue } from './keyed-queue.ts'
import { createTarget, type Target } from './handoff/target.ts'
import { createHandoff, type HandoffApi, type HandoffOptions } from './handoff/index.ts'
import { remoteKey } from './handoff/git.ts'
import { wipCommit } from './handoff/wip.ts'
import { handoffBase, makeBundle } from './handoff/git-bundle.ts'
import { sessionFiles } from './handoff/files.ts'
import { buildManifest, type ManifestEntry } from './handoff/manifest.ts'

export const testTimers: Timers = {
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

export interface TestHost {
  readonly name: string
  readonly host: HandoffHost
  readonly home: string
  readonly index: SessionIndex
  readonly lines: string[]
  readonly projects: HandoffProject[]
  readonly stopped: string[]
}

export interface HostOptions {
  readonly name: string
  readonly projects: readonly HandoffProject[]
  readonly env: NodeJS.ProcessEnv
  readonly peers: PeerCaller
  readonly entries?: readonly string[]
  readonly now?: () => Date
}

export async function makeHost(options: HostOptions): Promise<TestHost> {
  const home = await mkdtemp(join(options.env['HOME'] ?? '/tmp', `host-${options.name}-`))
  const paths = sessionPaths(join(home, 'state'))
  const now = options.now ?? (() => new Date())
  const store = new SessionStore(paths, now)
  await store.ensureRoots()
  const index = new SessionIndex()
  await index.build(store)
  store.observe({ written: (meta) => index.put(meta), removed: (id) => index.drop(id) })
  const lines: string[] = []
  const projects = [...options.projects]
  const stopped: string[] = []
  const host: HandoffHost = {
    paths,
    store,
    locks: new SiteLocks(paths),
    projects: () => projects,
    sessionsOf: (siteId) => index.all().filter((meta) => meta.siteId === siteId),
    entries: () => options.entries ?? ['free'],
    uploadsRoot: paths.uploads,
    claudeProjects: join(home, '.claude', 'projects'),
    stopServices: async (sessionId) => (stopped.push(sessionId), []),
    peers: options.peers,
    log: { info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`), error: (m) => lines.push(`error ${m}`) },
    now,
    timers: testTimers,
    gitEnv: options.env,
  }
  return { name: options.name, host, home, index, lines, projects, stopped }
}

export interface SessionOptions {
  readonly siteId: string
  readonly events?: readonly EventInput[]
  readonly meta?: Partial<SessionMeta>
  /** Writes `~/.claude/projects/<folder>/<id>.jsonl` with this text; `undefined` writes none. */
  readonly transcript?: string
  readonly transcriptFolder?: string
}

/** A finished session on `test`, with its log and, unless told not to, its CLI transcript. */
export async function addSession(test: TestHost, options: SessionOptions): Promise<SessionMeta> {
  const id = uuidv7(Date.now())
  const project = test.projects.find((p) => p.id === options.siteId)
  await test.host.store.create({ id, siteId: options.siteId, entryId: 'free', startedAt: new Date().toISOString(), sitePath: project?.path, agent: undefined, prompt: 'p' })
  for (const event of options.events ?? [{ kind: 'message', role: 'user', text: 'hello' } as const]) await test.host.store.append(id, event)
  const meta = await test.host.store.patchMeta(id, (m) => ({ ...m, state: 'finished', endedAt: new Date().toISOString(), ...options.meta }))
  if (options.transcript !== undefined) {
    const folder = join(test.host.claudeProjects, options.transcriptFolder ?? '-somewhere')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, `${id}.jsonl`), options.transcript)
  }
  return meta!
}

export const statusOf: Record<Wire['kind'], number> = { ok: 200, invalid: 400, 'not-found': 404, conflict: 409, expired: 410 }

export function asResponse(wire: Wire): PeerResponse<unknown> {
  switch (wire.kind) {
    case 'ok':
      return { ok: true, status: wire.status ?? 200, body: JSON.parse(JSON.stringify(wire.body ?? null)) as unknown }
    case 'invalid':
    case 'not-found':
      return { ok: false, status: statusOf[wire.kind], reason: 'http', body: { error: { code: wire.kind === 'invalid' ? 'invalid-request' : 'not-found', message: wire.message } } }
    case 'conflict':
      return { ok: false, status: 409, reason: 'http', body: JSON.parse(JSON.stringify({ error: { code: 'conflict', message: wire.message }, handoff: wire.handoff })) as unknown }
    case 'expired':
      return { ok: false, status: 410, reason: 'http', body: JSON.parse(JSON.stringify({ error: { code: 'conflict', message: 'expired' }, handoff: wire.handoff })) as unknown }
  }
}

export type Route = (method: 'GET' | 'POST', path: string, body: unknown, file: string | undefined) => Promise<Wire | undefined>

/** A `PeerCaller` whose one peer is answered by `route`, or is down. `delay` holds every answer. */
export function fakePeer(name: string, state: { route: Route | undefined; reachable: boolean; delay?: (() => Promise<void>) | undefined }): PeerCaller & { readonly calls: string[] } {
  const calls: string[] = []
  const answer = async (method: 'GET' | 'POST', path: string, body: unknown, file: string | undefined): Promise<PeerResponse<never>> => {
    calls.push(`${method} ${path}`)
    if (!state.reachable || state.route === undefined) return { ok: false, status: undefined, reason: 'unreachable', body: undefined }
    await state.delay?.()
    const wire = await state.route(method, path, body, file)
    if (wire === undefined) return { ok: false, status: 404, reason: 'http', body: { error: { code: 'not-found', message: 'no route' } } }
    return asResponse(wire) as PeerResponse<never>
  }
  return {
    calls,
    list: () => [{ name, reachable: state.reachable }],
    json: (peer, method, path, body) => (peer === name ? answer(method, path, body, undefined) : Promise.resolve({ ok: false, status: undefined, reason: 'unreachable', body: undefined })),
    upload: (peer, path, file) => (peer === name ? answer('POST', path, undefined, file) : Promise.resolve({ ok: false, status: undefined, reason: 'unreachable', body: undefined })),
  }
}

/** The projects of a `World` as two hosts see them: the source's clone and the target's. */
export function worldProjects(w: World, sourceId = 'vault', targetId = 'obsidian'): { readonly source: HandoffProject[]; readonly target: HandoffProject[] } {
  return { source: [{ id: sourceId, path: w.source }], target: [{ id: targetId, path: w.target }] }
}

/** Timers a test moves by hand: `advance(ms)` fires what is due, in order. */
export function manualTimers(): Timers & { readonly advance: (ms: number) => Promise<void>; readonly pending: () => number; readonly clock: () => Date } {
  const started = Date.now()
  let now = 0
  let seq = 0
  const due = new Map<number, { at: number; fn: () => void; every?: number }>()
  const add = (fn: () => void, ms: number, every?: number): Disposable => {
    const id = (seq += 1)
    due.set(id, { at: now + ms, fn, ...(every !== undefined ? { every } : {}) })
    return { [Symbol.dispose]: () => void due.delete(id) }
  }
  return {
    setTimeout: (fn, ms) => add(fn, ms),
    setInterval: (fn, ms) => add(fn, ms, ms),
    pending: () => due.size,
    /** The time these timers are at: what a host's `now` reads when the test moves time. */
    clock: () => new Date(started + now),
    advance: async (ms) => {
      const end = now + ms
      for (;;) {
        const next = [...due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (next === undefined) break
        const [id, timer] = next
        now = timer.at
        if (timer.every === undefined) due.delete(id)
        else due.set(id, { ...timer, at: timer.at + timer.every })
        timer.fn()
        // Let what the timer queued run before the next one.
        for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
      }
      now = end
    },
  }
}

// ---------------------------------------------------------------------------
// The target, driven by hand: the source's REAL git and files, the steps of D9 one by one
// ---------------------------------------------------------------------------

export interface TargetScenario {
  readonly w: World
  readonly source: TestHost
  readonly target: TestHost
  readonly t: Target
  readonly queue: KeyedQueue
  readonly hid: string
  readonly siteId: string
  readonly key: string
  readonly sessions: SessionMeta[]
}

export interface ScenarioOptions {
  readonly timers?: Timers
  readonly now?: () => Date
  readonly ttlMs?: number
  /** Before the sessions exist: commits, ignore rules, files on either side. */
  readonly setup?: (w: World) => Promise<void>
  readonly sessions?: number
}

export async function targetScenario(options: ScenarioOptions = {}): Promise<TargetScenario> {
  const w = await world()
  await options.setup?.(w)
  const projects = worldProjects(w)
  const source = await makeHost({ name: 'mac', projects: projects.source, env: w.env, peers: fakePeer('omarchy', { route: undefined, reachable: true }) })
  const target = await makeHost({ name: 'omarchy', projects: projects.target, env: w.env, peers: fakePeer('mac', { route: undefined, reachable: true }) })
  const timed = options.timers === undefined ? target : { ...target, host: { ...target.host, timers: options.timers, ...(options.now !== undefined ? { now: options.now } : {}) } }
  const queue = new KeyedQueue()
  const t = createTarget({ host: timed.host, queue, ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}) })
  const sessions: SessionMeta[] = []
  for (let i = 0; i < (options.sessions ?? 1); i += 1) sessions.push(await addSession(source, { siteId: 'vault', transcript: `{"turn":${i}}\n` }))
  return { w, source, target: timed, t, queue, hid: uuidv7(Date.now()), siteId: 'obsidian', key: remoteKey(w.bare) ?? '', sessions }
}

export async function prepareBody(sc: TargetScenario, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const head = await sh(sc.w.env, sc.w.source, 'rev-parse', 'HEAD')
  return { key: sc.key, branch: 'main', head, sessionIds: sc.sessions.map((s) => s.id), to: 'omarchy', ...over }
}

export interface Built {
  readonly head: string
  readonly wip: string | undefined
  readonly tree: string
  readonly entries: readonly ManifestEntry[]
  readonly sources: ReadonlyMap<number, string>
}

/** Steps 6 and 7 of the source, for real: the WIP, the bundle, the files, the manifest. */
export async function build(sc: TargetScenario, branchHead?: string): Promise<Built> {
  const work = join(sc.source.home, 'work', sc.hid)
  await mkdir(work, { recursive: true })
  const made = await wipCommit(sc.w.source, { indexFile: join(work, 'index'), hid: sc.hid, host: 'omarchy', base: sc.w.env })
  const bundle = await makeBundle(sc.w.source, { hid: sc.hid, head: made.head, wip: made.wip, base: handoffBase(branchHead), out: join(work, 'code.bundle'), env: sc.w.env })
  const files = (await Promise.all(sc.sessions.map(async (s) => (await sessionFiles(sc.source.host, s.id)).files))).flat()
  const manifest = await buildManifest(files, bundle === undefined ? undefined : { abs: bundle, bytes: (await stat(bundle)).size })
  return { head: made.head, wip: made.wip, tree: made.tree, entries: manifest.entries, sources: manifest.sources }
}

/** What the kernel does with an upload: the bytes, in a file of its own that the handler must move. */
export async function incoming(sc: TargetScenario, source: string): Promise<{ readonly path: string; readonly bytes: number }> {
  const dir = join(sc.target.home, '.incoming')
  await mkdir(dir, { recursive: true })
  const path = join(dir, uuidv7(Date.now()))
  await copyFile(source, path)
  return { path, bytes: (await stat(path)).size }
}

/** Step 7: the manifest and every file. Answers the first refusal, or the last answer. */
export async function deliver(sc: TargetScenario, built: Built): Promise<Wire> {
  const manifest = await sc.t.manifest(sc.hid, sc.siteId, built.entries)
  if (manifest.kind !== 'ok') return manifest
  let last: Wire = manifest
  for (const entry of built.entries) {
    last = await sc.t.file(sc.hid, sc.siteId, String(entry.n), await incoming(sc, built.sources.get(entry.n) ?? ''))
    if (last.kind !== 'ok') return last
  }
  return last
}

// ---------------------------------------------------------------------------
// Two whole handoffs, linked: each side's `PeerCaller` lands on the other's `HandoffApi`
// ---------------------------------------------------------------------------

/** The peer's routes as `handoff-routes.ts` mounts them, onto an API. An upload is copied first: the kernel's `.incoming`. */
export function apiRoute(api: HandoffApi, home: string): Route {
  return async (method, path, body, file) => {
    if (method === 'GET' && path === 'handoff/projects') return await api.projects()
    if (method === 'POST' && path === 'handoff/sessions-check') return await api.sessionsCheck(body)
    const step = /^handoff\/([^/]+)\/([^/]+)\/(prepare|manifest|commit|abort|done|status)$/.exec(path)
    if (step !== null) {
      const [, hid = '', siteId = '', name] = step
      if (method === 'GET' && name === 'status') return await api.status(hid, siteId)
      if (method !== 'POST') return undefined
      if (name === 'prepare') return await api.prepare(hid, siteId, body)
      if (name === 'manifest') return await api.manifest(hid, siteId, body)
      if (name === 'commit') return await api.commit(hid, siteId)
      if (name === 'abort') return await api.abort(hid, siteId)
      if (name === 'done') return await api.done(hid, siteId)
    }
    const upload = /^handoff\/([^/]+)\/([^/]+)\/file\/([^/]+)$/.exec(path)
    if (upload !== null && method === 'POST' && file !== undefined) {
      const dir = join(home, '.incoming')
      await mkdir(dir, { recursive: true })
      const copy = join(dir, uuidv7(Date.now()))
      await copyFile(file, copy)
      return await api.file(upload[1] ?? '', upload[2] ?? '', upload[3] ?? '', { path: copy, bytes: (await stat(copy)).size })
    }
    return undefined
  }
}

export interface Linked {
  readonly w: World
  readonly mac: TestHost & { readonly api: HandoffApi }
  readonly omarchy: TestHost & { readonly api: HandoffApi }
  /** What each side's peer link does: down, slow, or a route that intercepts. */
  readonly toOmarchy: { route: Route | undefined; reachable: boolean; delay?: (() => Promise<void>) | undefined }
  readonly toMac: { route: Route | undefined; reachable: boolean; delay?: (() => Promise<void>) | undefined }
}

/** The Mac (`vault`, the source clone) and omarchy (`obsidian`, the target clone), each with its handoff. */
export async function linked(options: { readonly setup?: (w: World) => Promise<void>; readonly handoff?: HandoffOptions } = {}): Promise<Linked> {
  const w = await world()
  await options.setup?.(w)
  const projects = worldProjects(w)
  const toOmarchy: Linked['toOmarchy'] = { route: undefined, reachable: true }
  const toMac: Linked['toMac'] = { route: undefined, reachable: true }
  const mac = await makeHost({ name: 'juans-macbook-pro', projects: projects.source, env: w.env, peers: fakePeer('omarchy', toOmarchy) })
  const omarchy = await makeHost({ name: 'omarchy', projects: projects.target, env: w.env, peers: fakePeer('juans-macbook-pro', toMac) })
  const macApi = createHandoff(mac.host, options.handoff)
  const omarchyApi = createHandoff(omarchy.host, options.handoff)
  toOmarchy.route = apiRoute(omarchyApi, omarchy.home)
  toMac.route = apiRoute(macApi, mac.home)
  return { w, mac: { ...mac, api: macApi }, omarchy: { ...omarchy, api: omarchyApi }, toOmarchy, toMac }
}
