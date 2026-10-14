import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { open, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { createServer as createHttpServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { MAX_BODY_BYTES, type Logger } from '@factotum/core'
import { createPeerTable, type PeerTable } from './peers.ts'
import { createPeerCalls, PEER_CALL_DEFAULT_MS, PEER_CALL_MAX_MS, type PeerCalls } from './peer-calls.ts'
import { timerSet } from '../modules/registry.ts'

/** Fixed and unique (CLAUDE.md §7), clear of boot (45_900+), peers (46_200+) and proxy (46_400+). */
let nextPort = 46_800
const takePort = () => (nextPort += 1)

interface Seen {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
}

type Answer = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Answer =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }

/** A peer that counts. With `keep: false` a body is hashed and dropped: 100 MB must not sit here. */
async function fakePeer(answer: Answer = json(200, { ok: true }), opts: { readonly keep?: boolean } = {}) {
  const port = takePort()
  const seen: Seen[] = []
  const streamed = { bytes: 0, sha256: '' }
  const peer = { seen, answer, port, streamed }
  const server: Server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = []
    const hash = createHash('sha256')
    try {
      for await (const chunk of req) {
        streamed.bytes += (chunk as Buffer).length
        hash.update(chunk as Buffer)
        if (opts.keep !== false) chunks.push(chunk as Buffer)
      }
    } catch {
      return
    }
    streamed.sha256 = hash.digest('hex')
    const body = Buffer.concat(chunks)
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
    peer.answer(req, res, body)
  })
  await new Promise<void>((resolve) => server.listen(port, 'localhost', resolve))
  const close = async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return { peer, close }
}

function capture() {
  const lines: string[] = []
  const log: Logger = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) }
  return { lines, log }
}

/** The real table with `reachable` decided by the test; `url` is the real one (design D3). */
function tableFor(port: number, state: { reachable: boolean }): Pick<PeerTable, 'list' | 'get' | 'url'> {
  const real = createPeerTable({ peers: [{ origin: `http://localhost:${port}` }], log: capture().log })
  const get = (name: string) => {
    const peer = real.get(name)
    return peer === undefined ? undefined : { ...peer, reachable: state.reachable }
  }
  return { get, url: real.url, list: () => real.list().map((peer) => ({ ...peer, reachable: state.reachable })) }
}

async function world(answer?: Answer, opts: { reachable?: boolean; keep?: boolean } = {}) {
  const fake = await fakePeer(answer, opts.keep === undefined ? {} : { keep: opts.keep })
  const state = { reachable: opts.reachable ?? true }
  const timers = timerSet()
  const { lines, log } = capture()
  const calls: PeerCalls = createPeerCalls({ table: tableFor(fake.peer.port, state), timers: timers.timers, log })
  const close = async () => {
    calls.abortAll()
    timers.disposeAll()
    await fake.close()
  }
  return { peer: fake.peer, calls, lines, state, close }
}

// ---------------------------------------------------------------------------
// json
// ---------------------------------------------------------------------------

test('json goes to /modules/<the calling module>/<path>, with no Origin, and gives back the JSON', async () => {
  const w = await world(json(200, { hello: 'twin' }))
  try {
    const answer = await w.calls.json('sessions', 'localhost', 'GET', 'handoff/projects')
    assert.deepEqual(answer, { ok: true, status: 200, body: { hello: 'twin' } })
    assert.equal(w.peer.seen[0]?.url, '/modules/sessions/handoff/projects')
    assert.equal(w.peer.seen[0]?.method, 'GET')
    assert.equal(w.peer.seen[0]?.headers['origin'], undefined)
  } finally {
    await w.close()
  }
})

test('a POST sends its body as JSON', async () => {
  const w = await world(json(200, { ok: true }))
  try {
    await w.calls.json('sessions', 'localhost', 'POST', 'handoff/x/y/prepare', { key: 'k', ids: [1] })
    assert.equal(w.peer.seen[0]?.method, 'POST')
    assert.equal(w.peer.seen[0]?.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(w.peer.seen[0]?.body.toString('utf8') ?? ''), { key: 'k', ids: [1] })
  } finally {
    await w.close()
  }
})

test('the module id is the one the caller is bound to: another module’s routes are never reached', async () => {
  const w = await world()
  try {
    await w.calls.json('inbox', 'localhost', 'GET', 'digest')
    assert.equal(w.peer.seen[0]?.url, '/modules/inbox/digest')
  } finally {
    await w.close()
  }
})

test('a 3xx is `http` and is never followed', async () => {
  const w = await world((_req, res) => {
    res.writeHead(302, { location: 'http://evil.example/' })
    res.end()
  })
  try {
    const answer = await w.calls.json('sessions', 'localhost', 'GET', 'x')
    assert.equal(answer.ok, false)
    assert.equal(answer.ok ? undefined : answer.reason, 'http')
    assert.equal(answer.status, 302)
    assert.equal(w.peer.seen.length, 1)
  } finally {
    await w.close()
  }
})

test('a 409 or a 410 with a JSON body gives that body back, to be read by the module (design D4)', async () => {
  for (const status of [409, 410]) {
    const refusal = { error: { code: 'conflict', message: 'no' }, handoff: { reason: 'target-dirty', warnings: [] } }
    const w = await world(json(status, refusal))
    try {
      const answer = await w.calls.json('sessions', 'localhost', 'POST', 'handoff/h/s/commit', {})
      assert.deepEqual(answer, { ok: false, status, reason: 'http', body: refusal })
    } finally {
      await w.close()
    }
  }
})

test('a refusal that is not JSON has no body', async () => {
  const w = await world((_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('boom')
  })
  try {
    assert.deepEqual(await w.calls.json('sessions', 'localhost', 'GET', 'x'), { ok: false, status: 500, reason: 'http', body: undefined })
  } finally {
    await w.close()
  }
})

test('a path with .., an escape or an empty segment is refused WITHOUT calling the peer', async () => {
  const w = await world()
  try {
    for (const path of ['../push/relay', 'a/../../push', 'a/%2e%2e/b', 'a//b', 'a\\b', '%2F%2Fevil']) {
      const answer = await w.calls.json('sessions', 'localhost', 'GET', path)
      assert.equal(answer.ok, false, path)
      assert.equal(answer.ok ? undefined : answer.reason, 'refused', path)
    }
    assert.equal(w.peer.seen.length, 0)
  } finally {
    await w.close()
  }
})

test('a peer the probe has down, or one that is not declared, is `unreachable` and is not called', async () => {
  const w = await world(json(200, {}), { reachable: false })
  try {
    assert.deepEqual(await w.calls.json('sessions', 'localhost', 'GET', 'x'), { ok: false, status: undefined, reason: 'unreachable', body: undefined })
    assert.deepEqual(await w.calls.json('sessions', 'nobody', 'GET', 'x'), { ok: false, status: undefined, reason: 'unreachable', body: undefined })
    assert.equal(w.peer.seen.length, 0)
  } finally {
    await w.close()
  }
})

test('a peer whose socket is closed is `unreachable`, never a throw', async () => {
  const w = await world()
  await w.close()
  const timers = timerSet()
  try {
    const calls = createPeerCalls({ table: tableFor(w.peer.port, { reachable: true }), timers: timers.timers, log: capture().log })
    const answer = await calls.json('sessions', 'localhost', 'GET', 'x')
    assert.equal(answer.ok ? undefined : answer.reason, 'unreachable')
  } finally {
    timers.disposeAll()
  }
})

test('no answer in time is `timeout`', async () => {
  const w = await world(() => undefined)
  try {
    const answer = await w.calls.json('sessions', 'localhost', 'GET', 'x', undefined, { timeoutMs: 100 })
    assert.equal(answer.ok ? undefined : answer.reason, 'timeout')
  } finally {
    await w.close()
  }
})

test('the timeout defaults to 10 s and never exceeds PEER_CALL_MAX_MS', async () => {
  assert.equal(PEER_CALL_DEFAULT_MS, 10_000)
  assert.equal(PEER_CALL_MAX_MS, 300_000)
  const armed: number[] = []
  const timers = timerSet()
  const spy = {
    setTimeout: (fn: () => void, ms: number) => (armed.push(ms), timers.timers.setTimeout(fn, ms)),
    setInterval: timers.timers.setInterval,
  }
  const fake = await fakePeer()
  try {
    const calls = createPeerCalls({ table: tableFor(fake.peer.port, { reachable: true }), timers: spy, log: capture().log })
    await calls.json('sessions', 'localhost', 'GET', 'x')
    await calls.json('sessions', 'localhost', 'GET', 'x', undefined, { timeoutMs: 3_600_000 })
    await calls.json('sessions', 'localhost', 'GET', 'x', undefined, { timeoutMs: 120_000 })
    assert.deepEqual(armed, [10_000, 300_000, 120_000])
  } finally {
    timers.disposeAll()
    await fake.close()
  }
})

test('a 2xx that is not JSON, or is over MAX_BODY_BYTES, is `bad-json`', async () => {
  const notJson = await world((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>')
  })
  try {
    const answer = await notJson.calls.json('sessions', 'localhost', 'GET', 'x')
    assert.deepEqual(answer, { ok: false, status: 200, reason: 'bad-json', body: undefined })
  } finally {
    await notJson.close()
  }
  const huge = await world((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES) }))
  })
  try {
    const answer = await huge.calls.json('sessions', 'localhost', 'GET', 'x')
    assert.equal(answer.ok ? undefined : answer.reason, 'bad-json')
  } finally {
    await huge.close()
  }
})

test('the log carries the shape of the route only, never the rest of it (criterion 36)', async () => {
  const w = await world(json(200, {}))
  try {
    await w.calls.json('sessions', 'localhost', 'POST', 'handoff/secret-token-123/site/commit', { said: 'PALABRA-SEMBRADA' })
    const all = w.lines.join('\n')
    assert.match(all, /^peers POST localhost \/modules\/sessions\/… → 200 \d+ms$/m)
    assert.doesNotMatch(all, /secret-token-123|PALABRA-SEMBRADA|handoff/)
  } finally {
    await w.close()
  }
})

test('list() is the table’s view: name and reachable, nothing more', async () => {
  const w = await world()
  try {
    assert.deepEqual(w.calls.list(), [{ name: 'localhost', reachable: true }])
    w.state.reachable = false
    assert.deepEqual(w.calls.list(), [{ name: 'localhost', reachable: false }])
  } finally {
    await w.close()
  }
})

// ---------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------

async function tempFile(bytes: Buffer | number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'factotum-peer-calls-'))
  const path = join(dir, 'file.bin')
  if (typeof bytes !== 'number') {
    await writeFile(path, bytes)
    return path
  }
  // Written in chunks: a 100 MB file must not be built in memory to be tested.
  const handle = await open(path, 'w')
  const chunk = Buffer.alloc(1024 * 1024, 7)
  for (let written = 0; written < bytes; written += chunk.length) await handle.write(chunk, 0, Math.min(chunk.length, bytes - written))
  await handle.close()
  return path
}

test('upload streams the file as octet-stream with its length, and reads the JSON answer', async () => {
  const w = await world(json(201, { stored: true }))
  try {
    const path = await tempFile(Buffer.from('hello twin'))
    const answer = await w.calls.upload('sessions', 'localhost', 'handoff/h/s/file/0', path)
    assert.deepEqual(answer, { ok: true, status: 201, body: { stored: true } })
    const seen = w.peer.seen[0]
    assert.equal(seen?.url, '/modules/sessions/handoff/h/s/file/0')
    assert.equal(seen?.method, 'POST')
    assert.equal(seen?.headers['content-type'], 'application/octet-stream')
    assert.equal(seen?.headers['content-length'], '10')
    assert.equal(seen?.headers['origin'], undefined)
    assert.equal(seen?.body.toString('utf8'), 'hello twin')
  } finally {
    await w.close()
  }
})

test('an upload refused with a JSON body gives that body back; one without JSON, none', async () => {
  const refusal = { error: { code: 'conflict', message: 'late' }, handoff: { reason: 'expired', warnings: [] } }
  const w = await world(json(410, refusal))
  try {
    const path = await tempFile(Buffer.from('x'))
    assert.deepEqual(await w.calls.upload('sessions', 'localhost', 'f', path), { ok: false, status: 410, reason: 'http', body: refusal })
    w.peer.answer = (_req, res) => {
      res.writeHead(400)
      res.end('nope')
    }
    assert.deepEqual(await w.calls.upload('sessions', 'localhost', 'f', path), { ok: false, status: 400, reason: 'http', body: undefined })
  } finally {
    await w.close()
  }
})

test('an upload to a refused path or a peer that is down never opens the file and never calls', async () => {
  const w = await world(json(200, {}), { reachable: false })
  try {
    const answer = await w.calls.upload('sessions', 'localhost', 'f', '/nonexistent/file')
    assert.equal(answer.ok ? undefined : answer.reason, 'unreachable')
    w.state.reachable = true
    const refused = await w.calls.upload('sessions', 'localhost', '../x', '/nonexistent/file')
    assert.equal(refused.ok ? undefined : refused.reason, 'refused')
    assert.equal(w.peer.seen.length, 0)
  } finally {
    await w.close()
  }
})

test('an upload of a file that does not exist never throws, and nothing is sent', async () => {
  const w = await world()
  try {
    const answer = await w.calls.upload('sessions', 'localhost', 'f', join(tmpdir(), 'factotum-no-such-file-' + Date.now()))
    assert.deepEqual(answer, { ok: false, status: undefined, reason: 'refused', body: undefined })
    assert.equal(w.peer.seen.length, 0)
  } finally {
    await w.close()
  }
})

/** The file descriptors this process holds, by path. A leaked one keeps the file open. */
async function openCount(): Promise<number> {
  const { readdir } = await import('node:fs/promises')
  try {
    return (await readdir('/dev/fd')).length
  } catch {
    return 0
  }
}

test('the file is closed when the peer fails halfway', async () => {
  // A peer that cuts the socket at the first bytes of the body: the request fails mid-body.
  const port = takePort()
  const server: Server = createHttpServer((req) => req.once('data', () => req.socket.destroy()))
  await new Promise<void>((resolve) => server.listen(port, 'localhost', resolve))
  const timers = timerSet()
  try {
    const calls = createPeerCalls({ table: tableFor(port, { reachable: true }), timers: timers.timers, log: capture().log })
    const path = await tempFile(4 * 1024 * 1024)
    const before = await openCount()
    for (let i = 0; i < 5; i += 1) {
      const answer = await calls.upload('sessions', 'localhost', 'f', path, { timeoutMs: 2_000 })
      assert.equal(answer.ok, false)
    }
    // Give the closes their tick.
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok((await openCount()) <= before, 'no descriptor leaked')
  } finally {
    timers.disposeAll()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('100 MB go up with the live memory peak under 64 MB (criterion 33, the kernel’s side)', async () => {
  const SIZE = 100 * 1024 * 1024
  const w = await world(json(200, { ok: true }), { keep: false })
  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc') as () => void
  const memory = () => {
    gc()
    const m = process.memoryUsage()
    return m.heapUsed + m.arrayBuffers
  }
  try {
    const path = await tempFile(SIZE)
    const before = memory()
    let peak = before
    const sampler = setInterval(() => (peak = Math.max(peak, memory())), 5)
    const answer = await w.calls.upload('sessions', 'localhost', 'big', path, { timeoutMs: 120_000 })
    clearInterval(sampler)
    assert.equal(answer.ok, true)
    assert.equal(w.peer.streamed.bytes, SIZE)
    const grew = peak - before
    assert.ok(grew < 64 * 1024 * 1024, `memory grew by ${Math.round(grew / 1024 / 1024)} MB for a 100 MB file`)
  } finally {
    await w.close()
  }
})

// ---------------------------------------------------------------------------
// Stopping
// ---------------------------------------------------------------------------

test('a call in flight when the daemon stops ends as { ok: false } at once, without waiting for the peer', async () => {
  const w = await world(() => undefined)
  try {
    const pending = w.calls.json('sessions', 'localhost', 'GET', 'x', undefined, { timeoutMs: 60_000 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const started = performance.now()
    w.calls.abortAll()
    const answer = await pending
    assert.equal(answer.ok, false)
    assert.ok(performance.now() - started < 1_000)
    const path = await tempFile(Buffer.from('x'))
    const upload = w.calls.upload('sessions', 'localhost', 'f', path, { timeoutMs: 60_000 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    w.calls.abortAll()
    assert.equal((await upload).ok, false)
  } finally {
    await w.close()
  }
})
