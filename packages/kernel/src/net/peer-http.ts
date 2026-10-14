/**
 * ONE REQUEST TO THE PEER, IN A STREAM (spec 2026-10-07, D4). Taken out of `http/proxy.ts` so the
 * proxy and `ctx.peers.upload` send bytes the same way: the proxy hands it the browser's
 * `IncomingMessage`, `upload` a file it opened.
 *
 * `node:http`, NOT `fetch`, and it was measured (spec 2026-10-07, B6b): Node 26's `fetch`
 * (undici 8.3) pulls a streamed request body as fast as it can, whatever the socket says — a
 * 50 MB upload went through and sat in memory whole, with `Readable.toWeb`, an async iterable or a
 * pull stream alike, with and without `content-length`. Piped through `request`, the same upload
 * peaked at 2 MB. The URL is always one `peers.url()` built; `request` follows no redirect.
 */

import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface SendOptions {
  readonly method: string
  readonly headers: Record<string, string>
  readonly signal: AbortSignal
}

/** One request to the peer, resolved with its response. The body, if any, is piped — with backpressure. */
export function send(target: URL, options: SendOptions, body: Readable | undefined): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const make = target.protocol === 'https:' ? httpsRequest : httpRequest
    const out = make(target, { method: options.method, headers: options.headers, signal: options.signal }, resolve)
    // A body that does not match the length it announced is an error, never a request whose end
    // the peer has to guess. @types/node 22 declares the flag on `ServerResponse` only; it lives on
    // `OutgoingMessage`, and on a `ClientRequest` it throws ERR_HTTP_CONTENT_LENGTH_MISMATCH (measured).
    ;(out as ClientRequest & { strictContentLength: boolean }).strictContentLength = true
    out.on('error', reject)
    if (body === undefined) out.end()
    // A failure on either side destroys both; `out`'s error rejects above if no answer came yet.
    else void pipeline(body, out).catch(() => undefined)
  })
}
