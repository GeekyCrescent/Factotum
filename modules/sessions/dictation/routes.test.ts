import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ERROR_CODES, isUploadRoute, type ModuleRequest, type ModuleResponse, type RouteTable } from '@factotum/core'
import { dictationRoutes } from './routes.ts'
import type { DictationState, Transcribed } from './service.ts'
import { DICTATION_MAX_BYTES, DICTATION_MAX_SECONDS } from './shape.ts'

const FILE = { path: '/state/.incoming/x.part', bytes: 10 }

function request(extra: Partial<ModuleRequest> = {}): ModuleRequest {
  return { method: 'POST', path: 'dictation', params: {}, query: { type: 'audio/webm' }, body: undefined, file: FILE, ...extra }
}

/** The same request without the bytes: what a route not called by the kernel's upload path would get. */
function withoutFile(): ModuleRequest {
  const { file: _file, ...rest } = request()
  return rest
}

function onWith(result: Transcribed | (() => Promise<Transcribed>)): DictationState {
  return { kind: 'on', transcribe: typeof result === 'function' ? result : async () => result }
}

async function call(table: RouteTable, key: string, req: ModuleRequest): Promise<ModuleResponse> {
  const handler = table[key]
  assert.notEqual(handler, undefined, key)
  return await handler!(req)
}

const codeOf = (response: ModuleResponse) => (response.body as { error?: { code?: string } } | undefined)?.error?.code

test('the POST is an upload route capped at DICTATION_MAX_BYTES — the kernel answers 413 above it (criterion 10)', () => {
  const route = dictationRoutes(() => undefined)['POST /dictation']
  assert.ok(route !== undefined && isUploadRoute(route))
  assert.equal(route.upload.maxBytes, DICTATION_MAX_BYTES)
})

test('GET /dictation: 503 before start, its ceilings when on, its reason when off (criterion 7)', async () => {
  const before = await call(dictationRoutes(() => undefined), 'GET /dictation', request({ method: 'GET' }))
  assert.equal(before.status, 503)
  assert.equal(codeOf(before), 'starting')

  const on = await call(dictationRoutes(() => onWith({ kind: 'ok', text: '' })), 'GET /dictation', request({ method: 'GET' }))
  assert.equal(on.status, 200)
  assert.deepEqual(on.body, { on: { maxSeconds: DICTATION_MAX_SECONDS, maxBytes: DICTATION_MAX_BYTES } })
  assert.equal(on.headers?.['cache-control'], 'no-store')

  const off = await call(dictationRoutes(() => ({ kind: 'off', reason: 'not here' })), 'GET /dictation', request({ method: 'GET' }))
  assert.equal(off.status, 200)
  assert.deepEqual(off.body, { off: 'not here' })
  assert.equal(off.headers?.['cache-control'], 'no-store')
})

test('POST: the text, without caching (criterion 8)', async () => {
  const response = await call(dictationRoutes(() => onWith({ kind: 'ok', text: 'hola' })), 'POST /dictation', request())
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { text: 'hola' })
  assert.equal(response.headers?.['cache-control'], 'no-store')
})

test('POST before start is 503, and without the bytes is 400', async () => {
  assert.equal((await call(dictationRoutes(() => undefined), 'POST /dictation', request())).status, 503)
  const noFile = await call(dictationRoutes(() => onWith({ kind: 'ok', text: '' })), 'POST /dictation', withoutFile())
  assert.equal(noFile.status, 400)
  assert.equal(codeOf(noFile), 'invalid-request')
})

test('off: 409 `conflict` with `dictation.off` — the shape of uploads switched off — and nothing transcribed (criterion 11)', async () => {
  const response = await call(dictationRoutes(() => ({ kind: 'off', reason: 'no key' })), 'POST /dictation', request())
  assert.equal(response.status, 409)
  assert.equal(codeOf(response), 'conflict')
  assert.deepEqual((response.body as { dictation: unknown }).dictation, { off: 'no key' })
})

test('the type travels to the service as it came; invalid is 400 (criterion 9)', async () => {
  let seen: string | undefined = 'untouched'
  const table = dictationRoutes(() =>
    onWith(async () => {
      return { kind: 'invalid', reason: 'bad type' }
    }),
  )
  const response = await call(table, 'POST /dictation', request({ query: {} }))
  assert.equal(response.status, 400)
  assert.equal(codeOf(response), 'invalid-request')

  const spy: DictationState = {
    kind: 'on',
    transcribe: async (_file, type) => {
      seen = type
      return { kind: 'ok', text: '' }
    },
  }
  await call(dictationRoutes(() => spy), 'POST /dictation', request({ query: { type: 'audio/webm;codecs=opus' } }))
  assert.equal(seen, 'audio/webm;codecs=opus')
})

test('the provider failing: 502 `module-error` with `dictation.failure` — told apart from tailscale by the BODY (criterion 12)', async () => {
  for (const failure of ['credential', 'quota', 'failed'] as const) {
    const response = await call(
      dictationRoutes(() => onWith({ kind: 'provider', failure, message: 'the transcription provider …' })),
      'POST /dictation',
      request(),
    )
    assert.equal(response.status, 502)
    assert.equal(codeOf(response), 'module-error')
    assert.deepEqual((response.body as { dictation: unknown }).dictation, { failure })
  }
})

test('every error code these routes can send is one of the core\'s closed list', async () => {
  const responses = [
    await call(dictationRoutes(() => undefined), 'GET /dictation', request({ method: 'GET' })),
    await call(dictationRoutes(() => undefined), 'POST /dictation', request()),
    await call(dictationRoutes(() => onWith({ kind: 'ok', text: '' })), 'POST /dictation', withoutFile()),
    await call(dictationRoutes(() => ({ kind: 'off', reason: 'x' })), 'POST /dictation', request()),
    await call(dictationRoutes(() => onWith({ kind: 'invalid', reason: 'x' })), 'POST /dictation', request()),
    await call(dictationRoutes(() => onWith({ kind: 'provider', failure: 'failed', message: 'x' })), 'POST /dictation', request()),
  ]
  for (const response of responses) {
    const code = codeOf(response)
    assert.ok(code !== undefined && (ERROR_CODES as readonly string[]).includes(code), String(code))
  }
})

test('the host failing propagates: the kernel makes it a 500 and still deletes the file (D6)', async () => {
  const table = dictationRoutes(() =>
    onWith(async () => {
      throw new Error('EACCES')
    }),
  )
  await assert.rejects(call(table, 'POST /dictation', request()))
})

test('nothing secret reaches a body: not the key in GET, not in any error (criterion 18)', async () => {
  // The routes only ever see what the service decided to say; this pins that they add nothing of their own.
  const bodies = JSON.stringify([
    (await call(dictationRoutes(() => onWith({ kind: 'ok', text: '' })), 'GET /dictation', request({ method: 'GET' }))).body,
    (await call(dictationRoutes(() => ({ kind: 'off', reason: 'dictation is off: cannot read the API key file /k' })), 'GET /dictation', request({ method: 'GET' }))).body,
    (await call(dictationRoutes(() => onWith({ kind: 'provider', failure: 'credential', message: 'the transcription provider rejected the API key' })), 'POST /dictation', request())).body,
  ])
  assert.doesNotMatch(bodies, /gsk_|CENTINELA/)
})
