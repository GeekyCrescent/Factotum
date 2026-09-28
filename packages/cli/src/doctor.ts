/**
 * `factotum doctor` — the first thing to ask for when someone reports a problem.
 *
 * It never starts a daemon. But if one is already running for this environment it
 * asks it which modules ended up disabled, because that state exists only in the
 * live process: persisting it to a file so doctor could read it would create a
 * second source of truth that goes stale the moment the daemon restarts.
 *
 * DOCTOR NEVER THROWS. Every external thing it touches — the config file, the
 * `tailscale` binary, the network interfaces, the daemon itself — is reported on
 * rather than relied upon. A diagnostic tool that crashes on the broken machine is
 * the one place a crash is least affordable.
 */

import { readFile } from 'node:fs/promises'
import { version as nodeVersion } from 'node:process'
import {
  BootError,
  describePolicy,
  inspectPush,
  localUrl,
  MAX_SUBSCRIPTIONS,
  policyFor,
  resolveListen,
  statePaths,
  type Interfaces,
  type StatePaths,
} from '@factotum/kernel'
import { ENVIRONMENTS, rootConfigSchema, type Environment } from '@factotum/core'
import {
  execRunner,
  httpsPort,
  readServeStatus,
  sameBackend,
  serveCommand,
  type Runner,
} from './tailscale.ts'

export interface DoctorDeps {
  readonly home?: string
  readonly out?: (line: string) => void
  readonly fetch?: typeof globalThis.fetch
  /** Injected so tests do not require `tailscale` or `claude` to be installed. */
  readonly run?: Runner
  /** Injected so the `listen.interface` case does not depend on the test machine. */
  readonly interfaces?: Interfaces
}

export async function doctor(deps: DoctorDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line))
  const doFetch = deps.fetch ?? globalThis.fetch
  const run = deps.run ?? execRunner

  out(`node          ${nodeVersion}`)
  out(`claude CLI    ${await claudeStatus(run)}`)
  out('')

  for (const env of ENVIRONMENTS) {
    await reportEnvironment(env, statePaths(env, deps.home), out, doFetch, run, deps.interfaces)
  }

  return 0
}

/**
 * Uses the injected runner like everything else here. It used to hold its own
 * module-level `promisify(execFile)`, which returns `{ stdout, stderr }` and is not
 * the same shape — so leaving it would have meant `doctor.test.ts` still required
 * `claude` on the PATH, and the coverage criterion would not have been reachable
 * deterministically on any machine.
 */
async function claudeStatus(run: Runner): Promise<string> {
  const result = await run('claude', ['--version'])
  if (result.code === 0) return `${result.stdout.trim()}  (on PATH)`
  return 'NOT FOUND on PATH — factotum can configure itself without it, but it is the engine'
}

async function reportEnvironment(
  env: Environment,
  paths: StatePaths,
  out: (line: string) => void,
  doFetch: typeof globalThis.fetch,
  run: Runner,
  interfaces: Interfaces | undefined,
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

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    out(`  config at ${paths.config} is not valid JSON: ${(error as Error).message}`)
    out('')
    return
  }

  const parsed = rootConfigSchema.safeParse(json)
  if (!parsed.success) {
    // THE PATH, not just the message. This spec invalidates every config written
    // before it, so the common failure is a missing `publicOrigin` — and zod's
    // message for that is "Invalid input", which names nothing. Measured: the issue
    // arrives as { path: ['publicOrigin'], … }.
    const issue = parsed.error.issues[0]
    const where = issue?.path.join('.') ?? ''
    const at = where === '' ? '' : ` at \`${where}\``
    out(`  config at ${paths.config} does not validate${at}: ${issue?.message ?? ''}`)
    out('')
    return
  }

  const { listen, modules, publicOrigin } = parsed.data
  out(`  config      ${paths.config}`)
  out(`  public      ${publicOrigin}`)

  const enabled = Object.entries(modules).filter(([, entry]) => entry.enabled).map(([id]) => id)
  out(`  enabled     ${enabled.length === 0 ? '(none)' : enabled.join(', ')}`)

  // Resolve the bind the same way `boot` does, including the `listen.interface`
  // case, which doctor used to skip entirely. `resolveListen` THROWS a BootError —
  // for an address no interface has, as well as for an unknown interface — and that
  // is exactly the situation where a diagnosis is most wanted, so it is caught.
  let resolved: { address: string; port: number } | undefined
  try {
    const r = resolveListen(listen, interfaces)
    resolved = { address: r.address, port: r.port }
    out(`  listen      ${r.address}:${r.port}${r.from.kind === 'interface' ? ` (via ${r.from.name})` : ''}`)
  } catch (error) {
    const declared = listen.address ?? `interface ${listen.interface ?? '?'}`
    out(`  listen      ${declared}:${listen.port} — CANNOT RESOLVE`)
    out(`              ${error instanceof BootError ? error.message : String(error)}`)
  }

  if (resolved === undefined) {
    // Without a resolved bind there is no honest rescue route to print, and nothing
    // can be listening on an address no interface holds, so probing would only buy
    // a timeout. The public origin is still worth showing.
    out(`  origins     ${publicOrigin} (publicOrigin)`)
    out('')
    return
  }

  const policy = policyFor({
    publicOrigin,
    address: resolved.address,
    port: resolved.port,
    extraOrigins: listen.extraOrigins,
  })
  out('  origins     ' + describePolicy(policy).join('\n              '))

  await reportServe(env, publicOrigin, localUrl(resolved.address, resolved.port), out, run)
  await reportLive(localUrl(resolved.address, resolved.port), out, doFetch)
  await reportPush(publicOrigin, paths, out)

  out('')
}

/**
 * Whether `tailscale serve` is putting TLS in front of THIS daemon.
 *
 * NOT CHECKED IN `dev`, and that is a decision rather than an omission. A machine has
 * one MagicDNS name and `serve` puts 443 in front of one backend, so the secure
 * context belongs to prod — dev's `publicOrigin` is its own loopback origin. Since
 * this function walks both environments, checking dev would report "serve is not
 * serving what the config says" on every run, for ever. A warning that is always
 * wrong is a warning that gets ignored, which is the failure this is avoiding.
 */
async function reportServe(
  env: Environment,
  publicOrigin: string,
  bindOrigin: string,
  out: (line: string) => void,
  run: Runner,
): Promise<void> {
  if (env === 'dev') {
    out('  serve       not checked in dev — the secure context is prod\'s')
    return
  }

  const status = await readServeStatus(run, publicOrigin)
  // The command must point at the BIND, not at the public origin. Composing it by
  // rewriting publicOrigin's scheme produced `http://127.0.0.1:<hostname>`, which
  // compiled, passed the test that only looked for "NOT SERVING", and would have
  // failed the moment anyone pasted it. Found by running doctor, not by reading it.
  const command = serveCommand(publicOrigin, bindOrigin)

  if (status.kind === 'unknown') {
    out('  serve       UNKNOWN — the `tailscale` command did not answer')
    out('              factotum still runs; the client is reachable at the bind above')
    return
  }
  if (status.kind === 'not-serving') {
    out('  serve       NOT SERVING — nothing is terminating TLS in front of factotum')
    out(`              ${command}`)
    return
  }

  if (status.servedOrigin !== publicOrigin) {
    // The mismatch worth naming: both strings are printed, because this is the
    // family of failure where they look the same and are not. publicOrigin's port
    // holds no handler (it would have been chosen), so the command replaces nothing.
    out(`  serve       MISMATCH — serving ${status.servedOrigin ?? '(nothing)'}`)
    out(`              but publicOrigin is ${publicOrigin}`)
    out(`              ${command}`)
  } else if (!sameBackend(status.target, bindOrigin)) {
    // publicOrigin IS served — by something that is not this daemon. Printing the
    // command here is how another service on this machine lost its 443: pasting it
    // replaces that handler. So no command, and the way out instead.
    out(`  serve       TAKEN — ${publicOrigin} -> ${status.target ?? '?'}, not this daemon (${bindOrigin})`)
    out(`              running serve on port ${httpsPort(publicOrigin)} would REPLACE that handler.`)
    out(`              give factotum a free port instead, e.g. publicOrigin https://${new URL(publicOrigin).hostname}:8443`)
  } else {
    out(`  serve       serving ${status.servedOrigin} -> ${status.target ?? '?'}`)
  }

  out(`  funnel      ${status.funnel ? 'ON — THIS DAEMON IS EXPOSED TO THE INTERNET' : 'off'}`)
  if (status.funnel) {
    out('              the origin policy stops another browser, not `curl`.')
    out(`              turn it off with: tailscale funnel --https=${httpsPort(publicOrigin)} off`)
    // Measured: `funnel … off` leaves `{}` — not just factotum's handler, all of them.
    out('              NOTE: that also removes the whole serve config —')
    out('              every serve handler on this machine, other services included.')
    out('              Save `tailscale serve status --json` first, and re-add each one after.')
  }
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

/** The same sentence as the client's Device page: a pending keeps its token on the device (ADR-0010). */
const SAME_MACHINE_WARNING =
  'A browser on this machine should not subscribe: pending approvals are kept on the device, and an agent here can read them.'

/**
 * Three states, and the middle one is NOT a problem: keys and no devices is how every machine
 * looks before the app is opened on a phone. Saying it as a warning would teach the owner to
 * ignore this line.
 *
 * READ-ONLY. `inspectPush` creates nothing — a diagnostic that generated a key pair would change
 * the thing it reports on. And it prints a count, never a key or an endpoint (criterion 3).
 */
async function reportPush(publicOrigin: string, paths: StatePaths, out: (line: string) => void): Promise<void> {
  if (!publicOrigin.startsWith('https:')) {
    out('  push        unavailable: no secure context here, so no browser can subscribe')
    return
  }

  const inspection = await inspectPush(paths.push)
  switch (inspection.kind) {
    case 'no-keys':
      out('  push        not set up yet — the daemon creates a key pair on its next start')
      break
    case 'unusable':
      out(`  push        OFF — ${inspection.reason}`)
      break
    case 'ready': {
      const n = inspection.subscriptions
      out(
        n === 0
          ? '  push        ready, no devices subscribed — open the app on a phone and turn notifications on'
          : `  push        ready, ${n} device${n === 1 ? '' : 's'} subscribed (at most ${MAX_SUBSCRIPTIONS})`,
      )
      if (n > 0 && inspection.sameMachine > 0) {
        out(`              ${inspection.sameMachine === 1 ? 'one of them is this machine' : `${inspection.sameMachine} of them are this machine`}`)
      }
      // ALWAYS with devices (spec 2026-09-18, design D12): the detection cannot see every case.
      if (n > 0) out(`              ${SAME_MACHINE_WARNING}`)
      if (inspection.warning !== undefined) out(`              ${inspection.warning}`)
      break
    }
  }
}
