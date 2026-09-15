/**
 * `factotum init` — the first five minutes of someone who has never seen this.
 *
 * It answers one question the user cannot answer alone (which address) and then gets
 * out of the way. It never writes a config it has not explained, and it never
 * overwrites one without asking.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { ensureStateRoots, localUrl, statePaths } from '@factotum/kernel'
import type { Environment } from '@factotum/core'
import { detect, type Found } from './detect.ts'
import { printQr } from './qr.ts'

const DEFAULT_PORTS: Readonly<Record<Environment, number>> = { prod: 7777, dev: 7778 }

export interface InitDeps {
  readonly env: Environment
  readonly home?: string
  readonly interfaces?: Parameters<typeof detect>[0]
  /** `undefined` in a non-interactive run, where a prompt would hang forever. */
  readonly ask?: (question: string) => Promise<string>
  readonly out?: (line: string) => void
}

export async function init(deps: InitDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line))
  const paths = statePaths(deps.env, deps.home)

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

  const candidates = detect(deps.interfaces)
  if (candidates.length === 0) {
    out('No private network address on this machine.')
    out('')
    out('factotum listens on a private network and has no password, so it refuses to')
    out('start without one. The documented path is Tailscale:')
    out('')
    out('    https://tailscale.com/download   then `tailscale up`')
    out('')
    out('Then run `factotum init` again. (A LAN address works too, but only from that LAN.)')
    // Deliberately NOT falling back to loopback: a config that starts but cannot be
    // reached from a phone is a worse outcome than a clear refusal.
    return 1
  }

  const chosen = await choose(deps, candidates, out)

  const config = {
    environment: deps.env,
    listen: { address: chosen.address, port: DEFAULT_PORTS[deps.env] },
    // Turned on so the walk-through ends with something on the screen. Everything
    // else defaults to off.
    modules: { example: { enabled: true } },
  }

  await mkdir(paths.root, { recursive: true })
  await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await ensureStateRoots(paths)

  const url = localUrl(chosen.address, config.listen.port)

  out('')
  out(`Wrote ${paths.config}`)
  out(`  listening on ${chosen.address}:${config.listen.port} (${chosen.iface})`)
  out('')
  out(`Start it with:  factotum start${deps.env === 'prod' ? '' : ` --env ${deps.env}`}`)
  out(`Then open:      ${url}`)
  out('')
  await printQr(url, out)
  out('')
  out('Scan that from your phone — it must be on the same tailnet.')
  out('If the page does not load, the address above is reachable from this machine')
  out('but not from your phone, which is the one thing factotum cannot check for you.')

  return 0
}

async function readExisting(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

async function choose(
  deps: InitDeps,
  candidates: readonly Found[],
  out: (line: string) => void,
): Promise<Found> {
  const [first] = candidates as [Found, ...Found[]]

  if (candidates.length === 1 || deps.ask === undefined) {
    out(`Using ${first.address} on ${first.iface}${first.tailscale ? ' (Tailscale)' : ''}.`)
    return first
  }

  out('More than one private address on this machine:')
  candidates.forEach((found, index) => {
    out(`  ${index + 1}) ${found.address}  ${found.iface}${found.tailscale ? '  (Tailscale)' : ''}`)
  })
  const answer = await deps.ask(`Which one? [1-${candidates.length}, default 1] `)
  const picked = Number.parseInt(answer.trim(), 10)
  return candidates[Number.isNaN(picked) ? 0 : picked - 1] ?? first
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
