/**
 * What crosses the HTTP boundary between the kernel and a module.
 *
 * A module never sees `IncomingMessage` or `ServerResponse`. Two reasons, and the
 * first is security: with a raw `ServerResponse` a module could hijack the socket and
 * upgrade to a WebSocket, opening a surface the kernel never declared. The second is
 * that a plain object can be tested without standing anything up.
 *
 * Files fit now, WITHOUT a stream crossing (ADR-0012). A route made with `uploadRoute` receives
 * the bytes of one file as a PATH the kernel wrote, capped and named by the kernel; a response can
 * name a FILE in the module's state directory, and the kernel serves it with headers the module
 * does not choose. Both are optional fields: nothing that existed before had to change to compile.
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
  /** Parsed JSON, size-capped by the kernel. `undefined` when there was no body, and on an upload. */
  readonly body: unknown
  /**
   * Only on a route made with `uploadRoute`: where the kernel put the bytes. Absent everywhere else,
   * and a handler checks for it rather than trusting that it is there — a test can call it by hand.
   */
  readonly file?: ReceivedFile
}

/** The bytes of one uploaded file, already on disk. */
export interface ReceivedFile {
  /**
   * Absolute, inside `<stateDir>/.incoming/`, named by the kernel. MOVE IT TO KEEP IT: whatever is
   * still there when the handler returns, the kernel deletes.
   */
  readonly path: string
  readonly bytes: number
}

export interface ModuleResponse {
  readonly status: number
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
  /**
   * An absolute path inside the module's `stateDir`. When present the kernel serves THAT FILE and
   * ignores `body` and `headers`: how a file is served — its type, whether it is painted or
   * downloaded, whether it may run — is decided from its bytes, not by the module (ADR-0012).
   */
  readonly file?: string
}

/** What makes a route an upload route. */
export interface UploadSpec {
  /** At most MAX_UPLOAD_BYTES; checked when the daemon starts. */
  readonly maxBytes: number
}

/** Still a `RouteHandler` — callable as one — with the one fact the kernel needs before reading. */
export type UploadRoute = RouteHandler & { readonly upload: UploadSpec }

/**
 * Marks a handler as receiving the raw bytes of ONE file, up to `maxBytes`. The kernel reads the
 * body into a file and hands the handler `req.file`; it never hands over the stream.
 */
export function uploadRoute(maxBytes: number, handler: RouteHandler): UploadRoute {
  const route: RouteHandler = (req) => handler(req)
  return Object.assign(route, { upload: { maxBytes } })
}

export function isUploadRoute(handler: RouteHandler): handler is UploadRoute {
  const upload = (handler as Partial<UploadRoute>).upload
  return typeof upload === 'object' && upload !== null && typeof upload.maxBytes === 'number'
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
  /**
   * The request is valid and cannot be honoured in the current state: a new push subscription
   * when the machine already holds the most it accepts, a site that already has a live session,
   * an ask whose clock ran out. It earns a code because the client has something useful to say
   * — the message names the command that clears it, or the body carries the session in the way.
   *
   * EVERY 409 CARRIES THIS CODE. `invalid-request` means the caller called it wrong; losing a
   * race is not calling it wrong, and a client that branches on the code cannot tell the two
   * apart if they share one.
   */
  'conflict',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ErrorBody {
  readonly error: { readonly code: ErrorCode; readonly message: string }
}

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } }
}

/** JSON bodies above this are refused with 413, draining the socket first. */
export const MAX_BODY_BYTES = 1_048_576

/** The most an upload route may declare: 32 MiB. A module chooses its own ceiling below it. */
export const MAX_UPLOAD_BYTES = 33_554_432

/**
 * The most the kernel reads from a body it has ALREADY REFUSED, before closing the connection.
 * Draining lets the client read the 413; draining without a cap would let anyone make the daemon
 * read gigabytes to say no.
 */
export const DRAIN_MAX_BYTES = 4_194_304
