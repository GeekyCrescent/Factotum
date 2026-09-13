/**
 * The reference module. It is useless on purpose.
 *
 * Its job is to be COPIED, and something useful would invite extending it instead.
 * What it does do is exercise all five parts of the contract at once — config,
 * routes, nav, a client screen, and background work — because a contract proven by
 * four of them is a contract with an untested part, and the untested one is always
 * `start`.
 *
 * Read this alongside `docs/writing-a-module.md`. The comments here are heavier than
 * they would be in real code, because this file is also documentation.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FactotumModule, ModuleContext } from '@factotum/core'
import { exampleConfigSchema, type ExampleConfig } from './config.ts'

interface Ticks {
  readonly ticks: number
  readonly since: string
}

/**
 * State lives under `ctx.stateDir`, which the kernel created before your module
 * existed. Writing anywhere else is possible — this is not a sandbox — but it is
 * the thing that makes a module not portable to somebody else's machine.
 */
async function readTicks(stateDir: string): Promise<Ticks> {
  try {
    const text = await readFile(join(stateDir, 'ticks.json'), 'utf8')
    return JSON.parse(text) as Ticks
  } catch {
    return { ticks: 0, since: new Date(0).toISOString() }
  }
}

async function writeTicks(stateDir: string, ticks: Ticks): Promise<void> {
  await writeFile(join(stateDir, 'ticks.json'), JSON.stringify(ticks), 'utf8')
}

export const exampleModule: FactotumModule<ExampleConfig> = {
  id: 'example',

  configSchema: exampleConfigSchema,

  nav: { label: 'Example', icon: 'dot', order: 100 },

  /**
   * Routes are RETURNED, not mounted. Your module is handed nothing it could listen
   * with — no server, no port, no address — which is what keeps the network surface
   * a single decision made in one place.
   *
   * The path you write here is relative: the kernel serves this at
   * `/modules/example/ping`.
   */
  routes: (ctx: ModuleContext<ExampleConfig>) => ({
    'GET /ping': async () => {
      const state = await readTicks(ctx.stateDir)
      return { status: 200, body: { greeting: ctx.config.greeting, ...state } }
    },
  }),

  /**
   * Background work. Called only after the daemon has proven where it is listening,
   * and bounded by a timeout — if this hangs, your module is disabled rather than
   * the whole daemon sitting at "starting" forever.
   *
   * Use `ctx.timers`, never the global `setInterval`. The kernel owns what it hands
   * you: it unrefs them so your work never keeps the process alive on its own, and
   * it disposes them even if this function throws after arming one. Tests can
   * advance them; a global timer would make a test wait thirty real seconds.
   */
  start: async (ctx: ModuleContext<ExampleConfig>) => {
    const state = await readTicks(ctx.stateDir)
    let ticks = state.ticks
    const since = state.ticks === 0 ? ctx.now().toISOString() : state.since

    const timer = ctx.timers.setInterval(() => {
      ticks += 1
      void writeTicks(ctx.stateDir, { ticks, since }).catch((error: unknown) => {
        ctx.log.warn(`could not persist ticks: ${String(error)}`)
      })
    }, ctx.config.tickSeconds * 1_000)

    ctx.log.info(`ticking every ${ctx.config.tickSeconds}s`)

    return {
      stop: () => {
        timer[Symbol.dispose]()
      },
    }
  },
}
