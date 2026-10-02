/**
 * `reconcileServices` (spec 2026-10-02-servicios-en-segundo-plano, D6, criterion 25). Its own file because
 * one case owns a real process group: the leader dead, a child that ignores SIGTERM still in it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@factotum/core'
import { killGroup } from '../run.ts'
import type { EventInput, SessionEvent } from '../types.ts'
import { createServiceRegistry, reconcileServices, type RegistryEntry, type ServiceRegistry } from './registry.ts'
import { RESTART_REASON } from './shape.ts'
import { groupExists } from './spawn.ts'

const SELF = 50_000

interface World {
  readonly registry: ServiceRegistry
  readonly file: string
  readonly appended: { sessionId: string; event: EventInput }[]
  readonly killed: number[]
  readonly warnings: string[]
  readonly logs: Map<string, SessionEvent[]>
  readonly root: string
}

async function world(entries: readonly RegistryEntry[], writerPid = 40_000): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), 'factotum-reconcile-'))
  const file = join(root, 'services.json')
  await writeFile(file, JSON.stringify({ daemonPid: writerPid, services: entries }))
  return { registry: createServiceRegistry(file, SELF), file, appended: [], killed: [], warnings: [], logs: new Map(), root }
}

function deps(w: World, over: { alive?: (pid: number) => boolean; groupExists?: (pgid: number) => boolean; kill?: (pgid: number) => void } = {}) {
  return {
    registry: w.registry,
    append: async (sessionId: string, event: EventInput) => {
      if (sessionId === 'gone') throw new Error('ENOENT: the session has no directory')
      w.appended.push({ sessionId, event })
    },
    events: async (sessionId: string) => w.logs.get(sessionId) ?? [],
    alive: over.alive ?? (() => false),
    groupExists: over.groupExists ?? (() => true),
    kill: over.kill ?? ((pgid: number) => void w.killed.push(pgid)),
    log: { info: () => undefined, warn: (m: string) => void w.warnings.push(m), error: () => undefined } as Logger,
  }
}

const entry = (sessionId: string, id: string, pid: number): RegistryEntry => ({ sessionId, id, pid, startedAt: 't' })

test('a group that still exists is SIGKILLed, and its service ends as shutdown with the restart reason', async () => {
  const w = await world([entry('a', 's1', 111)])
  await reconcileServices(deps(w))
  assert.deepEqual(w.killed, [111])
  assert.deepEqual(w.appended, [{ sessionId: 'a', event: { kind: 'service', phase: 'ended', id: 's1', outcome: 'shutdown', reason: RESTART_REASON } }])
  await rm(w.root, { recursive: true })
})

test('a group that no longer exists is not touched, and its service still ends', async () => {
  const w = await world([entry('a', 's1', 111)])
  await reconcileServices(deps(w, { groupExists: () => false }))
  assert.deepEqual(w.killed, [])
  assert.equal(w.appended.length, 1)
  await rm(w.root, { recursive: true })
})

test('a service whose log already has its ended gets no second one (criterion 32)', async () => {
  const w = await world([entry('a', 's1', 111), entry('a', 's2', 222)])
  w.logs.set('a', [{ seq: 4, at: 't', kind: 'service', phase: 'ended', id: 's1', outcome: 'shutdown', reason: 'the daemon was shutting down' }])
  await reconcileServices(deps(w))
  assert.deepEqual(
    w.appended.map((a) => (a.event as { id: string }).id),
    ['s2'],
  )
  await rm(w.root, { recursive: true })
})

test('a session with no directory is warned about and the NEXT entry is still reconciled; nothing escapes', async () => {
  const w = await world([entry('gone', 's1', 111), entry('b', 's1', 222)])
  await reconcileServices(deps(w))
  assert.deepEqual(w.killed, [111, 222])
  assert.deepEqual(
    w.appended.map((a) => a.sessionId),
    ['b'],
  )
  assert.equal(w.warnings.filter((m) => m.includes('could not be reconciled')).length, 1)
  await rm(w.root, { recursive: true })
})

test('the registry is EMPTY at the end', async () => {
  const w = await world([entry('a', 's1', 111)])
  await reconcileServices(deps(w))
  assert.deepEqual(JSON.parse(await readFile(w.file, 'utf8')), { daemonPid: SELF, services: [] })
  await rm(w.root, { recursive: true })
})

test('written by ANOTHER LIVE daemon: nothing is killed, written or cleared (row 1 of lifecycle.ts)', async () => {
  const w = await world([entry('a', 's1', 111)], 40_000)
  await reconcileServices(deps(w, { alive: (pid) => pid === 40_000 }))
  assert.deepEqual([w.killed, w.appended], [[], []])
  assert.equal(JSON.parse(await readFile(w.file, 'utf8')).services.length, 1)
  assert.match(w.warnings[0] ?? '', /another daemon/)
  await rm(w.root, { recursive: true })
})

test('a corrupt registry is warned, moved to .bad and treated as empty', async () => {
  const w = await world([])
  await writeFile(w.file, '{half')
  await reconcileServices(deps(w))
  assert.equal(await readFile(`${w.file}.bad`, 'utf8'), '{half')
  assert.equal(w.warnings.length, 1)
  assert.deepEqual([w.killed, w.appended], [[], []])
  await rm(w.root, { recursive: true })
})

test('no registry at all: nothing happens and nothing is warned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factotum-reconcile-'))
  const w: World = { registry: createServiceRegistry(join(root, 'services.json'), SELF), file: '', appended: [], killed: [], warnings: [], logs: new Map(), root }
  await reconcileServices(deps(w))
  assert.deepEqual([w.killed, w.appended, w.warnings], [[], [], []])
  await rm(root, { recursive: true })
})

test('a registry that cannot even be read does not throw out of reconcile', async () => {
  const w = await world([entry('a', 's1', 111)])
  const broken = { ...w.registry, read: async () => Promise.reject(new Error('EIO')) }
  await reconcileServices({ ...deps(w), registry: broken })
  assert.equal(w.warnings.length, 1)
  await rm(w.root, { recursive: true })
})

test('REAL GROUP: the leader is dead and a child that ignores SIGTERM is alive — it dies (criterion 25)', async () => {
  const child = spawn('/bin/sh', ['-c', "(trap '' TERM; sleep 600) & wait"], { detached: true, stdio: 'ignore' })
  child.on('error', () => undefined)
  const pid = child.pid as number
  await new Promise((resolve) => setTimeout(resolve, 200))
  // The leader only: the trapping child stays behind with the leader's pid as its group id.
  process.kill(pid, 'SIGKILL')
  await new Promise((resolve) => child.on('exit', resolve))
  assert.equal(groupExists(pid), true, 'the child should still be in the group')

  const w = await world([entry('a', 's1', pid)])
  await reconcileServices(deps(w, { groupExists, kill: (pgid) => killGroup(pgid, 'SIGKILL') }))
  const until = Date.now() + 5_000
  while (groupExists(pid) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(groupExists(pid), false)
  await rm(w.root, { recursive: true })
})
