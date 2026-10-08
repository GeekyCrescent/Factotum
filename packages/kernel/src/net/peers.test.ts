import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Logger } from '@factotum/core'
import { createPeerTable, machineName, PEER_DOWN_AFTER, PEER_PROBE_MS, PEER_PROBE_TIMEOUT_MS } from './peers.ts'
import { timerSet } from '../modules/registry.ts'
import { REFUSED_RESTS } from '../test-support.ts'

const MAC = 'https://juans-macbook-pro.tailbd0167.ts.net:8443'

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

const table = (origins: readonly string[] = [MAC]) =>
  createPeerTable({ peers: origins.map((origin) => ({ origin })), log: silent })

// ---------------------------------------------------------------------------
// machineName: one place, because a host's name is its key everywhere
// ---------------------------------------------------------------------------

test('machineName is the first label of the hostname, without port or tailnet', () => {
  assert.equal(machineName(MAC), 'juans-macbook-pro')
  assert.equal(machineName('https://omarchy.tailbd0167.ts.net'), 'omarchy')
  assert.equal(machineName('http://localhost:7777'), 'localhost')
  // Why the tests pair `localhost` with `127.0.0.1` and never two of the same (design D2).
  assert.equal(machineName('http://127.0.0.1:7777'), '127')
})

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

test('a peer starts unreachable and never seen: nothing has asked it yet', () => {
  const peers = table()
  assert.deepEqual(peers.list(), [
    { name: 'juans-macbook-pro', origin: MAC, reachable: false, lastSeenAt: undefined, version: undefined, devices: 0 },
  ])
})

test('get finds a peer by its name, and nothing else', () => {
  const peers = table()
  assert.equal(peers.get('juans-macbook-pro')?.origin, MAC)
  assert.equal(peers.get('omarchy'), undefined)
  assert.equal(peers.get(MAC), undefined)
})

test('no peers is an empty table', () => {
  assert.deepEqual(table([]).list(), [])
})

// ---------------------------------------------------------------------------
// url(name, rawRest): the table of criterion 6 (design D3), every row
// ---------------------------------------------------------------------------

test('every malicious rest of criterion 6 builds no URL', () => {
  const peers = table()
  for (const rest of REFUSED_RESTS) assert.equal(peers.url('juans-macbook-pro', rest), undefined, rest)
})

test('the rests that must pass build a URL on the peer’s own origin, query untouched', () => {
  const peers = table()
  const cases: readonly (readonly [string, string])[] = [
    ['/modules/sessions/sessions?page=0', `${MAC}/modules/sessions/sessions?page=0`],
    // A search for a text with `/` in it: the query is never looked at, so `%2F` passes there.
    ['/modules/sessions/search?q=src%2Fapp', `${MAC}/modules/sessions/search?q=src%2Fapp`],
    ['/health', `${MAC}/health`],
  ]
  for (const [rest, want] of cases) {
    const out = peers.url('juans-macbook-pro', rest)
    assert.equal(out?.href, want, rest)
    assert.equal(out?.origin, MAC)
  }
})

test('more shapes that must not leave: dot segments, encoded escapes, a module id that is not one', () => {
  const peers = table()
  for (const rest of [
    '/modules/sessions/./x',
    '/modules/sessions/..',
    '/modules/sessions/%2E%2E/x',
    '/modules/sessions/a%5cb',
    '/modules/sessions/a\\b',
    '/modules/Sessions/x',
    '/modules/-x/y',
    '/modules',
    '/modules/',
    '/health/x',
    '/healthz',
    'modules/sessions/x',
    '/modules/sessions/a#b',
  ]) {
    assert.equal(peers.url('juans-macbook-pro', rest), undefined, rest)
  }
})

test('a name that is not a peer builds nothing', () => {
  const peers = table()
  assert.equal(peers.url('omarchy', '/health'), undefined)
  assert.equal(peers.url('', '/health'), undefined)
})

test('a module path with its own segments and a token in it passes untouched', () => {
  const peers = table()
  const out = peers.url('juans-macbook-pro', '/modules/sessions/asks/0a1b-TOKEN_x.y~z/answer')
  assert.equal(out?.pathname, '/modules/sessions/asks/0a1b-TOKEN_x.y~z/answer')
})

// ---------------------------------------------------------------------------
// The probe (design D2, criterion 3)
//
// A fake peer on loopback with a fixed, unique port (CLAUDE.md §7). It listens on `localhost`,
// the same resolver `fetch` uses, so whichever of `::1` and `127.0.0.1` that is, both agree.
// ---------------------------------------------------------------------------

let nextPort = 46_200
const takePort = () => (nextPort += 1)

const PROBE_MS = 40

type Answer = (req: IncomingMessage, res: ServerResponse) => void

const healthy: Answer = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ version: '1.2.3', environment: 'dev', ready: true, uptimeMs: 1, devices: 2 }))
}

/** A peer whose answer can be swapped, that can go away and come back on the same port. */
function fakePeer(port: number) {
  const peer = { hits: 0, answer: healthy, server: undefined as Server | undefined }
  const up = () =>
    new Promise<void>((resolve) => {
      const server = createServer((req, res) => {
        peer.hits += 1
        peer.answer(req, res)
      })
      peer.server = server
      server.listen(port, 'localhost', resolve)
    })
  const down = () =>
    new Promise<void>((resolve) => {
      peer.server?.closeAllConnections()
      peer.server?.close(() => resolve())
    })
  return { peer, up, down }
}

function capture() {
  const lines: string[] = []
  const log: Logger = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) }
  return { lines, log }
}

async function eventually(check: () => boolean, what: string, ms = 3_000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) assert.fail(`never happened: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function probing(port: number, extra: { probeTimeoutMs?: number; now?: () => Date } = {}) {
  const { lines, log } = capture()
  const timers = timerSet()
  const peers = createPeerTable({ peers: [{ origin: `http://localhost:${port}` }], log, probeMs: PROBE_MS, ...extra })
  const state = () => peers.get('localhost')
  const stop = () => {
    peers.stop()
    timers.disposeAll()
  }
  return { peers, timers, state, lines, stop }
}

test('the constants are the ones design D2 names', () => {
  assert.equal(PEER_PROBE_MS, 15_000)
  assert.equal(PEER_PROBE_TIMEOUT_MS, 3_000)
  assert.equal(PEER_DOWN_AFTER, 2)
})

test('the probe asks at start, without waiting a whole period, and reads version and devices', async () => {
  const port = takePort()
  const fake = fakePeer(port)
  await fake.up()
  const at = new Date('2026-10-08T10:00:00.000Z')
  // A period far longer than the test: only the probe at start can make it reachable.
  const { lines, log } = capture()
  const timers = timerSet()
  const peers = createPeerTable({ peers: [{ origin: `http://localhost:${port}` }], log, probeMs: 60_000, now: () => at })
  try {
    peers.start(timers.timers)
    await eventually(() => peers.get('localhost')?.reachable === true, 'reachable')
    assert.deepEqual(peers.get('localhost'), {
      name: 'localhost',
      origin: `http://localhost:${port}`,
      reachable: true,
      lastSeenAt: at.toISOString(),
      version: '1.2.3',
      devices: 2,
    })
    assert.deepEqual(lines, ['peer localhost is reachable (version 1.2.3)'])
  } finally {
    peers.stop()
    timers.disposeAll()
    await fake.down()
  }
})

test('reachable, gone, and back — each change in under two probes, one log line each', async () => {
  const port = takePort()
  const fake = fakePeer(port)
  await fake.up()
  const p = probing(port)
  try {
    p.peers.start(p.timers.timers)
    await eventually(() => p.state()?.reachable === true, 'reachable')
    const seen = p.state()?.lastSeenAt

    await fake.down()
    await eventually(() => p.state()?.reachable === false, 'unreachable', PROBE_MS * (PEER_DOWN_AFTER + 2) + 500)
    // Gone is not forgotten: when it was last seen is what the client shows.
    assert.equal(p.state()?.lastSeenAt, seen)

    await fake.up()
    await eventually(() => p.state()?.reachable === true, 'reachable again', PROBE_MS * 2 + 500)

    assert.equal(p.lines.length, 3, p.lines.join(' | '))
    assert.match(p.lines[0] ?? '', /localhost is reachable/)
    assert.match(p.lines[1] ?? '', /localhost is unreachable/)
    assert.match(p.lines[2] ?? '', /localhost is reachable/)
  } finally {
    p.stop()
    await fake.down()
  }
})

test('one failed probe does not declare the peer down', async () => {
  const port = takePort()
  const fake = fakePeer(port)
  await fake.up()
  const p = probing(port)
  try {
    p.peers.start(p.timers.timers)
    await eventually(() => p.state()?.reachable === true, 'reachable')
    let failed = 0
    fake.peer.answer = (req, res) => {
      if (failed === 0) {
        failed += 1
        res.writeHead(500).end()
        return
      }
      healthy(req, res)
    }
    const hits = fake.peer.hits
    await eventually(() => fake.peer.hits >= hits + 3, 'three more probes')
    assert.equal(failed, 1)
    assert.equal(p.state()?.reachable, true)
    assert.equal(p.lines.length, 1, p.lines.join(' | '))
  } finally {
    p.stop()
    await fake.down()
  }
})

test('a peer that never was reachable is reported once, after the probes that confirm it', async () => {
  const port = takePort()
  // Nothing listens on this port.
  const p = probing(port)
  try {
    p.peers.start(p.timers.timers)
    await eventually(() => p.lines.length === 1, 'one line', PROBE_MS * (PEER_DOWN_AFTER + 2) + 500)
    assert.match(p.lines[0] ?? '', /localhost is unreachable/)
    await new Promise((resolve) => setTimeout(resolve, PROBE_MS * 3))
    assert.equal(p.lines.length, 1)
    assert.equal(p.state()?.reachable, false)
    assert.equal(p.state()?.lastSeenAt, undefined)
  } finally {
    p.stop()
  }
})

test('what is not a ready factotum does not count: starting, foreign JSON, not JSON, a redirect', async () => {
  const answers: readonly Answer[] = [
    (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: '1', ready: false })),
    (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ hello: 'world' })),
    (_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html>'),
    // Never followed: a peer that redirects is not a peer.
    (_req, res) => res.writeHead(302, { location: 'http://localhost:1/health' }).end(),
  ]
  for (const answer of answers) {
    const port = takePort()
    const fake = fakePeer(port)
    fake.peer.answer = answer
    await fake.up()
    const p = probing(port)
    try {
      p.peers.start(p.timers.timers)
      await eventually(() => fake.peer.hits >= PEER_DOWN_AFTER + 1, 'probes')
      assert.equal(p.state()?.reachable, false)
    } finally {
      p.stop()
      await fake.down()
    }
  }
})

test('a peer that never answers is given up on after the probe timeout', async () => {
  const port = takePort()
  const fake = fakePeer(port)
  // Holds the request open and never writes.
  fake.peer.answer = () => undefined
  await fake.up()
  const p = probing(port, { probeTimeoutMs: 30 })
  try {
    p.peers.start(p.timers.timers)
    await eventually(() => p.lines.length === 1, 'declared unreachable')
    assert.match(p.lines[0] ?? '', /unreachable: no answer within 30ms/)
  } finally {
    p.stop()
    await fake.down()
  }
})

test('after stop, no timer is left and the peer is asked nothing more', async () => {
  const port = takePort()
  const fake = fakePeer(port)
  await fake.up()
  const p = probing(port)
  try {
    p.peers.start(p.timers.timers)
    await eventually(() => p.state()?.reachable === true, 'reachable')
    p.stop()
    const atStop = fake.peer.hits
    await new Promise((resolve) => setTimeout(resolve, PROBE_MS * 4))
    // At most the probe that was already on the wire when stop ran; a live interval would have
    // added about four in this window.
    assert.ok(fake.peer.hits <= atStop + 1, `${fake.peer.hits - atStop} probes after stop`)
  } finally {
    await fake.down()
  }
})

test('start twice arms one probe, not two', async () => {
  const port = takePort()
  const fake = fakePeer(port)
  await fake.up()
  const { log } = capture()
  const timers = timerSet()
  const peers = createPeerTable({ peers: [{ origin: `http://localhost:${port}` }], log, probeMs: 60_000 })
  try {
    peers.start(timers.timers)
    peers.start(timers.timers)
    await eventually(() => peers.get('localhost')?.reachable === true, 'reachable')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(fake.peer.hits, 1)
  } finally {
    peers.stop()
    timers.disposeAll()
    await fake.down()
  }
})
