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

/** An API that records every call and answers `ok`, except `preview`, which refuses. */
function recorder() {
  const calls: string[] = []
  const answer = (name: string) => async (...args: unknown[]) => (calls.push(`${name} ${JSON.stringify(args)}`), { kind: 'ok', body: {} } as const)
  const api: HandoffApi = {
    startPreview: (body) => (calls.push(`startPreview ${JSON.stringify([body])}`), { kind: 'ok', body: { previewId: 'p' }, status: 202 }),
    preview: (id) => (calls.push(`preview ${JSON.stringify([id])}`), { kind: 'invalid', message: 'not an id' }),
    start: answer('start'),
    report: answer('report'),
    keep: answer('keep'),
    projects: answer('projects'),
    sessionsCheck: answer('sessionsCheck'),
    prepare: answer('prepare'),
    manifest: answer('manifest'),
    file: answer('file'),
    commit: answer('commit'),
    abort: answer('abort'),
    done: answer('done'),
    status: answer('status'),
  }
  return { api, calls }
}

test('the ids arrive raw at the engine, which is the one that checks them (D13)', async () => {
  const { api, calls } = recorder()
  const routes = handoffRoutes(() => api)
  const response = await routes['GET /handoff/preview/:previewId']!(request('GET', '/handoff/preview/../x', { params: { previewId: '../x' } }))
  assert.deepEqual(calls, ['preview ["../x"]'])
  assert.equal(response.status, 400)
  assert.equal((await routes['POST /handoff/preview']!(request('POST', '/handoff/preview', { body: { to: 'omarchy' } }))).status, 202)
  assert.equal((await routes['GET /handoff/:hid']!(request('GET', '/handoff/h', { params: { hid: '../h' } }))).status, 200)
  assert.equal(calls.at(-1), 'report ["../h"]')
})

test('a :siteId that is not one is a 400 here, and the engine never hears of it', async () => {
  const { api, calls } = recorder()
  const routes = handoffRoutes(() => api)
  for (const name of ['prepare', 'manifest', 'commit', 'abort', 'done', 'keep']) {
    const response = await routes[`POST /handoff/:hid/:siteId/${name}`]!(request('POST', `/handoff/h/x/${name}`, { params: { hid: 'h', siteId: '../x' } }))
    assert.equal(response.status, 400, name)
  }
  assert.equal((await routes['GET /handoff/:hid/:siteId/status']!(request('GET', '/handoff/h/X/status', { params: { hid: 'h', siteId: 'X' } }))).status, 400)
  assert.deepEqual(calls, [])
  await routes['POST /handoff/:hid/:siteId/commit']!(request('POST', '/handoff/h/vault/commit', { params: { hid: 'h', siteId: 'vault' } }))
  assert.deepEqual(calls, ['commit ["h","vault"]'])
})

test('a file of the manifest comes through an upload route at the kernel’s ceiling, and its path reaches the engine', async () => {
  const { api, calls } = recorder()
  const routes = handoffRoutes(() => api)
  const route = routes['POST /handoff/:hid/:siteId/file/:n']! as unknown as { upload?: { maxBytes: number } } & ((req: ModuleRequest) => Promise<unknown>)
  assert.equal(route.upload?.maxBytes, 256 * 1024 * 1024)
  await route(request('POST', '/handoff/h/vault/file/0', { params: { hid: 'h', siteId: 'vault', n: '0' }, file: { path: '/state/.incoming/x', bytes: 3 } }))
  assert.deepEqual(calls, ['file ["h","vault","0",{"path":"/state/.incoming/x","bytes":3}]'])
})
