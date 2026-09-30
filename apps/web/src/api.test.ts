import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moduleApi, readResponse } from './api.ts'

type Failure = Error & { status?: number; body?: unknown }

async function failure(work: Promise<unknown>): Promise<Failure> {
  try {
    await work
  } catch (error) {
    return error as Failure
  }
  throw new Error('expected a failure')
}

test('a JSON answer is parsed', async () => {
  const response = new Response(JSON.stringify({ a: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
  assert.deepEqual(await readResponse(response), { a: 1 })
})

test('a JSON answer with an EMPTY body is undefined, not a SyntaxError (spec 2026-10-01, criterion 26)', async () => {
  const response = new Response('', { status: 200, headers: { 'content-type': 'application/json' } })
  assert.equal(await readResponse(response), undefined)
})

test('a 502 in plain text — tailscale serve with the daemon down — fails WITH its status (criterion 26)', async () => {
  const error = await failure(readResponse(new Response('Bad Gateway', { status: 502, headers: { 'content-type': 'text/plain' } })))
  assert.equal(error.status, 502)
  assert.equal(error.body, undefined)
  assert.equal(error.message, '502')
})

test('a JSON error keeps its message and its body, so a screen can read the conflict', async () => {
  const body = { error: { code: 'conflict', message: 'uploads are off' }, uploads: { off: 'spaces' } }
  const error = await failure(readResponse(new Response(JSON.stringify(body), { status: 409, headers: { 'content-type': 'application/json' } })))
  assert.equal(error.status, 409)
  assert.equal(error.message, 'uploads are off')
  assert.deepEqual(error.body, body)
})

test('a fetch that never gets an answer fails with status 0 (criterion 26)', async () => {
  const real = globalThis.fetch
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch')
  }
  try {
    const error = await failure(moduleApi('sessions').post('sessions/x/reply', { text: 'hola' }))
    assert.equal(error.status, 0)
  } finally {
    globalThis.fetch = real
  }
})

test('upload sends the bytes with no JSON content type, to the module’s own prefix, the query encoded', async () => {
  const real = globalThis.fetch
  const seen: { url: string; init: RequestInit | undefined }[] = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init })
    return new Response(JSON.stringify({ uploadId: 'u' }), { status: 201, headers: { 'content-type': 'application/json' } })
  }
  try {
    const file = new Blob([new Uint8Array([1, 2, 3])])
    assert.deepEqual(await moduleApi('sessions').upload('uploads', file, { name: 'a b&c.png' }), { uploadId: 'u' })
    assert.equal(seen[0]?.url, '/modules/sessions/uploads?name=a+b%26c.png')
    assert.equal(seen[0]?.init?.method, 'POST')
    assert.equal(seen[0]?.init?.body, file)
    assert.equal(seen[0]?.init?.headers, undefined)
  } finally {
    globalThis.fetch = real
  }
})
