/**
 * The VAPID pair: the daemon's identity as a sender of Web Push.
 *
 * TWO RULES, AND BOTH ARE ABOUT NOT LOSING THINGS IN SILENCE.
 *
 * 1. NEVER REGENERATE OVER AN EXISTING FILE. A push service binds every subscription to the
 *    public key it was created with; a new pair answers 403 to all of them (measured
 *    against FCM, spec A6). Nothing tells the owner — the phone just goes quiet. So a key
 *    file that cannot be read DEGRADES with a reason and is left exactly as it was, and
 *    creation uses an exclusive `link`, which fails if the file appeared in between rather
 *    than replacing it. The guarantee is the primitive, not a check before the write.
 *
 * 2. NEVER THROW. Push is a capability, not the network surface (ADR-0004): an unreadable
 *    key file costs the owner notifications, not the daemon.
 *
 * Created by `boot()` on first start, and not only by `init`: `init` refuses to run over an
 * existing config unless the owner agrees to replace it, so an installation that predates
 * this code would otherwise never get a pair (spec §0.31).
 */

import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import webpush from 'web-push'

export const KEYS_FILE = 'keys.json'

export interface VapidKeys {
  /** base64url, uncompressed P-256 point: 65 bytes → 87 characters. */
  readonly publicKey: string
  /** base64url, P-256 scalar: 32 bytes → 43 characters. */
  readonly privateKey: string
}

export type KeysResult =
  | { readonly kind: 'ready'; readonly keys: VapidKeys; readonly created: boolean }
  /** Push is off. The reason names the file and the remedy; it never carries a key. */
  | { readonly kind: 'unavailable'; readonly reason: string }

export interface KeysDeps {
  /** `statePaths(...).push`. */
  readonly dir: string
  /** Injected so a test never depends on randomness. Defaults to the library that signs. */
  readonly generate?: () => VapidKeys
}

/** Owner-only: the private key is a secret, and nobody else on the machine needs it. */
const KEY_FILE_MODE = 0o600

/**
 * The lengths are the shape check, and they are not arbitrary: they are what an uncompressed
 * P-256 public point and a P-256 scalar encode to in base64url without padding. The library
 * produces exactly these (spec A7). A file that holds anything else was not written by us.
 */
const PUBLIC_KEY_LENGTH = 87
const PRIVATE_KEY_LENGTH = 43
const BASE64URL = /^[A-Za-z0-9_-]+$/

/**
 * READ-ONLY: what is on disk, without creating anything. For `doctor`, which must never have
 * a side effect — a diagnostic that generates a key pair would change the thing it reports on.
 */
export async function inspectKeys(dir: string): Promise<KeysResult | { readonly kind: 'missing' }> {
  return await load(join(dir, KEYS_FILE))
}

export async function loadOrCreateKeys(deps: KeysDeps): Promise<KeysResult> {
  const file = join(deps.dir, KEYS_FILE)

  const existing = await load(file)
  if (existing.kind !== 'missing') return existing

  return await create(file, deps)
}

async function load(file: string): Promise<KeysResult | { readonly kind: 'missing' }> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return unavailable(file, `it could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'})`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return unavailable(file, 'it is not valid JSON')
  }

  if (!isVapidKeys(parsed)) return unavailable(file, 'it does not hold a VAPID pair')
  return { kind: 'ready', keys: { publicKey: parsed.publicKey, privateKey: parsed.privateKey }, created: false }
}

async function create(file: string, deps: KeysDeps): Promise<KeysResult> {
  const generated = (deps.generate ?? defaultGenerate)()
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`

  try {
    await mkdir(deps.dir, { recursive: true })
    // `mode` here is subject to the umask, which can only REMOVE bits — so 0600 stays 0600.
    // Written whole to a temporary name first, so the real name never points at half a key.
    await writeFile(temporary, `${JSON.stringify(generated, null, 2)}\n`, { mode: KEY_FILE_MODE, flag: 'wx' })

    try {
      // ATOMIC AND EXCLUSIVE in one call: `link` refuses if the target exists. `rename` would
      // silently replace a pair another process created a moment ago — which is rule 1 broken
      // by a race instead of by a bug.
      await link(temporary, file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // Someone else won. Their pair is the pair.
      const theirs = await load(file)
      return theirs.kind === 'missing' ? unavailable(file, 'it vanished while being created') : theirs
    }

    return { kind: 'ready', keys: generated, created: true }
  } catch (error) {
    return unavailable(file, `it could not be created (${(error as NodeJS.ErrnoException).code ?? 'error'})`)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

function defaultGenerate(): VapidKeys {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys()
  return { publicKey, privateKey }
}

function isVapidKeys(value: unknown): value is VapidKeys {
  if (value === null || typeof value !== 'object') return false
  const { publicKey, privateKey } = value as Record<string, unknown>
  return (
    typeof publicKey === 'string' &&
    typeof privateKey === 'string' &&
    publicKey.length === PUBLIC_KEY_LENGTH &&
    privateKey.length === PRIVATE_KEY_LENGTH &&
    BASE64URL.test(publicKey) &&
    BASE64URL.test(privateKey)
  )
}

function unavailable(file: string, why: string): KeysResult {
  return {
    kind: 'unavailable',
    reason:
      `push is off: ${file} is unusable because ${why}. It was NOT regenerated, because a new ` +
      'pair silently invalidates every subscription. Delete the file and restart to create a ' +
      'fresh one, then subscribe again from each device.',
  }
}
