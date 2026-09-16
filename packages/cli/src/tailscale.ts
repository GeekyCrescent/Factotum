/**
 * Reading what Tailscale is doing. THE KERNEL NEVER DOES THIS.
 *
 * `packages/kernel` knows nothing about Tailscale and must not learn: the daemon's
 * network surface is decided by the config, and a daemon that shells out to work out
 * its own identity is a daemon whose behaviour depends on what is installed. This
 * lives in the CLI, where it is diagnosis (`doctor`) and onboarding (`init`).
 */

import { execFile, type ExecFileException } from 'node:child_process'

export interface RunResult {
  readonly stdout: string
  /**
   * A number on a normal exit, a STRING when the spawn itself failed, and null when
   * the process died from a signal.
   *
   * The shape of the failure is the type, and it could not be deferred. Measured with
   * `promisify(execFile)` on this machine:
   *
   *   missing binary   code: 'ENOENT'   signal: undefined   killed: undefined
   *   exit 3           code: 3          signal: null        killed: false
   *   timeout          code: null       signal: 'SIGTERM'   killed: true
   *
   * `readServeStatus` has to tell "not serving" (a non-zero exit) from "Tailscale is
   * not installed" (ENOENT), because the first is something to fix and the second is
   * something to report as unknown. A `code: number` can represent neither.
   */
  readonly code: number | string | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
}

export type Runner = (
  cmd: string,
  args: readonly string[],
  opts?: { readonly timeoutMs?: number },
) => Promise<RunResult>

/** The default timeout. `doctor` must never hang while tailscaled is starting. */
const RUN_TIMEOUT_MS = 5_000

/**
 * The real runner. Never throws: a failure is a RESULT, because every caller here
 * wants to report what happened rather than stop.
 */
export const execRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      [...args],
      { timeout: opts.timeoutMs ?? RUN_TIMEOUT_MS },
      (error: ExecFileException | null, stdout: string | Buffer) => {
        const text = typeof stdout === 'string' ? stdout : stdout.toString('utf8')
        if (error === null) {
          resolve({ stdout: text, code: 0, signal: null, timedOut: false })
          return
        }
        const signal = (error.signal ?? null) as NodeJS.Signals | null
        resolve({
          stdout: text,
          code: error.code ?? null,
          signal,
          // `killed` is what separates a timeout from a process that chose to die on
          // a signal. execFile sets it when it is the one doing the killing.
          timedOut: (error as { killed?: boolean }).killed === true && signal !== null,
        })
      },
    )
  })

export interface ServeStatus {
  readonly kind: 'serving' | 'not-serving' | 'unknown'
  /** The backend it proxies to, e.g. `http://127.0.0.1:7777`. */
  readonly target?: string
  /** The origin it is served ON, already canonical — see the `:443` note below. */
  readonly servedOrigin?: string
  readonly funnel: boolean
}

interface ServeStatusJson {
  readonly Web?: Record<string, { readonly Handlers?: Record<string, { readonly Proxy?: string }> }>
  readonly AllowFunnel?: Record<string, boolean>
}

/**
 * Turning a `<host>:<port>` key from the serve config into an origin that can be
 * COMPARED with `publicOrigin`.
 *
 * THE `:443` IS THE TRAP, and it is measured. The key always carries the port
 * explicitly:
 *
 *   "Web": { "juans-macbook-pro.tailbd0167.ts.net:443": { … } }
 *
 * but a canonical origin omits the default port, and `publicOrigin` is validated to
 * be canonical — so `https://${key}` would produce `https://host:443`, which can
 * never equal a valid `publicOrigin`. `doctor` would then report "serve is not
 * serving what the config says" on every correctly configured machine, for ever.
 * That is the same family of failure as the trailing dot: two strings that look the
 * same. Any other port is kept, because `serve --https=8443` is real — measured.
 */
function originFromKey(key: string): string | undefined {
  const at = key.lastIndexOf(':')
  if (at === -1) return undefined
  const host = key.slice(0, at)
  const port = key.slice(at + 1)
  if (host === '') return undefined
  return port === '443' ? `https://${host}` : `https://${host}:${port}`
}

export interface ServeHandler {
  readonly servedOrigin?: string
  readonly target?: string
  readonly funnel: boolean
}

export interface ServeHandlers {
  readonly kind: ServeStatus['kind']
  readonly handlers: readonly ServeHandler[]
}

/**
 * EVERY handler `serve` holds on this machine.
 *
 * A machine is not factotum's alone. The one this spec was built on had another
 * service on 443 and factotum on 8443, and reading only the first entry made `doctor`
 * look at the other service. Worse, it is exactly the situation where a printed
 * `serve --https=443` REPLACES someone else's handler — so `init` needs the full list
 * to avoid suggesting it.
 */
export async function readServeHandlers(run: Runner): Promise<ServeHandlers> {
  const result = await run('tailscale', ['serve', 'status', '--json'])

  // ENOENT is a string code: Tailscale is not installed, which is not the same as
  // being installed and not serving. Saying "unknown" is the honest answer, and
  // `doctor` reports it rather than treating it as a misconfiguration.
  if (typeof result.code === 'string' || result.timedOut) {
    return { kind: 'unknown', handlers: [] }
  }
  if (result.code !== 0) {
    return { kind: 'not-serving', handlers: [] }
  }

  let parsed: ServeStatusJson
  try {
    parsed = JSON.parse(result.stdout) as ServeStatusJson
  } catch {
    return { kind: 'unknown', handlers: [] }
  }

  // An empty object is what `tailscale serve status --json` prints with nothing
  // configured. Measured, after `tailscale funnel --https=443 off` wiped the config.
  const handlers = Object.entries(parsed.Web ?? {}).map(([key, value]): ServeHandler => {
    const servedOrigin = originFromKey(key)
    const target = value.Handlers?.['/']?.Proxy
    return {
      // Funnel is read FOR THIS KEY, not as "does AllowFunnel exist": a node can have
      // Funnel on 8443 and not on 443, and a warning that fires for the wrong port is
      // a warning that gets ignored.
      funnel: parsed.AllowFunnel?.[key] === true,
      ...(target !== undefined ? { target } : {}),
      ...(servedOrigin !== undefined ? { servedOrigin } : {}),
    }
  })

  return { kind: handlers.length === 0 ? 'not-serving' : 'serving', handlers }
}

/**
 * The handler for `wanted` if there is one, otherwise the first — which is then, by
 * construction, a handler for something else, and `doctor` names it as a mismatch.
 */
export async function readServeStatus(run: Runner, wanted?: string): Promise<ServeStatus> {
  const { kind, handlers } = await readServeHandlers(run)
  const chosen = handlers.find((h) => h.servedOrigin === wanted) ?? handlers[0]
  if (chosen === undefined) return { kind, funnel: false }
  return { kind, ...chosen }
}

/** The HTTPS port an origin is served on, with the implicit 443 made explicit. */
export function httpsPort(origin: string): number {
  const { port } = new URL(origin)
  return port === '' ? 443 : Number(port)
}

/** The command that puts TLS for `publicOrigin` in front of the bind. Port from the ORIGIN. */
export function serveCommand(publicOrigin: string, bindOrigin: string): string {
  return `tailscale serve --bg --https=${httpsPort(publicOrigin)} ${bindOrigin}`
}

/** Whether a serve proxy target is this bind. Compared as origins: `serve` may add a slash. */
export function sameBackend(target: string | undefined, bindOrigin: string): boolean {
  if (target === undefined) return false
  try {
    return new URL(target).origin === new URL(bindOrigin).origin
  } catch {
    return target === bindOrigin
  }
}

interface StatusJson {
  readonly Self?: { readonly DNSName?: string }
}

/**
 * The MagicDNS name of this machine, ALREADY WITHOUT the trailing dot.
 *
 * Normalising here, at the single point the value enters the program, is the first
 * half of the trailing-dot defence; the schema's guard is the second. `Self.DNSName`
 * comes back fully qualified — measured on a real tailnet as
 * 'juans-macbook-pro.tailbd0167.ts.net.' — and that dot is invisible in every log
 * line it ever appears in.
 *
 * `CertDomains[0]` happens to carry the same name already trimmed, and is
 * deliberately not used: a source that "arrives clean" is an assumption that rots
 * silently, where an explicit strip is one line with a test on it.
 */
export async function readFqdn(run: Runner): Promise<string | undefined> {
  const result = await run('tailscale', ['status', '--json'])
  if (result.code !== 0 || result.timedOut) return undefined

  let parsed: StatusJson
  try {
    parsed = JSON.parse(result.stdout) as StatusJson
  } catch {
    return undefined
  }

  const raw = parsed.Self?.DNSName
  if (raw === undefined || raw === '') return undefined

  const fqdn = raw.replace(/\.+$/, '')
  return fqdn === '' ? undefined : fqdn
}
