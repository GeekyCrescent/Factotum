import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { join } from 'node:path'
import { createServer as createHttpServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Logger } from '@factotum/core'
import { createServer } from './server.ts'
import { createProxy, PROXY_POST_TIMEOUT_MS, PROXY_TIMEOUT_MS, PROXY_UPLOAD_TIMEOUT_MS, type ProxyTimeouts } from './proxy.ts'
import { policyFor } from '../net/policy.ts'
import { createPeerTable, type PeerTable } from '../net/peers.ts'
import { Registry, timerSet } from '../modules/registry.ts'
import { statePaths } from '../config/paths.ts'
import { REFUSED_RESTS } from '../test-support.ts'

const PUBLIC = 'https://mimac.tail1234.ts.net'
const FOREIGN = 'https://evil.example'

/** Fixed and unique (CLAUDE.md §7), clear of boot.test.ts (45_900+) and peers.test.ts (46_200+). */
let nextPort = 46_400
const takePort = () => (nextPort += 1)

// ---------------------------------------------------------------------------
// The world: a fake peer that counts, and this daemon with the proxy in front of it
// ---------------------------------------------------------------------------

interface Seen {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
}

type Answer = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }) as Answer

/** Listens on `localhost`, the resolver `fetch` uses (design D2). Reads every body to its end. */
async function fakePeer(answer: Answer = json(200, { ok: true }), opts: { readonly keep?: boolean } = {}) {
  const port = takePort()
  const seen: Seen[] = []
  /** With `keep: false` the body is hashed and dropped — a 50 MB test must not hold 50 MB here. */
  const streamed = { bytes: 0, sha256: '', firstByteAt: 0 }
  const peer = { seen, answer, port, streamed }
  const server: Server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = []
    const hash = createHash('sha256')
    for await (const chunk of req) {
      if (streamed.firstByteAt === 0) streamed.firstByteAt = performance.now()
      streamed.bytes += (chunk as Buffer).length
      hash.update(chunk as Buffer)
      if (opts.keep !== false) chunks.push(chunk as Buffer)
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

/** The peer table with `reachable` decided by the test; `url` is the real one (design D3). */
function peersFor(port: number, state: { reachable: boolean }): Pick<PeerTable, 'get' | 'url' | 'list'> {
  const real = createPeerTable({ peers: [{ origin: `http://localhost:${port}` }], log: capture().log })
  const get = (name: string) => {
    const peer = real.get(name)
    return peer === undefined ? undefined : { ...peer, reachable: state.reachable }
  }
  return { get, url: real.url, list: () => real.list().map((p) => ({ ...p, reachable: state.reachable })) }
}

async function daemon(peerPort: number, opts: { reachable?: boolean; ready?: boolean; timeouts?: Partial<ProxyTimeouts> } = {}) {
  const state = { reachable: opts.reachable ?? true }
  const { lines, log } = capture()
  const timers = timerSet()
  const peers = peersFor(peerPort, state)
  const proxy = createProxy({ peers, timers: timers.timers, log, ...(opts.timeouts !== undefined ? { timeouts: opts.timeouts } : {}) })
  const home = await mkdtemp(join(tmpdir(), 'factotum-proxy-'))
  const registry = await Registry.create([], {
    paths: statePaths('prod', home),
    env: 'prod',
    push: { canReach: () => false, send: async () => undefined },
  })
  const port = takePort()
  const server = createServer({
    registry,
    origin: policyFor({ publicOrigin: PUBLIC, address: '127.0.0.1', port, extraOrigins: [] }),
    env: 'prod',
    version: 'test',
    startedAt: Date.now(),
    push: { publicKey: () => undefined, subscribe: async () => ({ kind: 'off', reason: 'off' }), count: () => 0, relay: async () => undefined },
    machine: 'mimac',
    peers,
    proxy,
    interfaces: (() => ({})) as never,
    isReady: () => opts.ready ?? true,
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  const close = async () => {
    proxy.abortAll()
    timers.disposeAll()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return { base: `http://127.0.0.1:${port}`, port, lines, state, proxy, close }
}

/**
 * A request with its path EXACTLY as written. `fetch` would resolve `..`, turn `\` into `/` and
 * re-encode — the very shapes criterion 6 is about would never leave the test.
 */
function raw(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: init.headers ?? {} }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(init.body)
  })
}

async function world(answer?: Answer, opts: Parameters<typeof daemon>[1] = {}) {
  const fake = await fakePeer(answer)
  const self = await daemon(fake.peer.port, opts)
  return {
    peer: fake.peer,
    self,
    close: async () => {
      await self.close()
      await fake.close()
    },
  }
}

const delayed = (ms: number, then: Answer): Answer => (req, res, body) => void setTimeout(() => then(req, res, body), ms)

// ---------------------------------------------------------------------------
// B6a — JSON
// ---------------------------------------------------------------------------

test('the timeouts are the ones design D3 names', () => {
  assert.equal(PROXY_TIMEOUT_MS, 10_000)
  assert.equal(PROXY_POST_TIMEOUT_MS, 60_000)
  assert.equal(PROXY_UPLOAD_TIMEOUT_MS, 120_000)
})

test('a GET reaches the peer as the same route, with no body, and its answer comes back (criterion 5)', async () => {
  const w = await world(json(200, { sessions: [1, 2] }))
  try {
    const response = await fetch(`${w.self.base}/peers/localhost/modules/sessions/sessions?page=0`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { sessions: [1, 2] })
    assert.equal(w.peer.seen.length, 1)
    assert.equal(w.peer.seen[0]?.method, 'GET')
    assert.equal(w.peer.seen[0]?.url, '/modules/sessions/sessions?page=0')
    assert.equal(w.peer.seen[0]?.body.length, 0)
  } finally {
    await w.close()
  }
})

test('the peer’s /health passes too', async () => {
  const w = await world(json(200, { version: 'x', ready: true }))
  try {
    const response = await fetch(`${w.self.base}/peers/localhost/health`)
    assert.equal(response.status, 200)
    assert.equal(w.peer.seen[0]?.url, '/health')
  } finally {
    await w.close()
  }
})

test('a POST JSON body arrives byte for byte, and the peer’s status comes back as it was', async () => {
  const w = await world(json(409, { error: { code: 'conflict', message: 'busy' } }))
  try {
    const body = JSON.stringify({ prompt: 'hello', siteId: 'personal' })
    const response = await fetch(`${w.self.base}/peers/localhost/modules/sessions/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: { code: 'conflict', message: 'busy' } })
    assert.equal(w.peer.seen[0]?.method, 'POST')
    assert.equal(w.peer.seen[0]?.body.toString('utf8'), body)
  } finally {
    await w.close()
  }
})

test('only the request headers of design D3 travel, and the peer is asked for no compression', async () => {
  const w = await world()
  try {
    await raw(w.self.port, '/peers/localhost/modules/sessions/sessions', {
      method: 'POST',
      body: '{"a":1}',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'content-length': '7',
        origin: PUBLIC,
        cookie: 'session=secret',
        forwarded: 'for=1.2.3.4',
        'x-forwarded-for': '1.2.3.4',
        authorization: 'Bearer nope',
        'accept-encoding': 'gzip, br',
        'x-anything': 'else',
      },
    })
    const headers = w.peer.seen[0]?.headers ?? {}
    assert.equal(headers['content-type'], 'application/json')
    assert.equal(headers['accept'], 'application/json')
    assert.equal(headers['content-length'], '7')
    assert.equal(headers['accept-encoding'], 'identity')
    for (const name of ['origin', 'cookie', 'forwarded', 'x-forwarded-for', 'authorization', 'x-anything']) {
      assert.equal(headers[name], undefined, name)
    }
    // Host is the peer's own, never the one the browser sent.
    assert.equal(headers['host'], `localhost:${w.peer.port}`)
  } finally {
    await w.close()
  }
})

test('only the response headers of design D3 come back, and never content-length', async () => {
  const w = await world((_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': '2',
      'cache-control': 'no-store',
      'set-cookie': 'a=b',
      'access-control-allow-origin': '*',
      'x-powered-by': 'peer',
      location: '/elsewhere',
    })
    res.end('{}')
  })
  try {
    const response = await raw(w.self.port, '/peers/localhost/modules/sessions/sessions')
    assert.equal(response.status, 200)
    assert.equal(response.body, '{}')
    assert.equal(response.headers['content-type'], 'application/json')
    assert.equal(response.headers['cache-control'], 'no-store')
    for (const name of ['content-length', 'set-cookie', 'access-control-allow-origin', 'x-powered-by', 'location']) {
      assert.equal(response.headers[name], undefined, name)
    }
  } finally {
    await w.close()
  }
})

test('an unknown Origin gets 403 and the peer is called zero times (criterion 8)', async () => {
  const w = await world()
  try {
    const get = await fetch(`${w.self.base}/peers/localhost/modules/sessions/sessions`, { headers: { origin: FOREIGN } })
    assert.equal(get.status, 403)
    const post = await fetch(`${w.self.base}/peers/localhost/modules/sessions/sessions`, {
      method: 'POST',
      headers: { origin: FOREIGN, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(post.status, 403)
    assert.equal(w.peer.seen.length, 0)
  } finally {
    await w.close()
  }
})

test('the accepted Origin passes, and is not forwarded', async () => {
  const w = await world()
  try {
    const response = await fetch(`${w.self.base}/peers/localhost/health`, { headers: { origin: PUBLIC } })
    assert.equal(response.status, 200)
    assert.equal(w.peer.seen[0]?.headers['origin'], undefined)
  } finally {
    await w.close()
  }
})

test('THE TABLE OF CRITERION 6, through the whole proxy: 404 for every row, and the peer called zero times', async () => {
  const w = await world()
  try {
    for (const rest of REFUSED_RESTS) {
      for (const method of ['GET', 'POST']) {
        const response = await raw(w.self.port, `/peers/localhost${rest}`, { method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) })
        assert.equal(response.status, 404, `${method} ${rest}`)
        assert.doesNotMatch(response.body, /<title>/, rest)
      }
    }
    assert.equal(w.peer.seen.length, 0)
  } finally {
    await w.close()
  }
})

test('the prefix is read raw: an escaped or unknown name is 404, never resolved', async () => {
  const w = await world()
  try {
    for (const path of [
      '/peers/l%6fcalhost/health',
      '/peers/LOCALHOST/health',
      '/peers/omarchy/health',
      '/peers/localhost',
      '/peers/localhost?x=/health',
      '/peers//localhost/health',
      '/peers',
      '/peers/',
      '/x/../peers/localhost/health',
    ]) {
      const response = await raw(w.self.port, path)
      assert.notEqual(response.status, 200, path)
      assert.doesNotMatch(response.body, /<title>/, path)
    }
    assert.equal(w.peer.seen.length, 0)
  } finally {
    await w.close()
  }
})

test('a query with %2F passes untouched: the search for a text with a slash (criterion 6)', async () => {
  const w = await world()
  try {
    const response = await raw(w.self.port, '/peers/localhost/modules/sessions/search?q=src%2Fapp')
    assert.equal(response.status, 200)
    assert.equal(w.peer.seen[0]?.url, '/modules/sessions/search?q=src%2Fapp')
  } finally {
    await w.close()
  }
})

test('a method the modules do not use is refused without calling', async () => {
  const w = await world()
  try {
    for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      assert.equal((await raw(w.self.port, '/peers/localhost/health', { method })).status, 404, method)
    }
    assert.equal(w.peer.seen.length, 0)
  } finally {
    await w.close()
  }
})

test('a redirect from the peer is never followed: it arrives as 502', async () => {
  const w = await world((_req, res) => res.writeHead(302, { location: `http://localhost:${1}/x` }).end())
  try {
    const response = await fetch(`${w.self.base}/peers/localhost/modules/sessions/sessions`)
    assert.equal(response.status, 502)
    const body = (await response.json()) as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'peer-unreachable')
    assert.equal(w.peer.seen.length, 1)
  } finally {
    await w.close()
  }
})

test('a peer marked unreachable gets 502 peer-unreachable with its name, and no call (criterion 9)', async () => {
  const w = await world(undefined, { reachable: false })
  try {
    const response = await fetch(`${w.self.base}/peers/localhost/modules/sessions/sessions`)
    assert.equal(response.status, 502)
    const body = (await response.json()) as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'peer-unreachable')
    assert.match(body.error.message, /localhost/)
    assert.equal(w.peer.seen.length, 0)
  } finally {
    await w.close()
  }
})

test('a peer that has gone while still marked reachable: 502, not a hang', async () => {
  const fake = await fakePeer()
  const self = await daemon(fake.peer.port)
  await fake.close()
  try {
    const response = await fetch(`${self.base}/peers/localhost/health`)
    assert.equal(response.status, 502)
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'peer-unreachable')
  } finally {
    await self.close()
  }
})

test('before READY the proxy answers 503 and calls nobody', async () => {
  const w = await world(undefined, { ready: false })
  try {
    assert.equal((await fetch(`${w.self.base}/peers/localhost/health`)).status, 503)
    assert.equal(w.peer.seen.length, 0)
  } finally {
    await w.close()
  }
})

test('a POST JSON slower than a GET may be arrives; one past the POST timeout is a 502 (design D3)', async () => {
  // Scaled: in production 30 s arrives and 70 s does not, against 60 s.
  const timeouts = { read: 100, json: 600, upload: 2_000 }
  const post = (base: string) =>
    fetch(`${base}/peers/localhost/modules/sessions/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })

  const slow = await world(delayed(300, json(200, { launched: true })), { timeouts })
  try {
    const response = await post(slow.self.base)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { launched: true })
  } finally {
    await slow.close()
  }

  const tooSlow = await world(delayed(1_400, json(200, { launched: true })), { timeouts })
  try {
    const response = await post(tooSlow.self.base)
    assert.equal(response.status, 502)
    const body = (await response.json()) as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'peer-unreachable')
    assert.match(body.error.message, /600ms/)
  } finally {
    await tooSlow.close()
  }
})

test('a GET has the read timeout, the shortest', async () => {
  const w = await world(delayed(400, json(200, {})), { timeouts: { read: 100, json: 2_000, upload: 2_000 } })
  try {
    assert.equal((await fetch(`${w.self.base}/peers/localhost/health`)).status, 502)
  } finally {
    await w.close()
  }
})

test('abortAll ends every request in flight, so stopping cannot wait on a sleeping peer', async () => {
  const w = await world(() => undefined)
  try {
    const pending = fetch(`${w.self.base}/peers/localhost/health`)
    while (w.peer.seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    w.self.proxy.abortAll()
    assert.equal((await pending).status, 502)
  } finally {
    await w.close()
  }
})

// ---------------------------------------------------------------------------
// B6b — uploads, attachments, and the log
// ---------------------------------------------------------------------------

test('an upload streams to the peer byte for byte, with the upload timeout and not the JSON one', async () => {
  // Slower than the JSON timeout, inside the upload one: only `content-type` decides which.
  const timeouts = { read: 50, json: 100, upload: 2_000 }
  const w = await world(delayed(300, json(200, { uploadId: 'u1' })), { timeouts })
  try {
    const photo = Buffer.alloc(3 * 1024 * 1024, 7)
    for (const headers of [{ 'content-type': 'image/jpeg' }, {} as Record<string, string>]) {
      const response = await raw(w.self.port, '/peers/localhost/modules/sessions/uploads?name=a.jpg', { method: 'POST', headers, body: photo })
      assert.equal(response.status, 200, JSON.stringify(headers))
      assert.deepEqual(JSON.parse(response.body), { uploadId: 'u1' })
    }
    assert.equal(w.peer.seen.length, 2)
    assert.ok(w.peer.seen.every((s) => s.body.equals(photo)))
    assert.equal(w.peer.seen[0]?.headers['content-type'], 'image/jpeg')
  } finally {
    await w.close()
  }
})

test('an attachment from the peer keeps its containment headers and its bytes (criterion 8)', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  const w = await world((_req, res) => {
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(png.length),
      'cache-control': 'private, no-store',
      'content-disposition': 'inline; filename="a.png"',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
    })
    res.end(png)
  })
  try {
    const response = await fetch(`${w.self.base}/peers/localhost/modules/sessions/uploads/u1/a.png`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox")
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('content-disposition'), 'inline; filename="a.png"')
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal(response.headers.get('content-length'), null)
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(png))
  } finally {
    await w.close()
  }
})

test('50 MB go through without being held: the peer reads before the browser has finished, and the memory peak stays below the body', async () => {
  const SIZE = 50 * 1024 * 1024
  const CHUNK = 64 * 1024
  const fake = await fakePeer(json(200, { ok: true }), { keep: false })
  const self = await daemon(fake.peer.port)
  // LIVE memory, not garbage: without a collection the chunks already passed along pile up until
  // the GC runs, and the peak measured the GC's timing (60 MB alone, less in the full file).
  // The runner cannot take `--expose-gc`, so the flag is set from here.
  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc') as () => void
  const memory = () => {
    gc()
    const m = process.memoryUsage()
    return m.heapUsed + m.arrayBuffers
  }
  const before = memory()
  let peak = before
  const sampler = setInterval(() => (peak = Math.max(peak, memory())), 5)
  try {
    let sentAll = 0
    // Fresh buffers, written with backpressure: a reused one would hide a copy held anywhere.
    const req = request({
      host: '127.0.0.1',
      port: self.port,
      method: 'POST',
      path: '/peers/localhost/modules/sessions/uploads?name=big.bin',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(SIZE) },
    })
    const answered = new Promise<number>((resolve, reject) => {
      req.on('response', (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      req.on('error', reject)
    })
    for (let sent = 0; sent < SIZE; sent += CHUNK) {
      if (!req.write(Buffer.alloc(CHUNK, 1))) await once(req, 'drain')
    }
    sentAll = performance.now()
    req.end()
    const status = await answered
    clearInterval(sampler)
    const expected = createHash('sha256')
    for (let sent = 0; sent < SIZE; sent += CHUNK) expected.update(Buffer.alloc(CHUNK, 1))

    assert.equal(status, 200)
    assert.equal(fake.peer.streamed.bytes, SIZE)
    assert.equal(fake.peer.streamed.sha256, expected.digest('hex'))
    // Streaming, shown two ways: the peer had bytes before the last one was sent…
    assert.ok(fake.peer.streamed.firstByteAt < sentAll, 'the peer read before the browser finished')
    // …and the process never held anything like the body. Measured on the Mac: a few MB through
    // `node:http`, against the whole 50 MB through `fetch` (see `forward` in proxy.ts).
    const grew = peak - before
    assert.ok(grew < SIZE / 2, `memory grew by ${Math.round(grew / 1024 / 1024)} MB for a 50 MB body`)
  } finally {
    clearInterval(sampler)
    await self.close()
    await fake.close()
  }
})

test('THE LOG CARRIES THE SHAPE OF THE ROUTE AND NOTHING ELSE: no token from the path, no body (criterion 36)', async () => {
  const TOKEN = 'ask-7f3a9c1e-SEEDED-TOKEN'
  const PHRASE = 'the purple elephant sings at midnight'
  const w = await world(json(200, { answered: true }))
  try {
    const response = await fetch(`${w.self.base}/peers/localhost/modules/sessions/asks/${TOKEN}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: PHRASE }),
    })
    assert.equal(response.status, 200)
    await fetch(`${w.self.base}/peers/localhost/health`)
    await raw(w.self.port, `/peers/localhost/modules/../asks/${TOKEN}`, { method: 'POST', body: PHRASE })

    const log = w.self.lines.join('\n')
    assert.ok(!log.includes(TOKEN), log)
    assert.ok(!log.includes(PHRASE), log)
    assert.ok(!log.includes('asks'), log)
    assert.match(w.self.lines[0] ?? '', /^proxy POST localhost \/modules\/sessions\/… → 200 \d+ms$/)
    assert.match(w.self.lines[1] ?? '', /^proxy GET localhost \/health → 200 \d+ms$/)
    assert.match(w.self.lines[2] ?? '', /^proxy POST refused → 404$/)
  } finally {
    await w.close()
  }
})

test('a GET never carries a content-length to the peer: no body is sent, so none may be announced', async () => {
  // A GET announcing 100 bytes and sending none would leave the peer waiting for them — and on a
  // kept-alive connection, reading the NEXT request as this one's body.
  const w = await world()
  try {
    const response = await raw(w.self.port, '/peers/localhost/health', { headers: { 'content-length': '0' } })
    assert.equal(response.status, 200)
    assert.equal(w.peer.seen[0]?.headers['content-length'], undefined)
    // And the next request on the same agent arrives as itself.
    assert.equal((await raw(w.self.port, '/peers/localhost/modules/sessions/sessions')).status, 200)
    assert.equal(w.peer.seen[1]?.url, '/modules/sessions/sessions')
  } finally {
    await w.close()
  }
})
