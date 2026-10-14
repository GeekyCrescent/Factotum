/**
 * `ctx.peers`: a module talks to ITS TWIN on the other host (spec 2026-10-07, D4).
 *
 * The kernel keeps every decision about the network, as with the proxy: the module names a peer
 * and a path relative to itself, and this file builds `/modules/<id>/<path>` through `peers.url()`
 * — the same `ALLOWED_PATH`, `TRAVERSAL` and exact-origin check as the proxy — decides the timeout
 * under a ceiling, and logs the shape of the route only (criterion 36).
 *
 * BOTH CALLS GO THROUGH `send()` (`net/peer-http.ts`), the proxy's streamed request. The design
 * had `json` on `fetch`; one path means one reader of the answer, one way to abort, and one way a
 * connection fails (tasks §M, N2b).
 *
 * The id is NOT bound here: the registry binds it, as it binds `notify`'s (ADR-0008). This is the
 * kernel-wide service; `Registry.create` hands each module a `PeerCaller` with its own id inside.
 */

import { open, type FileHandle } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { MAX_BODY_BYTES, type Logger, type PeerCallOptions, type PeerResponse, type PeerView, type Timers } from '@factotum/core'
import { send } from './peer-http.ts'
import type { PeerTable } from './peers.ts'

/** A call that names no timeout. Reads of a peer that runs git take longer; the caller says so. */
export const PEER_CALL_DEFAULT_MS = 10_000

/**
 * The longest any call may take: Node's default `requestTimeout` on the peer's HTTP server, which
 * the kernel does not change. A longer wait could only end in the peer cutting the request.
 */
export const PEER_CALL_MAX_MS = 300_000

export interface PeerCallsDeps {
  readonly table: Pick<PeerTable, 'list' | 'get' | 'url'>
  /** The kernel's own timers (CLAUDE.md §6). */
  readonly timers: Timers
  readonly log: Logger
}

export interface PeerCalls {
  readonly list: () => readonly PeerView[]
  readonly json: <T = unknown>(
    moduleId: string,
    peer: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    options?: PeerCallOptions,
  ) => Promise<PeerResponse<T>>
  readonly upload: <T = unknown>(moduleId: string, peer: string, path: string, file: string, options?: PeerCallOptions) => Promise<PeerResponse<T>>
  /** Every call in flight ends as `{ ok: false }` now. `BootHandle.stop` calls it, like `proxy.abortAll()`. */
  readonly abortAll: () => void
}

type Failure = Extract<PeerResponse<never>, { ok: false }>
type Reason = Failure['reason']

const fail = (reason: Reason, status?: number, body?: unknown): Failure => ({ ok: false, status, reason, body })

/** Where a call goes, or why it does not leave. Nothing is opened and nothing is sent before this. */
type Route = { readonly ok: true; readonly target: URL; readonly shape: string } | { readonly ok: false; readonly failure: Failure }

/** What one request carries out: its headers and its body, opened only once the route is known to be good. */
interface Opened {
  readonly headers: Record<string, string>
  readonly body: Readable | undefined
}

interface Outgoing {
  readonly method: 'GET' | 'POST'
  readonly open: () => Promise<Opened>
}

/** No compression on the way back: the cap counts the bytes as they arrive. */
const BASE_HEADERS = { accept: 'application/json', 'accept-encoding': 'identity' } as const

export function createPeerCalls(deps: PeerCallsDeps): PeerCalls {
  const inFlight = new Set<AbortController>()

  const route = (moduleId: string, peer: string, path: string): Route => {
    if (deps.table.get(peer)?.reachable !== true) return { ok: false, failure: fail('unreachable') }
    const target = deps.table.url(peer, `/modules/${moduleId}/${path}`)
    return target === undefined ? { ok: false, failure: fail('refused') } : { ok: true, target, shape: `/modules/${moduleId}/…` }
  }

  const call = async <T>(moduleId: string, peer: string, path: string, out: Outgoing, options: PeerCallOptions | undefined): Promise<PeerResponse<T>> => {
    const where = route(moduleId, peer, path)
    if (!where.ok) {
      // No peer name and no path: a refused path is the module's own, and may carry a token.
      deps.log.info(`peers ${out.method} ${where.failure.reason}`)
      return where.failure
    }

    let opened: Opened
    try {
      opened = await out.open()
    } catch {
      // The module's file is not there: nothing left this host, so it is the kernel refusing.
      deps.log.info(`peers ${out.method} refused`)
      return fail('refused')
    }

    const timeoutMs = Math.min(options?.timeoutMs ?? PEER_CALL_DEFAULT_MS, PEER_CALL_MAX_MS)
    const controller = new AbortController()
    let timedOut = false
    const timer = deps.timers.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    inFlight.add(controller)
    const started = performance.now()
    let answer: PeerResponse<T>
    try {
      const response = await send(where.target, { method: out.method, headers: opened.headers, signal: controller.signal }, opened.body)
      answer = await readAnswer<T>(response)
    } catch {
      answer = fail(timedOut ? 'timeout' : 'unreachable')
    } finally {
      timer[Symbol.dispose]()
      inFlight.delete(controller)
      // Whatever happened, the file is closed: the kernel opened it, the kernel closes it (ADR-0012).
      opened.body?.destroy()
    }
    const outcome = answer.ok || answer.reason === 'http' || answer.reason === 'bad-json' ? String(answer.status) : answer.reason
    deps.log.info(`peers ${out.method} ${peer} ${where.shape} → ${outcome} ${Math.round(performance.now() - started)}ms`)
    return answer
  }

  return {
    list: () => deps.table.list().map(({ name, reachable }) => ({ name, reachable })),
    json: (moduleId, peer, method, path, body, options) => {
      const open = async (): Promise<Opened> => {
        if (method !== 'POST') return { headers: BASE_HEADERS, body: undefined }
        const payload = Buffer.from(JSON.stringify(body ?? null))
        const headers = { ...BASE_HEADERS, 'content-type': 'application/json', 'content-length': String(payload.length) }
        return { headers, body: Readable.from([payload]) }
      }
      return call(moduleId, peer, path, { method, open }, options)
    },
    upload: <T,>(moduleId: string, peer: string, path: string, file: string, options?: PeerCallOptions) => {
      let handle: FileHandle | undefined
      const open$ = async (): Promise<Opened> => {
        handle = await open(file, 'r')
        const { size } = await handle.stat()
        const headers = { ...BASE_HEADERS, 'content-type': 'application/octet-stream', 'content-length': String(size) }
        return { headers, body: handle.createReadStream({ autoClose: true }) }
      }
      // A stat that failed leaves the handle open with no stream to close it.
      return call<T>(moduleId, peer, path, { method: 'POST', open: open$ }, options).finally(() => void handle?.close().catch(() => undefined))
    },
    abortAll: () => {
      for (const controller of inFlight) controller.abort()
    },
  }
}

/**
 * The peer's answer, read with the cap every JSON body has here. A 2xx must be JSON (`bad-json` if
 * not); any other status is `http`, with the body when it is JSON and fits, so the module can read
 * its own refusal (design D4). A 3xx is `http` too: nothing is followed.
 */
async function readAnswer<T>(response: IncomingMessage): Promise<PeerResponse<T>> {
  const status = response.statusCode ?? 0
  const parsed = await readJson(response)
  if (status >= 200 && status < 300) return parsed.ok ? { ok: true, status, body: parsed.value as T } : fail('bad-json', status)
  return fail('http', status, parsed.ok ? parsed.value : undefined)
}

/** At most MAX_BODY_BYTES, then JSON. Past the cap the rest is not read: the socket is destroyed. */
async function readJson(response: IncomingMessage): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) {
      response.destroy()
      return { ok: false }
    }
    chunks.push(chunk as Buffer)
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  } catch {
    return { ok: false }
  }
}
