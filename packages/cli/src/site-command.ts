/**
 * `factotum site list|add|rm` — the projects, READ by a command; never written by one.
 *
 * THE DAEMON IS THE ONLY WRITER of the projects registry (spec 2026-09-29, D1; ADR-0011). An agent
 * has a shell and `Bash` is not checked against the boundary (`docs/running-agents.md`), so a
 * convenient `site add` was a convenient way for one to grant itself a folder. Now adding a project
 * widens the boundary only with an approval on the owner's phone — or, without a phone, by hand with
 * the daemon stopped, which is what `add` and `rm` explain instead of doing.
 *
 * One thing `add` still does: an installation that never had the sessions module switched on gets
 * it switched on, with a confirmation and a restart, as it always did — otherwise there is no app to
 * add a project from. An `enabled: false` somebody wrote is left alone.
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { moduleStateDir, statePaths } from '@factotum/kernel'
import type { Environment } from '@factotum/core'
import { readRegistry, registryFile } from '@factotum/modules'
import { enableSessions, listSites, sessionsState } from './site.ts'
import { restartDaemon } from './restart.ts'
import { labelFor } from './supervise.ts'
import { execRunner, type Runner } from './tailscale.ts'

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
      out('usage: factotum site <list|add|rm> [...]')
      out('')
      out('  factotum site list [--json]          the projects the daemon has, from its registry')
      out('  factotum site add <path> [--id <id>]  how to add one: from the app, or by hand')
      out('  factotum site rm <id|path>            how to remove one')
      return 2
  }
}

function registryPath(deps: SiteCommandDeps): string {
  return registryFile(moduleStateDir(statePaths(deps.env, deps.home), 'sessions'))
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function runList(deps: SiteCommandDeps, out: (line: string) => void): Promise<number> {
  const file = registryPath(deps)
  const read = await readRegistry(file)
  if (read.kind === 'broken') {
    out(`the projects registry is broken, so the daemon loads no project: ${read.reason}`)
    out(`fix ${file} by hand with the daemon stopped, or delete it to seed it again from the config`)
    return 1
  }

  let projects: readonly { readonly id: string; readonly path: string; readonly name?: string | undefined }[]
  let shared: readonly string[]
  let source: 'registry' | 'config'
  if (read.kind === 'ok') {
    projects = read.registry.projects
    shared = read.registry.shared.map((s) => s.path)
    source = 'registry'
  } else {
    // No registry yet: the daemon seeds it from the config at its next start, so the config IS what
    // it will load.
    const loaded = await load(deps, out)
    if (loaded === undefined) return 1
    const fromConfig = listSites(loaded.config)
    projects = fromConfig.sites
    shared = fromConfig.sharedPaths
    source = 'config'
  }

  if (deps.argv.includes('--json')) {
    out(JSON.stringify({ source, file, sites: projects, sharedPaths: shared }))
    return 0
  }

  out(source === 'registry' ? `projects in ${file}` : `no ${file} yet: the daemon seeds it from the config at its next start`)
  if (projects.length === 0) out('no projects — an agent has nowhere it may write')
  for (const project of projects) {
    out(`  ${project.id.padEnd(16)} ${project.path}${project.name === undefined ? '' : `  (${project.name})`}`)
  }
  for (const path of shared) out(`  ${'(shared)'.padEnd(16)} ${path}`)
  if (read.kind === 'ok' && read.skipped.length > 0) {
    out('')
    for (const skipped of read.skipped) out(`  skipped ${skipped.list}[${skipped.index}]: ${skipped.reason}`)
  }
  if (shared.length > 0) {
    out('')
    out('  shared folders are writable from every project, and nothing locks them')
  }
  return 0
}

// ---------------------------------------------------------------------------
// add and rm: said, not done
// ---------------------------------------------------------------------------

async function runAdd(deps: SiteCommandDeps, rest: readonly string[], out: (line: string) => void): Promise<number> {
  const raw = rest.find((arg) => !arg.startsWith('--'))
  if (raw === undefined) {
    out('which folder? usage: factotum site add <path> [--id <id>]')
    return 2
  }
  // Resolved here: turning `.` into a path depends on where the command was run.
  const path = isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
  const id = flagValue(rest, '--id') ?? '<id>'

  const loaded = await load(deps, out)
  if (loaded === undefined) return 1

  const state = sessionsState(loaded.config)
  if (state === 'off') {
    out('the sessions module is switched off in the config (`enabled: false`), and this command does not')
    out('overrule that. Switch it on by hand if you want it.')
    out('')
  }
  if (state === 'absent' && !(await switchOn(deps, rest, loaded, out))) return 1

  await recipe(deps, out, 'add', {
    how: 'add it from the app (Projects)',
    edit: `add an entry to ${registryPath(deps)} (example below)`,
    example: JSON.stringify({ id, path }),
  })
  // Code 1 whatever happened above: THE PROJECT WAS NOT ADDED, and a script that asked for it must
  // be able to tell.
  return 1
}

async function runRemove(deps: SiteCommandDeps, rest: readonly string[], out: (line: string) => void): Promise<number> {
  const target = rest.find((arg) => !arg.startsWith('--'))
  if (target === undefined) {
    out('which one? usage: factotum site rm <id|path>')
    return 2
  }
  await recipe(deps, out, 'rm', {
    how: 'remove it from the app (Projects), which also deletes its history',
    edit: `delete its entry from ${registryPath(deps)}`,
    example: undefined,
  })
  return 1
}

/**
 * The way round without a phone, in the words that match how this environment runs — the same
 * three cases `restart.ts` tells apart. Never a command that does not exist.
 */
async function recipe(
  deps: SiteCommandDeps,
  out: (line: string) => void,
  action: 'add' | 'rm',
  words: { readonly how: string; readonly edit: string; readonly example: string | undefined },
): Promise<void> {
  const env = `--env ${deps.env}`
  const supervisor = await supervisorOf(deps)
  out(`factotum ${action} no longer edits projects: the daemon is the only thing that writes them.`)
  if (supervisor === 'launchagent') {
    out(`${capital(words.how)}. Without a phone: \`factotum uninstall ${env}\`, ${words.edit}, \`factotum install ${env}\`.`)
    out('`factotum install` rewrites the LaunchAgent with the PATH of the shell you run it from: run it')
    out('where `claude` is on the PATH, or the daemon comes back up unable to launch anything.')
  } else if (supervisor === 'foreground') {
    out(`${capital(words.how)}. Without a phone: stop \`factotum start ${env}\`, ${words.edit}, and start it again.`)
  } else {
    out(`${capital(words.how)}. Without a phone: stop the daemon (your supervisor's unit, or \`factotum start ${env}\`),`)
    out(`${words.edit}, and start it again.`)
  }
  out('Edits made while the daemon runs are ignored, and overwritten by its next write.')
  if (words.example !== undefined) {
    out('')
    out(`  ${words.example}`)
  }
}

async function supervisorOf(deps: SiteCommandDeps): Promise<'launchagent' | 'foreground' | 'other'> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'darwin') return 'other'
  const run = deps.run ?? execRunner
  const uid = deps.uid ?? process.getuid?.() ?? 0
  const loaded = await run('launchctl', ['print', `gui/${uid}/${labelFor(deps.env)}`])
  return loaded.code === 0 ? 'launchagent' : 'foreground'
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * An installation from before `init` switched the module on. Switching it on widens nothing by
 * itself — the registry is seeded from the sites ALREADY in the config — but it still asks, because
 * those sites become writable at the restart.
 */
async function switchOn(
  deps: SiteCommandDeps,
  rest: readonly string[],
  loaded: { path: string; config: unknown },
  out: (line: string) => void,
): Promise<boolean> {
  const edit = enableSessions(loaded.config)
  if (!edit.ok) {
    out(edit.error)
    return false
  }
  const sites = listSites(loaded.config).sites.length
  const question = `The sessions module is not on. Switch it on${sites === 0 ? '' : `, with the ${sites} site(s) already in the config`}?`
  if (!(await confirmed(deps, rest, out, question))) return false
  await write(loaded.path, edit.config)
  out('switched the sessions module on, with "Free prompt"')
  if (rest.includes('--no-restart')) {
    out('not restarting: the daemon picks it up at its next start')
  } else {
    await restartDaemon({
      env: deps.env,
      out,
      ...(deps.run === undefined ? {} : { run: deps.run }),
      ...(deps.uid === undefined ? {} : { uid: deps.uid }),
      ...(deps.platform === undefined ? {} : { platform: deps.platform }),
    })
  }
  out('')
  return true
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

/** Written beside the target and renamed: a crash mid-write must not leave half a config. */
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
    // No terminal and no `--yes` means nobody consented. Assuming yes here is how a script — or an
    // agent — ends up switching the module on without anyone deciding to.
    out('refusing to switch the sessions module on without a confirmation: pass --yes')
    return false
  }
  const answer = (await deps.ask(`${question} [y/N] `)).trim().toLowerCase()
  if (answer === 'y' || answer === 'yes') return true
  out('left alone. Nothing was written.')
  return false
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at === -1 ? undefined : argv[at + 1]
}
