import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger, Timers } from '@factotum/core'
import { createCallers } from '../callers.ts'
import { NOT_RUNNING } from '../questions/mcp.ts'
import { sessionPaths } from '../paths.ts'
import type { Site } from '../sites.ts'
import type { EventInput, SessionEvent } from '../types.ts'
import { RESTART_REASON } from './shape.ts'
import { createServices, loginShell } from './wire.ts'

const timers: Timers = {
  setInterval: () => ({ [Symbol.dispose]: () => undefined }),
  setTimeout: () => ({ [Symbol.dispose]: () => undefined }),
}
const SITE: Site = { id: 'work', path: '/work/repo', realPath: '/work/repo', isRepo: false }

async function world(state: { live?: string; stopped?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'factotum-wire-'))
  const appended: { sessionId: string; event: EventInput }[] = []
  const flags = { live: state.live, stopped: state.stopped ?? false }
  const services = createServices({
    store: {
      append: async (sessionId, event) => void appended.push({ sessionId, event }),
      read: async () => ({ events: [] as readonly SessionEvent[] }),
    },
    paths: sessionPaths(root),
    timers,
    now: () => new Date(0),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined } as Logger,
    callers: createCallers(),
    liveSiteId: (sessionId) => (sessionId === flags.live ? 'work' : undefined),
    lastSite: (siteId) => (siteId === 'work' ? SITE : undefined),
    isStopped: () => flags.stopped,
    seams: { shell: ['/bin/sh', '-c'] },
  })
  return { services, root, appended, flags }
}

test('liveSite: a session not live, or any session once stopped, is NOT_RUNNING through the wired call', async () => {
  const w = await world({ live: 'sess-a' })
  const list = async (sessionId: string) => await w.services.mcp.call({ sessionId, toolUseId: undefined, name: 'list_services', raw: {} })
  assert.equal((await list('sess-a')).isError, undefined)
  assert.equal((await list('sess-b')).content[0]?.text, NOT_RUNNING)
  w.flags.stopped = true
  assert.equal((await list('sess-a')).content[0]?.text, NOT_RUNNING)
  await rm(w.root, { recursive: true })
})

test('the four tools are wired as data', async () => {
  const w = await world()
  assert.deepEqual(
    w.services.mcp.tools.map((t) => t.name),
    ['start_service', 'service_output', 'stop_service', 'list_services'],
  )
  await rm(w.root, { recursive: true })
})

test('reconcile arrives wired: the registry of a dead daemon is closed and emptied', async () => {
  const w = await world()
  const file = sessionPaths(w.root).servicesRegistry
  // A pid that is no group: 2^22 is above macOS's pid ceiling.
  await writeFile(file, JSON.stringify({ daemonPid: 4_194_304, services: [{ sessionId: 'sess-a', id: 's1', pid: 4_194_304, startedAt: 't' }] }))
  await w.services.reconcile()
  assert.deepEqual(w.appended, [{ sessionId: 'sess-a', event: { kind: 'service', phase: 'ended', id: 's1', outcome: 'shutdown', reason: RESTART_REASON } }])
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).services, [])
  await rm(w.root, { recursive: true })
})

test('the daemon runs services in the owner\'s login shell, interactive (tasks A1)', () => {
  assert.deepEqual(loginShell().slice(1), ['-l', '-i', '-c'])
  assert.match(loginShell()[0] ?? '', /^\//)
})
