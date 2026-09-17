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
import { ALL_MODULES, sessionsModule, type CreateEngine } from '@factotum/modules'
import { createEngine } from '@factotum/sessions'
import { BootError, boot, createStaticSite, resolveEnvironment } from '@factotum/kernel'
import { VERSION } from '@factotum/kernel/version'
import { doctor } from './doctor.ts'
import { init, terminalAsk } from './init.ts'
import { install, uninstall } from './install.ts'
import { qrCommand } from './qr-command.ts'
import { siteCommand, stripEnvFlag } from './site-command.ts'
import { pushCommand } from './push-command.ts'

const USAGE = `factotum ${VERSION}

  factotum init [--env dev|prod]       write a config, show a QR
  factotum start [--env dev|prod]      run the daemon in the foreground
  factotum doctor                      report what is set up, without starting anything
  factotum qr [--env dev|prod]         show the QR again, without touching the config
  factotum site <add|list|rm>          declare where agents may write, and restart
  factotum push reset [--env dev|prod] forget every device subscribed to notifications
  factotum install [--env dev|prod]    keep it running across logins (launchd)
  factotum uninstall [--env dev|prod]  stop doing that

  factotum site add <path> [--id <id>] [--shared] [--yes] [--no-restart]
  factotum site list [--json]
  factotum site rm <id|path>

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
    case 'qr':
      return await qrCommand({ env })
    case 'site': {
      // `--env` is consumed above and must not reach the subcommand parser, which
      // treats the first non-flag argument as the path.
      const argv = stripEnvFlag(rest)
      const ask = terminalAsk()
      return await siteCommand(ask === undefined ? { env, argv } : { env, argv, ask })
    }
    case 'push':
      // Same reason as `site`: `--env` must not reach the subcommand parser.
      return await pushCommand({ env, argv: stripEnvFlag(rest) })
    case 'start':
      return await start(env)
    case 'install':
      return await install({ env })
    case 'uninstall':
      return await uninstall({ env })
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

/**
 * THE COMPILER LINK, and it is the only place the engine's real shape meets the shape
 * the module declares by hand.
 *
 * `modules/sessions/types.ts` cannot import the engine's package — CLAUDE.md §1 says a
 * module depends on `packages/core` and only on core — so the two describe the same
 * thing separately and TypeScript, being structural, joins them up right here. Remove a
 * member from the engine's facade, or change the type of an argument, and this line
 * stops compiling.
 *
 * What it does NOT catch is a field ADDED to a return type on the engine's side: the
 * module would drop it in silence. That asymmetry runs the safe way — a feature nobody
 * sees rather than a decision taken with missing data — and it only runs that way
 * because there is one zod schema for the config fragment, not two.
 */
const engineFactory: CreateEngine = createEngine

async function start(env: Parameters<typeof boot>[0]['env']): Promise<number> {
  /**
   * Where the hook can reach this daemon, as a thunk.
   *
   * The URL does not exist until `boot` has verified the bind — a module is handed no
   * address and no port, deliberately, because the network surface is one decision in
   * one place. So the engine is given a way to ASK, and the answer is filled in on the
   * statement after `boot` returns.
   *
   * The window between those two statements is real and it fails CLOSED: a launch that
   * arrives in it gets an error explaining itself, rather than an agent running with a
   * gate nobody can reach. A plain Error and not a `BootError`, because by then booting
   * is over and this is not a startup failure.
   */
  let verifiedUrl: string | undefined
  const hookUrl = (): string => {
    if (verifiedUrl === undefined) {
      throw new Error('factotum is still composing itself; try again in a moment')
    }
    return verifiedUrl
  }

  let handle
  try {
    handle = await boot({
      env,
      modules: [...ALL_MODULES, sessionsModule(engineFactory, hookUrl)],
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

  // THE LOCAL URL, NOT THE PUBLIC ONE. This is the single line that decides which URL
  // ends up in the hook's settings.json, and the hook runs beside the daemon on this
  // machine: pointing it at the public origin would route every permission decision
  // out through `tailscale serve` and back, so the gate would fail whenever the proxy
  // was down — which is precisely when a session is most likely to be running.
  verifiedUrl = handle.localUrl

  // The PUBLIC one here: this is the line a human reads and opens on their phone.
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
