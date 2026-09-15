/**
 * `factotum install` / `factotum uninstall` — the side of supervision that touches
 * the machine.
 *
 * The composing lives in `supervise.ts` and is pure; this is the part that writes a
 * file and calls `launchctl`, kept apart so the decisions are testable without a
 * LaunchAgents directory.
 */

import { mkdir, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { execPath } from 'node:process'
import { fileURLToPath } from 'node:url'
import { statePaths } from '@factotum/kernel'
import type { Environment } from '@factotum/core'
import { execRunner, type Runner } from './tailscale.ts'
import {
  bootoutArgs,
  bootstrapArgs,
  composePlist,
  labelFor,
  logDir,
  logPaths,
  plistPath,
} from './supervise.ts'

export interface InstallDeps {
  readonly env: Environment
  readonly home?: string
  readonly out?: (line: string) => void
  readonly run?: Runner
  readonly uid?: number
  /** Overridable so a test does not have to live next to the built CLI. */
  readonly mainPath?: string
  readonly path?: string
}

function defaultMainPath(): string {
  return resolve(fileURLToPath(import.meta.url), '..', 'main.js')
}

export async function install(deps: InstallDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line))
  const run = deps.run ?? execRunner
  const home = deps.home ?? homedir()
  const uid = deps.uid ?? process.getuid?.() ?? 0
  const paths = statePaths(deps.env, home)

  const plist = composePlist({
    env: deps.env,
    nodePath: execPath,
    mainPath: deps.mainPath ?? defaultMainPath(),
    stateRoot: paths.root,
    // Captured from the shell running `install`, because a LaunchAgent does not get
    // one. Without it the daemon is fine and every session dies with ENOENT.
    path: deps.path ?? process.env['PATH'] ?? '',
  })

  const target = plistPath(home, deps.env)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, plist, 'utf8')

  // launchd does NOT create the directory for StandardOutPath. If it is missing the
  // job fails to start, and it fails without leaving anything in the log it could not
  // open — which is as opaque as a failure gets.
  await mkdir(logDir(paths.root), { recursive: true })

  // Replacing an install should not need two commands, and bootout on a job that is
  // not loaded is an error worth ignoring rather than reporting.
  await run('launchctl', bootoutArgs(uid, deps.env))

  const result = await run('launchctl', bootstrapArgs(uid, target))
  if (result.code !== 0) {
    out(`launchctl refused to load ${labelFor(deps.env)} (exit ${String(result.code)})`)
    out(`  plist:  ${target}`)
    out(`  try:    launchctl bootstrap gui/${uid} ${target}`)
    return 1
  }

  const logs = logPaths(paths.root)
  out(`Installed ${labelFor(deps.env)}`)
  out(`  plist   ${target}`)
  out(`  logs    ${logs.out}`)
  out(`          ${logs.err}`)
  out('')
  out('It starts at login and relaunches if it crashes. A config it refuses to start')
  out('on leaves it DOWN, on purpose — check the error log above.')
  out('')
  out(`Check it with:  launchctl list | grep factotum`)
  out('')
  out('This does not start `tailscale serve`. If it is not already running:')
  out(`    tailscale serve --bg --https=443 http://127.0.0.1:${paths.config.includes('dev') ? 7778 : 7777}`)
  return 0
}

export async function uninstall(deps: InstallDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line))
  const run = deps.run ?? execRunner
  const home = deps.home ?? homedir()
  const uid = deps.uid ?? process.getuid?.() ?? 0

  // The asymmetry: bootout takes a SERVICE TARGET, bootstrap takes a FILE PATH.
  const result = await run('launchctl', bootoutArgs(uid, deps.env))
  const target = plistPath(home, deps.env)
  await rm(target, { force: true })

  if (result.code !== 0) {
    // Already gone is the common case and is not a failure: `uninstall` twice should
    // be quiet, and the plist is removed either way.
    out(`${labelFor(deps.env)} was not loaded; removed ${target}`)
    return 0
  }

  out(`Removed ${labelFor(deps.env)} and ${target}`)
  out('The state directory and config are untouched.')
  return 0
}
