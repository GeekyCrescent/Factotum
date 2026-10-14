/**
 * Two hosts in one process, for the handoff's tests (spec 2026-10-07-dos-hosts, H and J). Each has a
 * real store, real locks, a real index and real repos; they talk through a `PeerCaller` that calls
 * the other side's handoff in-process instead of over HTTP — what J11 asks for: «dos engines en el
 * mismo proceso, unidos por un PeerCaller de mentira».
 *
 * The status of each answer is mapped HERE the way `modules/sessions/handoff-routes.ts` maps it:
 * five kinds, five statuses. The two lists are short on purpose.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
import type { World } from './test-repos.ts'

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
export function fakePeer(name: string, state: { route: Route | undefined; reachable: boolean; delay?: () => Promise<void> }): PeerCaller & { readonly calls: string[] } {
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
