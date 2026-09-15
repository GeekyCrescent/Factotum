/**
 * `factotum init` — the first five minutes of someone who has never seen this.
 *
 * It used to answer "which address should this listen on", by detecting one. It no
 * longer asks that question at all: the daemon binds to loopback and `tailscale
 * serve` puts TLS in front, so the bind is a constant and the thing that varies is
 * the PUBLIC NAME, which only Tailscale can tell us.
 *
 * IT NEVER WRITES A CONFIG THAT `factotum start` WOULD REJECT. That is not a nicety:
 * `init` is the first command everyone runs, and a config that parses on disk but
 * fails validation at startup turns the first five minutes into a debugging session
 * about a file the user did not write.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { ensureStateRoots, localUrl, statePaths } from '@factotum/kernel'
import { rootConfigSchema, type Environment } from '@factotum/core'
import { execRunner, readFqdn, type Runner } from './tailscale.ts'
import { printQr } from './qr.ts'

const DEFAULT_PORTS: Readonly<Record<Environment, number>> = { prod: 7777, dev: 7778 }

/**
 * Loopback, always, and not a choice any more.
 *
 * This is the change that closes the door: before, any peer on the tailnet could
 * reach the daemon directly with `curl`, and the origin policy was the only thing in
 * the way — which defends against someone else's browser, not against someone with a
 * shell. Binding here reduces "who can reach it" to processes on this machine, which
 * is also exactly what the permission hook needs.
 */
const BIND_ADDRESS = '127.0.0.1'

export interface InitDeps {
  readonly env: Environment
  readonly home?: string
  /** `undefined` in a non-interactive run, where a prompt would hang forever. */
  readonly ask?: (question: string) => Promise<string>
  readonly out?: (line: string) => void
  /**
   * Injected so the tests do not require Tailscale to be installed. There is no
   * default-to-the-real-thing here on purpose: an optional dependency with a live
   * implementation behind it is the trap injection exists to avoid, so the tests
   * that care pass a fake and the binary only passes the real one.
   */
  readonly run?: Runner
}

export async function init(deps: InitDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line))
  const run = deps.run ?? execRunner
  const paths = statePaths(deps.env, deps.home)
  const port = DEFAULT_PORTS[deps.env]

  const existing = await readExisting(paths.config)
  if (existing !== undefined) {
    out(`A config already exists at ${paths.config}:`)
    out('')
    out(existing.replace(/^/gm, '    '))
    out('')
    const answer = await confirm(deps, 'Replace it? Nothing is deleted until you say yes. [y/N] ')
    if (!answer) {
      out('Left alone. Nothing was written.')
      return 0
    }
  }

  const publicOrigin = await resolvePublicOrigin(deps.env, port, run)
  if (publicOrigin === undefined) {
    explainMissingTailscale(out)
    // Deliberately writing NOTHING, exactly as the old "no private address" branch
    // did: a config that starts but cannot be reached is worse than a clear refusal,
    // and a config that does not start at all is worse still.
    return 1
  }

  const config = {
    environment: deps.env,
    listen: { address: BIND_ADDRESS, port },
    publicOrigin,
    // Turned on so the walk-through ends with something on the screen. Everything
    // else defaults to off.
    modules: { example: { enabled: true } },
  }

  // VALIDATED WITH THE REAL SCHEMA BEFORE IT TOUCHES THE DISK. Re-implementing the
  // canonical-origin rule here would be a second copy of it, and the copy that
  // drifts is the one that decides what gets written.
  const checked = rootConfigSchema.safeParse(config)
  if (!checked.success) {
    const issue = checked.error.issues[0]
    out('factotum worked out a config that it will not write, because it would not start:')
    out('')
    out(`    ${issue?.path.join('.') ?? '?'}: ${issue?.message ?? ''}`)
    out(`    value: ${JSON.stringify(publicOrigin)}`)
    out('')
    out('This is a bug — please open an issue with the two lines above.')
    return 1
  }

  await mkdir(paths.root, { recursive: true })
  await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await ensureStateRoots(paths)

  out('')
  out(`Wrote ${paths.config}`)
  out(`  listening on ${BIND_ADDRESS}:${port} — loopback only`)
  out(`  reachable at ${publicOrigin}`)
  out('')
  out(`Start it with:  factotum start${deps.env === 'prod' ? '' : ` --env ${deps.env}`}`)

  if (deps.env === 'dev') {
    await reportDev(publicOrigin, out)
    return 0
  }

  await reportProd(publicOrigin, port, out)
  return 0
}

/**
 * Where the client will be served from.
 *
 * In `prod` that is the MagicDNS name, because that is what `tailscale serve` holds
 * a certificate for.
 *
 * In `dev` it is the LOCAL origin, and that is a decision rather than a shortcut. A
 * machine has exactly one `Self.DNSName` and `serve` puts 443 in front of exactly one
 * backend, but dev and prod are built to run at the same time on different ports — so
 * composing `https://<fqdn>` for dev would write a `publicOrigin` pointing at the
 * PROD daemon. Every dev request would then arrive with an origin dev does not
 * accept, and `doctor` would report a serve mismatch for ever. dev does not get a
 * secure context, and saying so is better than half-providing one: the secure context
 * is for the phone, and the phone talks to prod.
 */
async function resolvePublicOrigin(
  env: Environment,
  port: number,
  run: Runner,
): Promise<string | undefined> {
  if (env === 'dev') return localUrl(BIND_ADDRESS, port)

  const fqdn = await readFqdn(run)
  if (fqdn === undefined) return undefined
  return `https://${fqdn}`
}

function explainMissingTailscale(out: (line: string) => void): void {
  out('Could not read this machine\'s Tailscale name.')
  out('')
  out('factotum is reached over HTTPS on a `*.ts.net` name, with `tailscale serve`')
  out('terminating TLS in front of it. Without that name there is no config to write.')
  out('')
  out('  1. install and sign in:  https://tailscale.com/download   then `tailscale up`')
  out('  2. make sure MagicDNS and HTTPS are enabled for your tailnet')
  out('  3. check it answers:     tailscale status --json')
  out('')
  out('Then run `factotum init` again.')
}

async function reportProd(
  publicOrigin: string,
  port: number,
  out: (line: string) => void,
): Promise<void> {
  out(`Then open:      ${publicOrigin}`)
  out('')
  out('One more step, because factotum does not do this for you:')
  out('')
  out(`    tailscale serve --bg --https=443 http://${BIND_ADDRESS}:${port}`)
  out('')
  await printQr(publicOrigin, out)
  out('')
  out('Scan that from your phone — it must be on the same tailnet.')
  out('If the page does not load, `tailscale serve status` is the thing to check.')
}

/**
 * No QR in dev, and that is the other half of the decision above. A QR carrying
 * `http://127.0.0.1:7778` opens nothing on a phone, and printing one under the words
 * "scan that from your phone" would be a small lie shipped to every dev run.
 */
async function reportDev(publicOrigin: string, out: (line: string) => void): Promise<void> {
  out(`Then open:      ${publicOrigin}`)
  out('')
  out('No QR for dev: that address is this machine, and means nothing on a phone.')
  out('dev has no secure context — the phone talks to prod.')
  await Promise.resolve()
}

async function readExisting(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

async function confirm(deps: InitDeps, question: string): Promise<boolean> {
  // No prompt available means no consent, so nothing is touched. Assuming yes here
  // would make the first impression "it silently replaced my config".
  if (deps.ask === undefined) return false
  const answer = await deps.ask(question)
  return /^y(es)?$/i.test(answer.trim())
}

/** Only built when stdin is a TTY; otherwise `ask` stays undefined and init is safe. */
export function terminalAsk(): ((question: string) => Promise<string>) | undefined {
  if (!process.stdin.isTTY) return undefined
  return async (question: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      return await rl.question(question)
    } finally {
      rl.close()
    }
  }
}
