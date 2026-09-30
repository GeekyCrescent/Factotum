/**
 * The HTTP surface. Everything a module is allowed to do to a request happens here,
 * on its behalf, so that a module can be a set of plain functions.
 *
 * Three things live in exactly one place because they are the ones that must not be
 * decided per-module: the origin check, the body cap, and readiness.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  DRAIN_MAX_BYTES,
  errorBody,
  isUploadRoute,
  MAX_BODY_BYTES,
  type Environment,
  type ErrorCode,
  type ModuleResponse,
} from '@factotum/core'
import { rm } from 'node:fs/promises'
import { refuseTooLarge } from './body.ts'
import { sendFile } from './serve-file.ts'
import { readUploadBody } from './upload.ts'
import { describePolicy, originAllowed, type OriginPolicy } from '../net/origin.ts'
import type { Interfaces } from '../net/resolve.ts'
import { isSameMachine, sourceIpOf } from '../net/same-machine.ts'
import { Registry, type Resolved } from '../modules/registry.ts'
import type { PushService } from '../push/service.ts'
import { subscriptionSchema } from '../push/schema.ts'

export interface StaticSite {
  /**
   * `undefined` when the path is not part of the site. `immutable` when the file is one Vite
   * emitted with a hash in its name, and so can be cached for good.
   */
  serve: (path: string) => Promise<{ body: Buffer; type: string; immutable: boolean } | undefined>
}

export interface ServerDeps {
  readonly registry: Registry
  readonly origin: OriginPolicy
  readonly env: Environment
  readonly version: string
  readonly startedAt: number
  readonly site?: StaticSite
  /**
   * False until boot reaches its last step. While false the API answers 503 — but
   * the static site and /health do not, so a QR scanned during a restart still gets
   * HTML and a supervisor can still tell "starting" from "wedged".
   */
  readonly isReady: () => boolean
  /** The two push routes below. Never a module: the kernel knows no module by name. */
  readonly push: Pick<PushService, 'publicKey' | 'subscribe'>
  /** This machine's addresses, to tell a subscription from here (design D12). */
  readonly interfaces: Interfaces
}

/**
 * THE API OWNS THIS PREFIX, and the static site must not answer under it.
 *
 * The static branch runs BEFORE the origin check and falls back to `index.html` for anything
 * it does not own (`static.ts:31`) — which is right for `/m/<id>` and would make every GET here
 * answer 200 text/html, unreachable and above the 403. Exact prefix, so `/pushup` stays the
 * client's.
 */
function isPushPath(path: string): boolean {
  return path === '/push' || path.startsWith('/push/')
}

export function createServer(deps: ServerDeps): Server {
  return createHttpServer((req, res) => {
    void handle(req, res, deps).catch(() => {
      if (!res.headersSent) sendError(res, 500, 'module-error', 'the kernel failed to handle this request')
      else res.end()
    })
  })
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://placeholder')
  const path = normalizePath(url.pathname)
  const method = req.method ?? 'GET'

  // --- Always available, whatever else is going on -------------------------
  // Not behind the origin check: /health is read by supervisors that have no
  // browser, and the static site is what the browser loads BEFORE it has an
  // origin of its own to send.

  if (path === '/health') {
    return sendJson(res, 200, {
      version: deps.version,
      environment: deps.env,
      ready: deps.isReady(),
      uptimeMs: Date.now() - deps.startedAt,
    })
  }

  if (method === 'GET' && deps.site !== undefined && !path.startsWith('/modules') && !isPushPath(path)) {
    const file = await deps.site.serve(path)
    if (file !== undefined) {
      res.writeHead(200, {
        'content-type': file.type,
        // NO-STORE, not no-cache, for everything without a hash. no-cache still lets the browser
        // KEEP the response — and the page a notification opens is requested with `?ask=<token>`
        // in its URL: measured, Chrome stored it in its HTTP cache, token and all (spec
        // 2026-09-18, M4). The hashed assets change name when they change, so they are forever.
        'cache-control': file.immutable ? 'public, max-age=31536000, immutable' : 'no-store',
      })
      return void res.end(file.body)
    }
  }

  // --- The API ------------------------------------------------------------

  const origin = req.headers.origin
  if (typeof origin === 'string' && !originAllowed(origin, deps.origin)) {
    // The received origin travels in the message on purpose. Without it the fix is
    // guesswork, and a check nobody can debug gets switched off rather than fixed.
    return sendError(
      res,
      403,
      'unknown-origin',
      `origin ${origin} is not an accepted origin: ${describePolicy(deps.origin).join('; ')}`,
    )
  }

  if (!deps.isReady()) {
    return sendError(res, 503, 'starting', 'factotum is still starting')
  }

  if (path === '/modules') {
    return sendJson(res, 200, { modules: deps.registry.list() })
  }

  // --- Push: the daemon's own, behind the origin check AND the 503 ------------
  // Behind the origin check because a subscription is exactly what a hostile page would want to
  // plant. Behind the 503 because boot step 13 exists so nothing is served half-built. Neither
  // stops a process on this machine — see push/service.ts for what does instead.

  if (isPushPath(path)) {
    if (method === 'GET' && path === '/push/public-key') {
      const publicKey = deps.push.publicKey()
      // Off answers 404 WITHOUT the reason: it names the key file's path, and a path does not
      // reach a client (`module-error` below exists for the same reason). `doctor` says why.
      if (publicKey === undefined) return sendError(res, 404, 'not-found', 'push is off on this machine; run `factotum doctor` for the reason')
      return sendJson(res, 200, { publicKey })
    }

    if (method === 'POST' && path === '/push/subscriptions') {
      const read = await readBodyOrAnswer(req, res)
      if (!read.ok) return

      const parsed = subscriptionSchema.safeParse(read.body)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        return sendError(res, 400, 'invalid-request', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`)
      }

      const sameMachine = isSameMachine({
        origin: typeof origin === 'string' ? origin : undefined,
        policy: deps.origin,
        sourceIp: sourceIpOf(req.headers),
        interfaces: deps.interfaces,
      })
      const result = await deps.push.subscribe(parsed.data, { sameMachine })
      if (result.kind === 'off') return sendError(res, 404, 'not-found', 'push is off on this machine; run `factotum doctor` for the reason')
      if (result.kind === 'full') return sendError(res, 409, 'conflict', result.reason)
      // A COUNT, never the list: every endpoint is a capability (criterion 10). The count is
      // what lets the first device on a fresh daemon notice a second one it did not add.
      // And whether this browser is on the daemon's machine: the client keeps no ask token if so.
      return sendJson(res, 200, { count: result.count, sameMachine })
    }

    return sendError(res, 404, 'not-found', `no route ${method} ${path}`)
  }

  const moduleRoute = /^\/modules\/([^/]+)(\/.*)?$/.exec(path)
  if (moduleRoute !== null) {
    const [, id, rest] = moduleRoute as unknown as [string, string, string | undefined]
    return await handleModule(req, res, deps, { id, method, path: rest ?? '/', query: url.searchParams })
  }

  return sendError(res, 404, 'not-found', `no route ${method} ${path}`)
}

/**
 * The module branch (spec 2026-10-01, D2). THE ROUTE IS RESOLVED BEFORE THE BODY IS READ, because an
 * upload route reads its body into a file and every other route reads JSON.
 *
 * For everything that is not an upload the order of answers is exactly what it was — JSON read
 * first, so a 413 or a 400 still comes before a 404 or a 501 — and the tests written against the old
 * code before this change (`server.test.ts`, "module branch") pass untouched.
 */
async function handleModule(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  target: { readonly id: string; readonly method: string; readonly path: string; readonly query: URLSearchParams },
): Promise<void> {
  const { id, method, path, query } = target
  const moduleFailed = () => sendError(res, 500, 'module-error', `module "${id}" failed to handle this request`)

  // `resolve` can throw (a malformed `%` escape in a parameter). It used to throw inside `dispatch`,
  // after the body was read, as a 500; it still ends there.
  let resolved: Resolved | undefined
  try {
    resolved = deps.registry.resolve(id, method, path)
  } catch {
    resolved = undefined
  }

  if (resolved?.kind === 'route' && isUploadRoute(resolved.handler)) {
    const file = await readUploadBody(req, res, resolved.stateDir, resolved.handler.upload.maxBytes)
    if (file === undefined) return
    let response: ModuleResponse | undefined
    try {
      response = await Registry.call(resolved, method, path, query, undefined, file)
    } catch {
      response = undefined
    }
    // What the handler did not move is not anybody's. Always, even when it threw — and BEFORE
    // answering, so nothing the client can observe happens while the file is still there.
    await rm(file.path, { force: true })
    if (response === undefined) return moduleFailed()
    return await respond(res, response, resolved.stateDir)
  }

  const read = await readBodyOrAnswer(req, res)
  if (!read.ok) return

  if (resolved === undefined) return moduleFailed()
  switch (resolved.kind) {
    case 'none':
      return sendError(res, 404, 'not-found', `no module "${id}" is running`)
    case 'disabled':
    case 'no-route':
      return send(res, resolved.response)
    case 'route': {
      let response: ModuleResponse
      try {
        response = await Registry.call(resolved, method, path, query, read.body)
      } catch {
        // A module's exception message never reaches the client: it can carry paths,
        // credentials, or anything else the module happened to interpolate.
        return moduleFailed()
      }
      return await respond(res, response, resolved.stateDir)
    }
  }
}

/** A file when the module named one — served by the kernel's rules, not the module's — else JSON. */
async function respond(res: ServerResponse, response: ModuleResponse, stateDir: string): Promise<void> {
  if (response.file !== undefined) return await sendFile(res, response.file, stateDir)
  send(res, response)
}

/**
 * `/modules/example/../../health` must not exist. Without this, the claim that a
 * module cannot register anything outside its prefix is true of the route table and
 * false of the request.
 */
function normalizePath(pathname: string): string {
  const out: string[] = []
  for (const raw of pathname.split('/')) {
    const part = decodeURIComponent(raw)
    if (part === '' || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return `/${out.join('/')}`
}

/**
 * Reads the body, or answers 413 / 400 itself. THE BODY CAP LIVES HERE, ONCE.
 *
 * `readJsonBody` only reports `'too-large'`; the 413 with its drain and the 400 used to live
 * inline in the module branch. A second branch that read bodies would have had to copy them —
 * and the header of this file says the body cap is one of the three things that must not be
 * decided in two places.
 */
async function readBodyOrAnswer(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false }> {
  const read = await readJsonBody(req)
  if (read.kind === 'too-large') {
    refuseTooLarge(res, read.drained, `bodies are capped at ${MAX_BODY_BYTES} bytes`)
    return { ok: false }
  }
  if (read.kind === 'invalid') {
    sendError(res, 400, 'invalid-request', 'the body is not valid JSON')
    return { ok: false }
  }
  return { ok: true, body: read.body }
}

type JsonRead =
  | { readonly kind: 'ok'; readonly body: unknown }
  | { readonly kind: 'invalid' }
  /** `drained`: the whole body was read, so the client is listening for the answer. */
  | { readonly kind: 'too-large'; readonly drained: boolean }

/**
 * NOTHING THROWS INSIDE THE LOOP. It used to: a `throw` out of `for await` destroys the request, and
 * the drain that followed then waited on a dead stream — a 413 of 2 MB took six seconds to arrive
 * (spec 2026-10-01, B0). Past the cap it keeps reading and discarding, up to DRAIN_MAX_BYTES.
 */
async function readJsonBody(req: IncomingMessage): Promise<JsonRead> {
  if (req.method === 'GET' || req.method === 'HEAD') return { kind: 'ok', body: undefined }

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES + DRAIN_MAX_BYTES) return { kind: 'too-large', drained: false }
    if (size <= MAX_BODY_BYTES) chunks.push(chunk as Buffer)
  }
  if (size > MAX_BODY_BYTES) return { kind: 'too-large', drained: true }
  if (size === 0) return { kind: 'ok', body: undefined }
  try {
    return { kind: 'ok', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { kind: 'invalid' }
  }
}

function send(res: ServerResponse, response: ModuleResponse): void {
  const headers = { 'content-type': 'application/json', ...response.headers }
  res.writeHead(response.status, headers)
  res.end(response.body === undefined ? undefined : JSON.stringify(response.body))
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, status: number, code: ErrorCode, message: string): void {
  sendJson(res, status, errorBody(code, message))
}
