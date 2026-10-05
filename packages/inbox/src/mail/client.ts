/**
 * THE SEAM between reading an account and the IMAP library (spec 2026-10-05, D4).
 *
 * `ImapClient` is the part of `ImapFlow` that `fetchAccount` is allowed to call, declared by hand.
 * Every method on it reads: there is no `messageFlagsAdd`, no `mailboxCreate`, no `append` to reach
 * for. The real `ImapFlow` fits it structurally (checked below, at `connectImapFlow`), the client
 * double in `src/test-imap-client.ts` implements it in memory, and the protocol test hands a real
 * `ImapFlow` with a test CA through the same seam.
 */

import type { TcpNetConnectOpts } from 'node:net'
import type { ConnectionOptions } from 'node:tls'
import { ImapFlow, type FetchMessageObject, type ImapFlowOptions, type MessageStructureObject } from 'imapflow'

export type { FetchMessageObject, MessageStructureObject }

/**
 * The first fetch: what a mail is, without its text. `X-GM-MSGID` is not here because imapflow always
 * adds it when the server announces `X-GM-EXT-1` (`fetch.js`, "Always request a unique email ID"), and
 * returns it as `emailId`.
 */
export interface MetaQuery {
  readonly envelope: true
  readonly flags: true
  readonly bodyStructure: true
  readonly internalDate: true
  readonly headers: string[]
}

/**
 * The second fetch: ONE part of many mails at once, cut at `maxLength` bytes — `BODY.PEEK[<key>]<0.N>`.
 * Measured on Gmail (tasks §M, B8): one `download()` per mail costs about a second each, two
 * commands in series; this costs about a second and a half for all of them.
 */
export interface BodyQuery {
  readonly bodyParts: [{ readonly key: string; readonly maxLength: number }]
}

export interface ImapClient {
  readonly connect: () => Promise<void>
  /** Always `{ readOnly: true }`: EXAMINE, never SELECT (guardrail 1). */
  readonly mailboxOpen: (path: string, options: { readonly readOnly: true }) => Promise<unknown>
  readonly search: (query: { readonly since: Date }, options: { readonly uid: true }) => Promise<number[] | false | undefined>
  readonly fetchAll: (range: string, query: MetaQuery | BodyQuery, options: { readonly uid: true }) => Promise<FetchMessageObject[]>
  readonly logout: () => Promise<void>
  /** Drops the socket without a word to the server. Never throws. */
  readonly close: () => void
}

/**
 * The options a client is built with. `tls` carries socket timing, and in the protocol test a test CA —
 * never `rejectUnauthorized` (guardrail 6).
 */
export type ImapOptions = Pick<
  ImapFlowOptions,
  | 'host'
  | 'port'
  | 'secure'
  | 'auth'
  | 'logger'
  | 'disableAutoIdle'
  | 'disableCompression'
  | 'disableBinary'
  | 'disableAutoEnable'
  | 'connectionTimeout'
  | 'greetingTimeout'
  | 'socketTimeout'
> & {
  /**
   * Merged by imapflow into `tls.connect()`, which hands the socket options on to `net`: Node's TLS
   * typing does not declare the `net` half, so it is added here.
   */
  readonly tls?: ConnectionOptions & Pick<TcpNetConnectOpts, 'autoSelectFamilyAttemptTimeout'>
}

export type ConnectImap = (options: ImapOptions) => ImapClient

/** Production: a real ImapFlow, which the compiler checks against `ImapClient` right here. */
export const connectImapFlow: ConnectImap = (options) => {
  const client = new ImapFlow(options)
  // Without a listener, an `error` event on the client (a socket reset mid-run) is an unhandled
  // 'error' that ends the daemon. The failure still surfaces as a rejected call in `fetchAccount`.
  client.on('error', () => undefined)
  const seam: ImapClient = client
  return seam
}
