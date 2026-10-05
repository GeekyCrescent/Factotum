/**
 * Criterion 32 (spec 2026-10-03-skills-a-mano): 300 synthetic logs of 50 events, `usage(30)` under 1 s.
 *
 * BY HAND, not in the suite (`pnpm test` globs `src/**` only): a timing on a shared box is a flaky test.
 *   node packages/sessions/scripts/usage-bench.ts
 * Prints the time of each run and exits 1 if the slowest is over the budget.
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Timers } from '@factotum/core'
import { createEngine } from '../src/engine.ts'
import { uuidv7 } from '../src/id.ts'
import { sessionPaths } from '../src/paths.ts'
import { SessionStore } from '../src/store.ts'
import { memoryRegistry } from '../src/test-registry.ts'
import type { EventInput } from '../src/types.ts'

const SESSIONS = 300
const EVENTS_PER_SESSION = 50
const RUNS = 5
const BUDGET_MS = 1_000
const DAY_MS = 24 * 60 * 60 * 1000

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

/** A mix like a real log: user messages (some with /name), tool calls (some Skill), results, subagents. */
function eventOf(i: number): EventInput {
  switch (i % 5) {
    case 0:
      return { kind: 'message', role: 'user', text: i % 10 === 0 ? '/create-spec the idea of the day' : 'a plain prompt of some length '.repeat(4) }
    case 1:
      return { kind: 'tool', name: 'Skill', input: { skill: 'create-spec', args: 'x' } }
    case 2:
      return { kind: 'tool', name: 'Read', input: { file_path: '/tmp/some/file.ts' } }
    case 3:
      return { kind: 'result', name: 'Read', ok: true, summary: 'read 120 lines' }
    default:
      return { kind: 'subagent', phase: 'started', task: `t${i}`, agent: 'spec-validator', description: 'check', background: false }
  }
}

const root = await realpath(await mkdtemp(join(tmpdir(), 'factotum-usage-bench-')))
try {
  const stateDir = join(root, 'state')
  await mkdir(join(root, 'a'), { recursive: true })
  const paths = sessionPaths(stateDir)
  const now = Date.now()
  const store = new SessionStore(paths, () => new Date(now))
  await store.ensureRoots()
  await writeFile(
    paths.announcedFile,
    JSON.stringify({ skills: ['create-spec'], agents: ['spec-validator'], commands: ['clear'], version: '2.0.0', since: new Date(now - 10 * DAY_MS).toISOString() }),
  )
  const seeding = performance.now()
  for (let s = 0; s < SESSIONS; s++) {
    // Spread over 25 days, so the 30-day window takes all of them.
    const startedAt = now - (s % 25) * DAY_MS - s
    const id = uuidv7(startedAt)
    await store.create({ id, siteId: 'a', entryId: 'free', startedAt: new Date(startedAt).toISOString(), sitePath: undefined, agent: undefined, prompt: undefined })
    for (let i = 0; i < EVENTS_PER_SESSION; i++) await store.append(id, eventOf(i))
    await store.patchMeta(id, (m) => ({ ...m, state: 'finished', endedAt: new Date(startedAt + 1000).toISOString() }))
  }
  console.log(`seeded in ${(performance.now() - seeding).toFixed(0)} ms`)

  const engine = await createEngine({
    titles: { enabled: false, model: 'haiku', effort: 'low' },
    stateDir,
    registry: memoryRegistry({ sites: [{ id: 'a', path: join(root, 'a') }] }),
    home: join(root, 'home'),
    factotumRoot: join(root, 'home', '.factotum'),
    installRoot: undefined,
    catalog: [{ id: 'free', label: 'Free', invoke: { kind: 'none' } }],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date(now),
    timers,
    hookUrl: () => 'http://127.0.0.1:1',
    notify: { canReach: () => false, send: async () => undefined },
  })
  await engine.reconcile()

  const times: number[] = []
  for (let run = 0; run < RUNS; run++) {
    const start = performance.now()
    const counts = await engine.usage(30)
    times.push(performance.now() - start)
    if (run === 0) console.log('counts:', JSON.stringify(counts))
  }
  console.log(`${SESSIONS} logs x ${EVENTS_PER_SESSION} events, usage(30): ${times.map((t) => `${t.toFixed(0)} ms`).join(', ')}`)
  const worst = Math.max(...times)
  console.log(worst < BUDGET_MS ? `OK: slowest ${worst.toFixed(0)} ms < ${BUDGET_MS} ms` : `FAIL: slowest ${worst.toFixed(0)} ms >= ${BUDGET_MS} ms`)
  process.exitCode = worst < BUDGET_MS ? 0 : 1
} finally {
  await rm(root, { recursive: true, force: true })
}
