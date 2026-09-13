/**
 * What crosses the HTTP boundary between the kernel and a module.
 *
 * A module never sees `IncomingMessage` or `ServerResponse`. Two reasons, and the
 * first is security: with a raw `ServerResponse` a module could hijack the socket and
 * upgrade to a WebSocket, opening a surface the kernel never declared. The second is
 * that a plain object can be tested without standing anything up.
 *
 * The cost is recorded rather than paid: binary bodies do not fit. Uploading or
 * serving a file needs a raw stream, and that is exactly what this boundary exists to
 * prevent. When a real consumer shows up, the right shape is a narrow kernel
 * capability (store a blob, serve a blob by id), not handing over the socket.
 */

/**
 * Keys are `'<METHOD> <path>'`, e.g. `'GET /places/:id'`.
 *
 * Two rules the router enforces, both checked at boot rather than on first request:
 *
 * - Literal segments beat parameters. `'GET /places/new'` wins over
 *   `'GET /places/:id'` regardless of the order the module wrote them in — a
 *   `Record` has no contractual order.
 * - Two parameters with the same name in one key abort startup, because `params` is
 *   a flat record and the second would silently shadow the first.
 */
export type RouteTable = Readonly<Record<string, RouteHandler>>

export type RouteHandler = (
  req: ModuleRequest,
) => Promise<ModuleResponse> | ModuleResponse

export interface ModuleRequest {
  readonly method: string
  /** Relative to `/modules/<id>/`. A module never sees its own prefix. */
  readonly path: string
  /**
   * `:name` segments from the route key, already extracted AND URL-decoded.
   *
   * The decoding is not a nicety. In the predecessor project the ids that travel in
   * a path are things like an email address, and its router carries the note "the
   * ids arrive escaped". A module that had to remember `decodeURIComponent` would
   * forget it exactly once.
   */
  readonly params: Readonly<Record<string, string>>
  readonly query: Readonly<Record<string, string>>
  /** Parsed JSON, size-capped by the kernel. `undefined` when there was no body. */
  readonly body: unknown
}

export interface ModuleResponse {
  readonly status: number
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * A closed list, and the error helper is typed against it.
 *
 * A new code needs an entry here and a reason written beside it. The bar: it earns a
 * code when it is the only thing that lets the client say something useful instead of
 * showing a status.
 */
export const ERROR_CODES = [
  /** Body failed validation, or the route was called wrong. */
  'invalid-request',
  /** No route matched. */
  'not-found',
  /** The module exists but is disabled; the reason travels in the message. */
  'module-disabled',
  /** A module's handler threw. The exception message is NOT forwarded. */
  'module-error',
  /** Body over MAX_BODY_BYTES. */
  'body-too-large',
  /**
   * `Origin` is not this host on this port. The received origin travels in the
   * message on purpose: without it, the fix is a guessing game and the check gets
   * switched off instead.
   */
  'unknown-origin',
  /** Requests that arrive before boot reaches READY. */
  'starting',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ErrorBody {
  readonly error: { readonly code: ErrorCode; readonly message: string }
}

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } }
}

/** Bodies above this are refused with 413, draining the socket first. */
export const MAX_BODY_BYTES = 1_048_576
