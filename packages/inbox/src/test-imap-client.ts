/**
 * A DOUBLE of the IMAP client, for the `connect` seam (spec 2026-10-05, D4; task B6). Test-only:
 * excluded from coverage, and here rather than under `test/` because `rootDir` is `src` (TS6059).
 *
 * It answers in memory with made-up mails and writes down every call WITH ITS OPTIONS, so a test can
 * assert `readOnly: true`, `uid: true` and `maxBytes` on every one. It is what tests `fetchAccount`;
 * what imapflow itself sends on the wire is the protocol test's job (`fetch.protocol.test.ts`).
 */

import type { ConnectImap, FetchMessageObject, ImapClient, ImapOptions, MessageStructureObject } from './mail/client.ts'

export interface FakeMail {
  readonly uid: number
  readonly internalDate: Date
  readonly seen?: boolean
  readonly from?: { readonly name?: string; readonly address: string }
  readonly to?: readonly string[]
  readonly cc?: readonly string[]
  readonly subject?: string
  readonly messageId?: string
  readonly emailId?: string
  /** Raw header lines, as the server returns `HEADER.FIELDS`. */
  readonly headers?: string
  readonly structure?: MessageStructureObject
  /** Part number → its bytes as the server holds them (still transfer-encoded). */
  readonly parts?: Readonly<Record<string, string>>
}

export interface Call {
  readonly method: string
  readonly args: readonly unknown[]
}

/** `bodies` is the second fetch, the one with `bodyParts`. */
export type Stall = 'connect' | 'mailboxOpen' | 'search' | 'fetchAll' | 'bodies' | 'logout'

export interface DoubleOptions {
  /** Rejects `connect` the way imapflow rejects a refused login. */
  readonly refuseLogin?: { readonly response: string }
  /** Rejects `connect` the way Node rejects a host it cannot resolve. */
  readonly networkError?: string
  /** Never answers this call — until `close()`, if `settleOnClose`. */
  readonly stall?: Stall
  /** A stalled call rejects when the socket is closed, as a real one usually does. */
  readonly settleOnClose?: boolean
}

export interface ImapDouble {
  readonly connect: ConnectImap
  readonly calls: Call[]
  readonly built: ImapOptions[]
  readonly closed: () => number
}

export function imapDouble(mails: readonly FakeMail[], options: DoubleOptions = {}): ImapDouble {
  const calls: Call[] = []
  const built: ImapOptions[] = []
  let closes = 0

  const connect: ConnectImap = (opts) => {
    built.push(opts)
    const waiting = new Set<(error: Error) => void>()

    const answer = <T>(method: Stall, value: () => T): Promise<T> => {
      if (options.stall !== method) return Promise.resolve().then(value)
      return new Promise<T>((_resolve, reject) => {
        if (options.settleOnClose === true) waiting.add(reject)
      })
    }

    const client: ImapClient = {
      connect: async () => {
        calls.push({ method: 'connect', args: [] })
        if (options.refuseLogin !== undefined) {
          throw Object.assign(new Error('Authentication failed'), {
            authenticationFailed: true,
            response: options.refuseLogin.response,
          })
        }
        if (options.networkError !== undefined) {
          throw Object.assign(new Error(`getaddrinfo ${options.networkError} ${opts.host}`), { code: options.networkError })
        }
        return await answer('connect', () => undefined)
      },
      mailboxOpen: async (path, openOptions) => {
        calls.push({ method: 'mailboxOpen', args: [path, openOptions] })
        return await answer('mailboxOpen', () => ({ path, readOnly: openOptions.readOnly }))
      },
      search: async (query, searchOptions) => {
        calls.push({ method: 'search', args: [query, searchOptions] })
        return await answer('search', () =>
          mails.filter((mail) => dayOf(mail.internalDate) >= dayOf(query.since)).map((mail) => mail.uid),
        )
      },
      fetchAll: async (range, query, fetchOptions) => {
        calls.push({ method: 'fetchAll', args: [range, query, fetchOptions] })
        const wanted = mails.filter((mail) => range.split(',').map(Number).includes(mail.uid))
        if ('bodyParts' in query) {
          const [{ key, maxLength }] = query.bodyParts
          return await answer('bodies', () =>
            wanted.flatMap((mail) => {
              const text = mail.parts?.[key]
              if (text === undefined) return []
              return [{ seq: mail.uid, uid: mail.uid, bodyParts: new Map([[key, Buffer.from(text).subarray(0, maxLength)]]) }]
            }),
          )
        }
        return await answer('fetchAll', () => wanted.map(toMessage))
      },
      logout: async () => {
        calls.push({ method: 'logout', args: [] })
        return await answer('logout', () => undefined)
      },
      close: () => {
        calls.push({ method: 'close', args: [] })
        closes += 1
        for (const reject of waiting) reject(new Error('Connection not available'))
        waiting.clear()
      },
    }
    return client
  }

  return { connect, calls, built, closed: () => closes }
}

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function toMessage(mail: FakeMail): FetchMessageObject {
  return {
    seq: mail.uid,
    uid: mail.uid,
    flags: new Set(mail.seen === true ? ['\\Seen'] : []),
    internalDate: mail.internalDate,
    ...(mail.emailId === undefined ? {} : { emailId: mail.emailId }),
    envelope: {
      date: mail.internalDate,
      subject: mail.subject ?? '',
      ...(mail.messageId === undefined ? {} : { messageId: mail.messageId }),
      from: mail.from === undefined ? [] : [mail.from],
      to: (mail.to ?? []).map((address) => ({ address })),
      cc: (mail.cc ?? []).map((address) => ({ address })),
    },
    bodyStructure: mail.structure ?? { type: 'text/plain' },
    headers: Buffer.from(mail.headers ?? ''),
  }
}
