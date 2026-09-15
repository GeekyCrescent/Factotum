/**
 * `factotum doctor` — the first thing to ask for when someone reports a problem.
 *
 * It never starts a daemon. But if one is already running for this environment it
 * asks it which modules ended up disabled, because that state exists only in the
 * live process: persisting it to a file so doctor could read it would create a
 * second source of truth that goes stale the moment the daemon restarts.
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { version as nodeVersion } from 'node:process'
import {
  describePolicy,
  localUrl,
  policyFor,
  statePaths,
  type StatePaths,
} from '@factotum/kernel'
import { ENVIRONMENTS, rootConfigSchema, type Environment } from '@factotum/core'

const run = promisify(execFile)

export interface DoctorDeps {
  readonly home?: string
  readonly out?: (line: string) => void
  readonly fetch?: typeof globalThis.fetch
}

export async function doctor(deps: DoctorDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line))
  const doFetch = deps.fetch ?? globalThis.fetch

  out(`node          ${nodeVersion}`)
  out(`claude CLI    ${await claudeStatus()}`)
  out('')

  for (const env of ENVIRONMENTS) {
    await reportEnvironment(env, statePaths(env, deps.home), out, doFetch)
  }

  return 0
}

async function claudeStatus(): Promise<string> {
  try {
    const { stdout } = await run('claude', ['--version'], { timeout: 5_000 })
    return `${stdout.trim()}  (on PATH)`
  } catch {
    return 'NOT FOUND on PATH — factotum can configure itself without it, but it is the engine'
  }
}

async function reportEnvironment(
  env: Environment,
  paths: StatePaths,
  out: (line: string) => void,
  doFetch: typeof globalThis.fetch,
): Promise<void> {
  out(`[${env}]`)

  let raw: string
  try {
    raw = await readFile(paths.config, 'utf8')
  } catch {
    out(`  no config at ${paths.config} — run \`factotum init --env ${env}\``)
    out('')
    return
  }

  const parsed = rootConfigSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    out(`  config at ${paths.config} does not validate: ${parsed.error.issues[0]?.message ?? ''}`)
    out('')
    return
  }

  const { listen, modules, publicOrigin } = parsed.data
  const address = listen.address ?? `(from interface ${listen.interface ?? '?'})`
  out(`  config      ${paths.config}`)
  out(`  listen      ${address}:${listen.port}`)

  const enabled = Object.entries(modules).filter(([, entry]) => entry.enabled).map(([id]) => id)
  out(`  enabled     ${enabled.length === 0 ? '(none)' : enabled.join(', ')}`)

  out(`  public      ${publicOrigin}`)

  if (listen.address !== undefined) {
    // `policyFor`, never a local copy of the isLoopback rule: doctor printing a
    // rescue route that `boot` leaves undefined is doctor lying about the daemon.
    const policy = policyFor({
      publicOrigin,
      address: listen.address,
      port: listen.port,
      extraOrigins: listen.extraOrigins,
    })
    out('  origins     ' + describePolicy(policy).join('\n              '))
    await reportLive(localUrl(listen.address, listen.port), out, doFetch)
  }

  out('')
}

async function reportLive(
  url: string,
  out: (line: string) => void,
  doFetch: typeof globalThis.fetch,
): Promise<void> {
  try {
    const response = await doFetch(`${url}/modules`, { signal: AbortSignal.timeout(2_000) })
    const body = (await response.json()) as {
      modules: { id: string; status: { kind: string; reason?: string } }[]
    }
    const broken = body.modules.filter((m) => m.status.kind === 'disabled')
    out(`  daemon      running at ${url}`)
    if (broken.length === 0) {
      out('  disabled    none')
      return
    }
    for (const module of broken) out(`  DISABLED    ${module.id}: ${module.status.reason ?? ''}`)
  } catch {
    out(`  daemon      not running (so which modules are disabled cannot be known)`)
  }
}
