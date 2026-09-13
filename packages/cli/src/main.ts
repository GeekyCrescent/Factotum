#!/usr/bin/env node
/**
 * The binary, and THE COMPOSITION ROOT.
 *
 * This is the only place that imports `@factotum/modules`. The kernel receives the
 * list through `boot({ modules })` and therefore never knows a module by name —
 * which is what makes `grep -rn '<any module id>' packages/kernel/src` come back
 * empty, and what stops the kernel growing a special case per module.
 *
 * It is also the only place that decides an exit code. `boot` throws; nothing below
 * this file calls `process.exit`, so every abort path stays testable in-process.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_MODULES } from '@factotum/modules'
import { BootError, boot, createStaticSite, resolveEnvironment } from '@factotum/kernel'
import { VERSION } from '@factotum/kernel/version'
import { doctor } from './doctor.ts'
import { init, terminalAsk } from './init.ts'

const USAGE = `factotum ${VERSION}

  factotum init [--env dev|prod]    find an address, write a config, show a QR
  factotum start [--env dev|prod]   run the daemon in the foreground
  factotum doctor                   report what is set up, without starting anything

Environment resolves as --env, then FACTOTUM_ENV, then prod.
`

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  const flagIndex = rest.indexOf('--env')
  const envFlag = flagIndex === -1 ? undefined : rest[flagIndex + 1]

  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(USAGE)
    return command === undefined ? 1 : 0
  }
  if (command === '--version') {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  let env
  try {
    env = resolveEnvironment(envFlag, process.env['FACTOTUM_ENV'])
  } catch (error) {
    console.error((error as Error).message)
    return 2
  }

  switch (command) {
    case 'init': {
      const ask = terminalAsk()
      return await init(ask === undefined ? { env } : { env, ask })
    }
    case 'doctor':
      return await doctor()
    case 'start':
      return await start(env)
    default:
      console.error(`unknown command "${command}"\n`)
      process.stdout.write(USAGE)
      return 2
  }
}

/**
 * The client is served by the daemon itself, from this repository's build output.
 * One address for everything is the point: the QR carries a single URL.
 */
function siteRoot(): string {
  // packages/cli/dist/main.js -> repository root -> apps/web/dist
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'web', 'dist')
}

async function start(env: Parameters<typeof boot>[0]['env']): Promise<number> {
  let handle
  try {
    handle = await boot({
      env,
      modules: ALL_MODULES,
      version: VERSION,
      site: createStaticSite(siteRoot()),
    })
  } catch (error) {
    if (error instanceof BootError) {
      // Fail closed, but never silently: what was looked for, what was found, and
      // what to do about it. "It refuses to start and I do not know why" is the
      // standard complaint about projects that get this part right.
      console.error(`factotum cannot start (${error.code})`)
      console.error(error.format())
      return 1
    }
    throw error
  }

  console.log(`factotum ${VERSION} [${env}] ready at ${handle.url}`)

  const shutdown = (signal: string) => {
    console.log(`\n${signal} — stopping`)
    void handle
      .stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // Hold the process open. Module timers are unref'd on purpose, so without this
  // the event loop would drain and a daemon with nothing to do would simply exit.
  await new Promise<void>(() => {})
  return 0
}

const invokedDirectly = process.argv[1]?.endsWith('main.js') === true
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exitCode = code
    },
    (error: unknown) => {
      console.error(error)
      process.exitCode = 1
    },
  )
}
