import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DRAIN_MAX_BYTES,
  ERROR_CODES,
  errorBody,
  isUploadRoute,
  MAX_BODY_BYTES,
  MAX_UPLOAD_BYTES,
  uploadRoute,
  type ModuleRequest,
  type RouteHandler,
} from './http.ts'

test('builds an error envelope with a code from the closed list', () => {
  assert.deepEqual(errorBody('unknown-origin', 'origin http://evil.com is not this host'), {
    error: { code: 'unknown-origin', message: 'origin http://evil.com is not this host' },
  })
})

test('the error codes are unique', () => {
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length)
})

test('the body cap is a megabyte', () => {
  assert.equal(MAX_BODY_BYTES, 1_048_576)
})

// --- Uploads (spec 2026-10-01, D1, ADR-0012) ------------------------------

const request = (extra: Partial<ModuleRequest> = {}): ModuleRequest => ({
  method: 'POST',
  path: '/up',
  params: {},
  query: {},
  body: undefined,
  ...extra,
})

test('the upload ceilings: 32 MiB for a route, 4 MiB drained after a refusal', () => {
  assert.equal(MAX_UPLOAD_BYTES, 32 * 1024 * 1024)
  assert.equal(DRAIN_MAX_BYTES, 4 * 1024 * 1024)
  assert.ok(MAX_BODY_BYTES < DRAIN_MAX_BYTES && DRAIN_MAX_BYTES < MAX_UPLOAD_BYTES)
})

test('an upload route is still a RouteHandler: callable, and it sees req.file', async () => {
  const route = uploadRoute(1_000, (req) => ({ status: 200, body: req.file?.bytes ?? null }))
  assert.equal(isUploadRoute(route), true)
  assert.equal(route.upload.maxBytes, 1_000)
  assert.deepEqual(await route(request({ file: { path: '/tmp/x', bytes: 7 } })), { status: 200, body: 7 })
  assert.deepEqual(await route(request()), { status: 200, body: null })
})

test('a plain handler is not an upload route', () => {
  const plain: RouteHandler = () => ({ status: 200 })
  assert.equal(isUploadRoute(plain), false)
  assert.equal(isUploadRoute(Object.assign(() => ({ status: 200 }), { upload: 'big' })), false)
})

test('a module never reaches the socket through a request (criterion 9)', () => {
  const req = request()
  // @ts-expect-error — `ModuleRequest` carries no socket, stream or IncomingMessage. If this line
  // ever compiles, a module can decide the network surface on its own.
  assert.equal(req.socket, undefined)
})
