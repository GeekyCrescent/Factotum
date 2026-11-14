/**
 * The pieces of one IMAP session that any reader needs (spec 2026-11-12, D4): the options measured
 * against Gmail, a wait that ends with the signal, a bounded LOGOUT, and a reason that never carries
 * the password. Moved out of `inbox`'s `fetch.ts` unchanged, except that `imapOptions` and `reasonOf`
 * now read mail types instead of the inbox's account and fetch input.
 */

import type { Timers } from '@factotum/core'
import type { ImapClient, ImapOptions } from './client.ts'

/** TLS on 993, and nothing else (guardrail 6). */
export const IMAP_PORT = 993

const REASON_MAX = 200
/** LOGOUT is politeness: a server that does not answer it does not hold the run (or shutdown) longer. */
const LOGOUT_MAX_MS = 5_000

/** The six options measured in A1, and nothing a config can change. */
export function imapOptions(server: { readonly host: string; readonly user: string }, password: string): ImapOptions {
  return {
    host: server.host,
    port: IMAP_PORT,
    secure: true,
    auth: { user: server.user, pass: password },
    // Otherwise pino writes to the daemon's stdout, with subjects in it (criterion 27).
    logger: false,
    disableAutoIdle: true,
    disableCompression: true,
    disableBinary: true,
    disableAutoEnable: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    // Node's Happy Eyeballs gives EACH ADDRESS 250 ms by default. Measured 2026-10-06 behind a VPN:
    // a TCP connect to imap.gmail.com takes 280–560 ms and IPv6 is unreachable, so all four
    // addresses "time out" and the account fails with ETIMEDOUT in under a second. imapflow merges
    // `tls` into its `tls.connect()` options; `connectionTimeout` above still caps the whole.
    tls: { autoSelectFamilyAttemptTimeout: 2_500 },
  }
}

/**
 * A closed socket does not always settle what was waiting on it, so every wait also ends when the
 * signal fires. The work left behind is dropped; its rejection is swallowed here, not unhandled.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined)
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Aborted: `onAbort` already closed it, at the instant of the abort. Otherwise LOGOUT, politely — but
 * bounded: past LOGOUT_MAX_MS the socket is dropped. The abort listener is still on meanwhile, so the
 * run's cap or `stop()` also cuts it.
 */
export async function closeQuietly(client: ImapClient | undefined, aborted: boolean, timers: Timers): Promise<void> {
  if (client === undefined || aborted) return
  let timer: Disposable | undefined
  const late = new Promise<void>((resolve) => {
    timer = timers.setTimeout(resolve, LOGOUT_MAX_MS)
  })
  try {
    await Promise.race([client.logout().catch(() => undefined), late])
  } finally {
    timer?.[Symbol.dispose]()
    try {
      client.close()
    } catch {
      // Already closed: the outcome that was wanted.
    }
  }
}

/**
 * The server's words or Node's code — never the password, the user name masked, and a send's
 * recipient masked too (`<recipient>`, in any case: a server may echo it with other capitals), since
 * the reason is stored and served.
 */
export function reasonOf(error: unknown, secrets: { readonly user: string; readonly password: string; readonly recipient?: string }): string {
  const record = (error ?? {}) as { authenticationFailed?: unknown; response?: unknown; code?: unknown; message?: unknown }
  const words =
    typeof record.response === 'string' && record.response !== ''
      ? record.response
      : typeof record.code === 'string'
        ? record.code
        : typeof record.message === 'string'
          ? record.message
          : 'unknown error'
  const prefix = record.authenticationFailed === true ? 'login refused: ' : ''
  const masked = mask(mask(words, secrets.password, '***'), secrets.user, '<user>')
  const unaddressed = secrets.recipient === undefined ? masked : maskAnyCase(masked, secrets.recipient.trim(), '<recipient>')
  return `${prefix}${unaddressed}`.slice(0, REASON_MAX)
}

/** `mask`, whatever the case of the text: for an address, which a server may echo with other capitals. */
function maskAnyCase(text: string, secret: string, as: string): string {
  if (secret === '') return text
  return text.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), as)
}

export function mask(text: string, secret: string, as: string): string {
  return secret === '' ? text : text.split(secret).join(as)
}
