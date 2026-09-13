/**
 * The HTTP surface. Everything a module is allowed to do to a request happens here,
 * on its behalf, so that a module can be a set of plain functions.
 *
 * Three things live in exactly one place because they are the ones that must not be
 * decided per-module: the origin check, the body cap, and readiness.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  errorBody,
  MAX_BODY_BYTES,
  type Environment,
  type ErrorCode,
  type ModuleResponse,
} from '@factotum/core'
import { describePolicy, originAllowed, type OriginPolicy } from '../net/origin.ts'
import type { Registry } from '../modules/registry.ts'

export interface StaticSite {
  /** `undefined` when the path is not part of the site. */
  serve: (path: string) => Promise<{ body: Buffer; type: string } | undefined>
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

  if (method === 'GET' && deps.site !== undefined && !path.startsWith('/modules')) {
    const file = await deps.site.serve(path)
    if (file !== undefined) {
      res.writeHead(200, { 'content-type': file.type })
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
      `origin ${origin} is not this host: ${describePolicy(deps.origin).join('; ')}`,
    )
  }

  if (!deps.isReady()) {
    return sendError(res, 503, 'starting', 'factotum is still starting')
  }

  if (path === '/modules') {
    return sendJson(res, 200, { modules: deps.registry.list() })
  }

  const moduleRoute = /^\/modules\/([^/]+)(\/.*)?$/.exec(path)
  if (moduleRoute !== null) {
    const [, id, rest] = moduleRoute as unknown as [string, string, string | undefined]

    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (error) {
      if ((error as Error).message === 'too-large') {
        await drain(req)
        return sendError(res, 413, 'body-too-large', `bodies are capped at ${MAX_BODY_BYTES} bytes`)
      }
      return sendError(res, 400, 'invalid-request', 'the body is not valid JSON')
    }

    let response: ModuleResponse | undefined
    try {
      response = await deps.registry.dispatch(id, method, rest ?? '/', url.searchParams, body)
    } catch {
      // A module's exception message never reaches the client: it can carry paths,
      // credentials, or anything else the module happened to interpolate.
      return sendError(res, 500, 'module-error', `module "${id}" failed to handle this request`)
    }

    if (response === undefined) {
      return sendError(res, 404, 'not-found', `no module "${id}" is running`)
    }
    return send(res, response)
  }

  return sendError(res, 404, 'not-found', `no route ${method} ${path}`)
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('too-large')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Drained before answering 413. Without it the socket is destroyed mid-upload and
 * the client never gets to read the error it caused.
 */
async function drain(req: IncomingMessage): Promise<void> {
  try {
    for await (const _chunk of req) {
      // discard
    }
  } catch {
    // The client went away; nothing to do.
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
