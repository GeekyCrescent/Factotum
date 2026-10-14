/**
 * The task board, composed as `main.ts` composes it, booted by the real kernel over a real socket
 * (spec 2026-10-14, criteria 1 and 2). The kernel never knows the module by name: it is handed the
 * list, as in production.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnyModule } from '@factotum/core'
import { boot, statePaths } from '@factotum/kernel'
import { tasksModule, type CreateTasks, type TasksLink } from '@factotum/modules'
import { createTasks, createTasksLink } from '@factotum/tasks'

const tasksFactory: CreateTasks = createTasks
const loopback = () => ({ lo0: [{ address: '127.0.0.1', internal: false }] }) as never

/** Fixed and unique: `listen.port` has a floor of 1024, so `0` is refused (CLAUDE.md §7). */
let nextPort = 46_700
const takePort = () => (nextPort += 1)

const probe: AnyModule = {
  id: 'probe',
  nav: { label: 'Probe', icon: 'dot' },
  routes: () => ({ 'GET /ping': () => ({ status: 200, body: { pong: true } }) }),
}

interface Summary {
  readonly id: string
  readonly status: { readonly kind: string; readonly reason?: string }
}

async function bootWith(t: { after: (fn: () => Promise<void>) => void }, modules: Record<string, unknown>) {
  const home = await mkdtemp(join(tmpdir(), 'factotum-tasks-'))
  const paths = statePaths('prod', home)
  await mkdir(paths.root, { recursive: true })
  const port = takePort()
  await writeFile(
    paths.config,
    JSON.stringify({ environment: 'prod', listen: { address: '127.0.0.1', port }, publicOrigin: 'https://mimac.tail1234.ts.net', modules }),
  )
  const link: TasksLink = createTasksLink()
  const errors: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => void errors.push(args.join(' '))
  const handle = await boot({
    env: 'prod',
    modules: [probe, tasksModule(tasksFactory, link)],
    version: 'test',
    paths,
    interfaces: loopback,
  })
  t.after(async () => {
    console.error = originalError
    await handle.stop()
    await rm(home, { recursive: true, force: true })
  })
  const list = async (): Promise<readonly Summary[]> =>
    ((await (await fetch(`${handle.localUrl}/modules`)).json()) as { modules: readonly Summary[] }).modules
  return { handle, link, list, errors }
}

test('without a tasks block the daemon boots as today, tasks is off and the link lists nothing (criterion 2)', async (t) => {
  const { handle, link, list } = await bootWith(t, { probe: { enabled: true } })
  assert.equal((await fetch(`${handle.localUrl}/modules/probe/ping`)).status, 200)
  // Not even listed: the drawer has nothing to show (`composeModules` skips a module with no block).
  assert.equal((await list()).find((m) => m.id === 'tasks'), undefined)
  assert.deepEqual(link.family.tools(), [])
})

test('a bad block switches off tasks alone; the other module serves, and the reason has no value (criterion 1)', async (t) => {
  const { handle, link, list } = await bootWith(t, {
    probe: { enabled: true },
    tasks: { enabled: true, timeZone: 'Mars/Olympus-Mons' },
  })
  assert.equal((await fetch(`${handle.localUrl}/modules/probe/ping`)).status, 200)
  const tasks = (await list()).find((m) => m.id === 'tasks')
  assert.equal(tasks?.status.kind, 'disabled')
  assert.match(tasks?.status.reason ?? '', /tasks\.timeZone/)
  assert.ok(!(tasks?.status.reason ?? '').includes('Olympus'))
  assert.equal((await fetch(`${handle.localUrl}/modules/tasks/board`)).status, 501)
  assert.deepEqual(link.family.tools(), [])
})

test('a good block serves the board, and the link is filled after start', async (t) => {
  const { handle, list, link } = await bootWith(t, { tasks: { enabled: true, timeZone: 'Australia/Sydney' } })
  assert.equal((await list()).find((m) => m.id === 'tasks')?.status.kind, 'enabled')
  const response = await fetch(`${handle.localUrl}/modules/tasks/board`)
  assert.equal(response.status, 200)
  const view = (await response.json()) as { timeZone: string; tasks: unknown[] }
  assert.equal(view.timeZone, 'Australia/Sydney')
  assert.deepEqual(view.tasks, [])
  // H4: filled LAST in start, the link lists create_task — what the sessions MCP reads on tools/list.
  assert.deepEqual(link.family.tools().map((tool) => tool.name), ['create_task'])
})
