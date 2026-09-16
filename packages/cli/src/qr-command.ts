/**
 * `factotum qr` — the QR again, without rewriting anything.
 *
 * It existed only inside `init`, which is the command that REPLACES your config. So
 * the way to see the code again was to run the one command that could lose the sites
 * you had declared by hand. It reads; it never writes.
 */

import { readFile } from 'node:fs/promises'
import { statePaths } from '@factotum/kernel'
import { rootConfigSchema, type Environment } from '@factotum/core'
import { printQr } from './qr.ts'

export interface QrDeps {
  readonly env: Environment
  readonly home?: string
  readonly out?: (line: string) => void
}

export async function qrCommand(deps: QrDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line))
  const path = statePaths(deps.env, deps.home).config

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    out(`no config at ${path} — run \`factotum init --env ${deps.env}\` first`)
    return 1
  }

  const parsed = rootConfigSchema.safeParse(JSON.parse(raw) as unknown)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    out(`the config at ${path} does not validate at \`${issue?.path.join('.') ?? '?'}\`: ${issue?.message ?? ''}`)
    return 1
  }

  const { publicOrigin } = parsed.data
  out(publicOrigin)
  out('')

  // In dev the public origin IS the loopback bind, and a QR of it opens nothing on a
  // phone — the same reason `init --env dev` prints none. Saying so beats a code that
  // scans into a dead address.
  if (deps.env === 'dev') {
    out('no QR for dev: that address is this machine, and means nothing on a phone.')
    return 0
  }

  await printQr(publicOrigin, out)
  out('')
  out('Scan that from your phone — it must be on the same tailnet.')
  return 0
}
