import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ModuleRequest } from '@factotum/core'
import { handoffRoutes, respond } from './handoff-routes.ts'
import type { HandoffApi } from './handoff-types.ts'

const request = (method: string, path: string, extra: Partial<ModuleRequest> = {}): ModuleRequest =>
  ({ method, path, query: {}, params: {}, body: undefined, ...extra }) as ModuleRequest

test('each of the five kinds is its status, and a refusal carries `handoff` next to the kernel’s code (design D8)', () => {
  assert.deepEqual(respond({ kind: 'ok', body: { a: 1 } }), { status: 200, headers: { 'cache-control': 'no-store' }, body: { a: 1 } })
  assert.equal(respond({ kind: 'ok', body: {}, status: 202 }).status, 202)
  assert.deepEqual(respond({ kind: 'invalid', message: 'no' }), { status: 400, body: { error: { code: 'invalid-request', message: 'no' } } })
  assert.equal(respond({ kind: 'not-found', message: 'no' }).status, 404)
  const handoff = { reason: 'target-dirty', warnings: [] }
  assert.deepEqual(respond({ kind: 'conflict', message: 'dirty', handoff }), { status: 409, body: { error: { code: 'conflict', message: 'dirty' }, handoff } })
  const late = respond({ kind: 'expired', handoff: { reason: 'expired', warnings: [] } })
  assert.equal(late.status, 410)
  assert.equal((late.body as { error: { code: string } }).error.code, 'conflict', 'ERROR_CODES is closed: 410 is `conflict` (v4.2)')
})

test('before the engine exists every handoff route is a 503', async () => {
  const routes = handoffRoutes(() => undefined)
  const response = await routes['GET /handoff/projects']!(request('GET', '/handoff/projects'))
  assert.equal(response.status, 503)
})

test('the ids arrive raw at the engine, which is the one that checks them (D13)', async () => {
  const seen: string[] = []
  const api: HandoffApi = {
    projects: async () => ({ kind: 'ok', body: [] }),
    sessionsCheck: async () => ({ kind: 'ok', body: [] }),
    startPreview: () => ({ kind: 'ok', body: { previewId: 'p' }, status: 202 }),
    preview: (id) => (seen.push(id), { kind: 'invalid', message: 'not an id' }),
  }
  const routes = handoffRoutes(() => api)
  const response = await routes['GET /handoff/preview/:previewId']!(request('GET', '/handoff/preview/../x', { params: { previewId: '../x' } }))
  assert.deepEqual(seen, ['../x'])
  assert.equal(response.status, 400)
  assert.equal((await routes['POST /handoff/preview']!(request('POST', '/handoff/preview', { body: { to: 'omarchy' } }))).status, 202)
})
