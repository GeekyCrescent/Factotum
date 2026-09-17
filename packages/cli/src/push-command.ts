/**
 * `factotum push reset` — forget every subscribed device on this machine.
 *
 * THE WAY OUT OF A FULL CAP. The subscription route has no credential, so anything on this
 * machine can fill the list to its maximum with devices that are not yours — endpoints that
 * answer 2xx for ever, so the automatic removal on 404/410 never clears them. Without this, a
 * full list is permanent.
 *
 * IT REFUSES WHILE THE DAEMON RUNS, and that is the design rather than a limitation. The daemon
 * holds the list in memory and writes it whole on its next change: clearing the file under a
 * running daemon is undone by the next device that subscribes. So this stops and names the
 * commands that already exist, instead of reporting "done" about something that will not stay
 * done — restart.ts's rule: it NEVER pretends.
 *
 * An agent can run it too, through `Bash`. That fails towards the safe side: with no devices,
 * the permission gate cannot ask and goes back to denying (spec criterion 13).
 */

import { readFile } from 'node:fs/promises'
import { rootConfigSchema, type Environment } from '@factotum/core'
import { localUrl, resetSubscriptions, resolveListen, statePaths } from '@factotum/kernel'

export interface PushCommandDeps {
  readonly env: Environment
  readonly argv: readonly string[]
  readonly home?: string
  readonly out?: (line: string) => void
  /** Injected so tests do not need a daemon, or the absence of one, on a real port. */
  readonly fetch?: typeof globalThis.fetch
}

const USAGE = [
  'usage: factotum push reset [--env dev|prod]',
  '',
  '  reset   forget every device subscribed to notifications on this machine.',
  '          The daemon for that environment must be stopped first.',
]

/** Same bound as doctor's liveness probe (doctor.ts): it is asking the same question. */
const PROBE_TIMEOUT_MS = 2_000

export async function pushCommand(deps: PushCommandDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line))
  const [action] = deps.argv

  if (action !== 'reset') {
    for (const line of USAGE) out(line)
    return 2
  }

  const paths = statePaths(deps.env, deps.home)
  const running = await runningAt(paths.config, deps.fetch ?? globalThis.fetch)

  if (running !== undefined) {
    out(`the ${deps.env} daemon is running at ${running}.`)
    out('It holds the subscriptions in memory and would write them back, so nothing was changed.')
    out('Stop it, reset, and start it again:')
    out(`  factotum uninstall --env ${deps.env}   (or stop \`factotum start\` if you run it by hand)`)
    out(`  factotum push reset --env ${deps.env}`)
    out(`  factotum install --env ${deps.env}`)
    return 1
  }

  const had = await resetSubscriptions(paths.push)
  out(`forgot ${had} subscribed device${had === 1 ? '' : 's'} for ${deps.env}.`)
  if (had > 0) out('Subscribe again from each device you use: open the app and turn notifications on.')
  return 0
}

/**
 * Where the daemon answers, or `undefined` if it does not.
 *
 * No config means no daemon. An address no interface holds means nothing can be listening on
 * it — the same reasoning `doctor` applies before probing.
 */
async function runningAt(configPath: string, doFetch: typeof globalThis.fetch): Promise<string | undefined> {
  let url: string
  try {
    const parsed = rootConfigSchema.safeParse(JSON.parse(await readFile(configPath, 'utf8')))
    if (!parsed.success) return undefined
    const listen = resolveListen(parsed.data.listen)
    url = localUrl(listen.address, listen.port)
  } catch {
    return undefined
  }

  try {
    await doFetch(`${url}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return url
  } catch {
    return undefined
  }
}
