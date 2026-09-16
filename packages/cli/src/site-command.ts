/**
 * `factotum site add|list|rm` — the boundary, edited by a command instead of by hand.
 *
 * THIS COMMAND WIDENS WHAT AN AGENT MAY WRITE, so it asks before it does. That is not
 * ceremony: an agent has a shell, `Bash` is not checked against the boundary
 * (`docs/running-agents.md`), and a convenient `site add` is a convenient way for one
 * to grant itself a directory. `--yes` skips the prompt and is meant to be visible in
 * whatever log runs it.
 *
 * The editing itself is in `site.ts` and pure. Here: the disk, the prompt, and asking
 * the supervisor to pick the change up.
 */

import { readFile, writeFile, rename, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { statePaths } from '@factotum/kernel'
import type { Environment } from '@factotum/core'
import { addSite, listSites, removeSite } from './site.ts'
import { restartDaemon } from './restart.ts'
import type { Runner } from './tailscale.ts'

export interface SiteCommandDeps {
  readonly env: Environment
  readonly argv: readonly string[]
  readonly home?: string
  readonly out?: (line: string) => void
  /** `undefined` in a non-interactive run, where a prompt would hang for ever. */
  readonly ask?: (question: string) => Promise<string>
  readonly run?: Runner
  readonly uid?: number
  readonly platform?: NodeJS.Platform
}

/**
 * `--env prod` and its value removed, because the subcommand parser reads the first
 * non-flag argument as the path.
 *
 * IT LIVES HERE AND HAS A TEST because the first version of it lived inline in
 * `main.ts` as `filter((_, at) => at !== flagIndex && at !== flagIndex + 1)`. With no
 * `--env` present, `flagIndex` is `-1`, so `flagIndex + 1` is `0` — and it silently
 * dropped the subcommand. Every `factotum site …` printed the usage. `main.ts` has no
 * test file, so the only thing that caught it was running it.
 */
export function stripEnvFlag(argv: readonly string[]): readonly string[] {
  const at = argv.indexOf('--env')
  return at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)]
}

export async function siteCommand(deps: SiteCommandDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line))
  const [action, ...rest] = deps.argv

  switch (action) {
    case 'list':
      return await runList(deps, out)
    case 'add':
      return await runAdd(deps, rest, out)
    case 'rm':
    case 'remove':
      return await runRemove(deps, rest, out)
    default:
      out('usage: factotum site <add|list|rm> [...]')
      out('')
      out('  factotum site add <path> [--id <id>] [--shared] [--yes] [--no-restart]')
      out('  factotum site list [--json]')
      out('  factotum site rm <id|path> [--yes] [--no-restart]')
      return 2
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function runList(deps: SiteCommandDeps, out: (line: string) => void): Promise<number> {
  const loaded = await load(deps, out)
  if (loaded === undefined) return 1

  const { sites, sharedPaths } = listSites(loaded.config)
  if (deps.argv.includes('--json')) {
    out(JSON.stringify({ sites, sharedPaths }))
    return 0
  }

  if (sites.length === 0) out('no sites declared — an agent has nowhere it may write')
  for (const site of sites) out(`  ${site.id.padEnd(16)} ${site.path}`)
  for (const path of sharedPaths) out(`  ${'(shared)'.padEnd(16)} ${path}`)
  if (sharedPaths.length > 0) out('')
  if (sharedPaths.length > 0) out('  shared paths are writable from every site, and nothing locks them')
  return 0
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

async function runAdd(
  deps: SiteCommandDeps,
  rest: readonly string[],
  out: (line: string) => void,
): Promise<number> {
  const raw = rest.find((arg) => !arg.startsWith('--'))
  if (raw === undefined) {
    out('which directory? usage: factotum site add <path> [--id <id>] [--shared]')
    return 2
  }

  // Resolved here and not in `site.ts`: turning `.` into a path depends on where the
  // command was run, which is I/O in everything but name.
  const path = isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
  const shared = rest.includes('--shared')
  const idFlag = flagValue(rest, '--id')

  const exists = await isDirectory(path)
  if (!exists) {
    // The same refusal the daemon would make at startup, made now — while the person
    // who typed the path is still here to fix it.
    out(`${path} is not a directory that exists.`)
    out('A declared boundary that is not there disables the whole module at startup.')
    return 1
  }

  const loaded = await load(deps, out)
  if (loaded === undefined) return 1

  const edit = addSite(loaded.config, idFlag === undefined ? { path, shared } : { path, id: idFlag, shared })
  if (!edit.ok) {
    out(edit.error)
    return 1
  }

  const what = shared ? `shared path ${path}` : `site ${describeAdded(edit.config, path)}`
  if (!(await confirmed(deps, rest, out, `Let agents write in ${what}?`))) return 0

  await write(loaded.path, edit.config)
  out(`added ${what}`)
  if (shared) out('nothing locks a shared path: two agents can write the same file there')
  return await maybeRestart(deps, rest, out)
}

function describeAdded(config: unknown, path: string): string {
  const added = listSites(config).sites.find((site) => site.path === path)
  return added === undefined ? path : `"${added.id}" (${path})`
}

// ---------------------------------------------------------------------------
// rm
// ---------------------------------------------------------------------------

async function runRemove(
  deps: SiteCommandDeps,
  rest: readonly string[],
  out: (line: string) => void,
): Promise<number> {
  const target = rest.find((arg) => !arg.startsWith('--'))
  if (target === undefined) {
    out('which one? usage: factotum site rm <id|path>')
    return 2
  }

  const loaded = await load(deps, out)
  if (loaded === undefined) return 1

  const edit = removeSite(loaded.config, target)
  if (!edit.ok) {
    out(edit.error)
    return 1
  }

  // Narrowing the boundary does not need consent the way widening it does, but a live
  // session in that site would be refused on its next write, so it is still announced.
  await write(loaded.path, edit.config)
  out(`removed ${target}`)
  out('a session running there is denied on its next write, with the reason')
  return await maybeRestart(deps, rest, out)
}

// ---------------------------------------------------------------------------
// the shared plumbing
// ---------------------------------------------------------------------------

async function load(
  deps: SiteCommandDeps,
  out: (line: string) => void,
): Promise<{ path: string; config: unknown } | undefined> {
  const path = statePaths(deps.env, deps.home).config
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    out(`no config at ${path} — run \`factotum init --env ${deps.env}\` first`)
    return undefined
  }
  try {
    return { path, config: JSON.parse(raw) as unknown }
  } catch (error) {
    out(`the config at ${path} is not valid JSON: ${(error as Error).message}`)
    return undefined
  }
}

/** Written beside the target and renamed: a crash mid-write must not leave half a boundary. */
async function write(path: string, config: unknown): Promise<void> {
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

async function confirmed(
  deps: SiteCommandDeps,
  rest: readonly string[],
  out: (line: string) => void,
  question: string,
): Promise<boolean> {
  if (rest.includes('--yes')) return true
  if (deps.ask === undefined) {
    // No terminal and no `--yes` means nobody consented. Assuming yes here is how a
    // script — or an agent — ends up widening the boundary without anyone deciding to.
    out('refusing to widen the boundary without a confirmation: pass --yes')
    return false
  }
  const answer = (await deps.ask(`${question} [y/N] `)).trim().toLowerCase()
  if (answer === 'y' || answer === 'yes') return true
  out('left alone. Nothing was written.')
  return false
}

async function maybeRestart(
  deps: SiteCommandDeps,
  rest: readonly string[],
  out: (line: string) => void,
): Promise<number> {
  if (rest.includes('--no-restart')) {
    out('not restarting: the daemon keeps the old boundary until it does')
    return 0
  }
  await restartDaemon({
    env: deps.env,
    out,
    ...(deps.run === undefined ? {} : { run: deps.run }),
    ...(deps.uid === undefined ? {} : { uid: deps.uid }),
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
  })
  return 0
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at === -1 ? undefined : argv[at + 1]
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
