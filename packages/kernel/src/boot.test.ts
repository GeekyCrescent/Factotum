import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createHttpServer } from 'node:http'
import type { AnyModule, BootHandle } from '@factotum/core'
import { boot } from './boot.ts'
import type { BootError } from './errors.ts'
import { statePaths } from './config/paths.ts'
import { createServer } from './http/server.ts'
import type { OriginPolicy } from './net/origin.ts'

/** Loopback and an ephemeral port: real sockets, no collisions across runs. */
const loopback = () => ({ lo0: [{ address: '127.0.0.1', internal: false }] }) as never

/**
 * Ports are fixed and unique per test rather than ephemeral: `listen.port` has a
 * floor of 1024 in the schema — a config should never carry a port the operator did
 * not choose — so `0` is correctly refused, and each test needs its own.
 */
let nextPort = 45_900
const takePort = () => (nextPort += 1)

/** `Response.json()` is `unknown`, and every assertion here knows the shape. */
async function json<T = Record<string, never>>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function withConfig(overrides: Record<string, unknown> = {}, port = takePort()) {
  const home = await mkdtemp(join(tmpdir(), 'factotum-'))
  const paths = statePaths('prod', home)
  await mkdir(paths.root, { recursive: true })
  await writeFile(
    paths.config,
    JSON.stringify({
      environment: 'prod',
      listen: { address: '127.0.0.1', port },
      // The bind is loopback in every one of these tests, so `handle.localUrl` is
      // what talks to the socket. `publicOrigin` is deliberately NOT derived from
      // the bind: it is a different value, and conflating the two is the bug this
      // spec is built to avoid.
      publicOrigin: `https://mimac.tail1234.ts.net`,
      ...overrides,
    }),
    'utf8',
  )
  return paths
}

const bootWith = (paths: Awaited<ReturnType<typeof withConfig>>, modules: readonly AnyModule[] = [], extra = {}) =>
  boot({ env: 'prod', modules, version: 'test', paths, interfaces: loopback, ...extra })

const example: AnyModule = {
  id: 'example',
  nav: { label: 'Example', icon: 'dot' },
  routes: () => ({ 'GET /ping': () => ({ status: 200, body: { pong: true } }) }),
}

// ---------------------------------------------------------------------------
// The happy path, end to end over a real socket
// ---------------------------------------------------------------------------

test('boots, serves a module route, and stops cleanly', async () => {
  const paths = await withConfig({ modules: { example: { enabled: true } } })
  const handle = await bootWith(paths, [example])

  try {
    const response = await fetch(`${handle.localUrl}/modules/example/ping`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { pong: true })
  } finally {
    await handle.stop()
  }
})

test('health answers with the environment, which is how dev and prod are told apart', async () => {
  const paths = await withConfig()
  const handle = await bootWith(paths)
  try {
    const body = await json<{ environment: string; ready: boolean }>(
      await fetch(`${handle.localUrl}/health`),
    )
    assert.equal(body.environment, 'prod')
    assert.equal(body.ready, true)
  } finally {
    await handle.stop()
  }
})

test('a module that is off is absent, not merely quiet', async () => {
  const paths = await withConfig({ modules: { example: { enabled: false } } })
  const handle = await bootWith(paths, [example])
  try {
    assert.equal((await fetch(`${handle.localUrl}/modules/example/ping`)).status, 404)
    const { modules } = await json<{ modules: unknown[] }>(await fetch(`${handle.localUrl}/modules`))
    assert.deepEqual(modules, [])
  } finally {
    await handle.stop()
  }
})

// ---------------------------------------------------------------------------
// Step 11: what actually happened
// ---------------------------------------------------------------------------

test('a server that binds somewhere other than intended is closed and boot aborts', async () => {
  // The check that makes shipping no credential rest on something verified. Steps 4
  // and 5 validate intent; only this catches a wide bind that arrived anyway.
  const paths = await withConfig()

  await assert.rejects(
    () =>
      bootWith(paths, [], {
        makeServer: (deps: Parameters<typeof createServer>[0]) => {
          const server = createHttpServer()
          const real = createServer(deps)
          real.close()
          Object.defineProperty(server, 'address', {
            value: () => ({ address: '0.0.0.0', port: 7777, family: 'IPv4' }),
          })
          return server
        },
      }),
    (error: BootError) => {
      assert.equal(error.code, 'bind-mismatch')
      assert.match(error.message, /0\.0\.0\.0/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// Step 9: the WIRING. Two things no type protects.
//
// `boot` hands the policy three values and returns two URLs, and every one of them
// is a string. A string that compiles and points at the wrong place is exactly the
// failure this spec's third revision shipped — it moved `handle.url` and lost the
// one line that fed the permission hook, and nothing caught it because both sides
// were `string`.
//
// `makeServer` is the seam, documented in boot.ts as "a seam, and the only one".
// Capturing `deps.origin` through it is also what makes the `listen.interface` case
// testable at all: binding to a tailnet address really does give EADDRNOTAVAIL, so
// the socket is stubbed and only the composition is under test.
// ---------------------------------------------------------------------------

/** Captures the policy `boot` composed, and pretends the bind succeeded. */
function captureOrigin(boundTo: string, port: number) {
  const seen: { policy?: OriginPolicy } = {}
  const makeServer = (deps: Parameters<typeof createServer>[0]) => {
    seen.policy = deps.origin
    const server = createServer(deps)
    Object.defineProperty(server, 'listen', {
      value: (_port: number, _address: string, cb?: () => void) => {
        cb?.()
        return server
      },
    })
    Object.defineProperty(server, 'address', {
      value: () => ({ address: boundTo, port, family: 'IPv4' }),
    })
    return server
  }
  return { seen, makeServer }
}

test('step 9 gets the public origin from the config, never composed from the bind', async () => {
  const port = takePort()
  const paths = await withConfig({}, port)
  const { seen, makeServer } = captureOrigin('127.0.0.1', port)

  const handle = await bootWith(paths, [], { makeServer })
  try {
    assert.equal(seen.policy?.publicOrigin, 'https://mimac.tail1234.ts.net')
    // THE TWIN OF THE v3 BUG: both of these are strings, both compile either way.
    assert.equal(handle.url, 'https://mimac.tail1234.ts.net')
    assert.equal(handle.localUrl, `http://127.0.0.1:${port}`)
    assert.notEqual(handle.url, handle.localUrl)
  } finally {
    await handle.stop()
  }
})

test('step 9 composes the rescue route from the loopback bind', async () => {
  const port = takePort()
  const paths = await withConfig({}, port)
  const { seen, makeServer } = captureOrigin('127.0.0.1', port)

  const handle = await bootWith(paths, [], { makeServer })
  try {
    assert.equal(seen.policy?.localOrigin, `http://127.0.0.1:${port}`)
    assert.deepEqual(seen.policy?.extra, [])
  } finally {
    await handle.stop()
  }
})

test('step 9 uses the RESOLVED address, so listen.interface gets no rescue route', async () => {
  // The case §0.25 of the requirements called unwritable. It is unwritable against a
  // real socket — `server.listen(port, '100.87.1.2')` gives EADDRNOTAVAIL, measured —
  // but the policy is composed before step 10, so the seam reaches it.
  //
  // There is no `listen.address` in this config at all, so a `localOrigin` here could
  // only have come from the resolved address. It must be undefined: composing one
  // would hand the policy the tailnet IP as an accepted origin and quietly undo the
  // loopback bind.
  const port = takePort()
  const paths = await withConfig({ listen: { interface: 'tailscale0', port } }, port)
  const { seen, makeServer } = captureOrigin('100.87.1.2', port)

  const handle = await bootWith(paths, [], {
    makeServer,
    interfaces: (() => ({ tailscale0: [{ address: '100.87.1.2', internal: false }] })) as never,
  })
  try {
    assert.equal(seen.policy?.localOrigin, undefined)
    assert.equal(seen.policy?.publicOrigin, 'https://mimac.tail1234.ts.net')
    // `localUrl` on the handle is NOT the policy's rescue route: it says where the
    // socket is, which is a different question. See the comment on BootHandle.
    assert.equal(handle.localUrl, `http://100.87.1.2:${port}`)
  } finally {
    await handle.stop()
  }
})

test('extraOrigins reach the policy, which is how dev survives the vite proxy', async () => {
  const port = takePort()
  const paths = await withConfig(
    { listen: { address: '127.0.0.1', port, extraOrigins: ['http://localhost:5173'] } },
    port,
  )
  const { seen, makeServer } = captureOrigin('127.0.0.1', port)

  const handle = await bootWith(paths, [], { makeServer })
  try {
    assert.deepEqual(seen.policy?.extra, ['http://localhost:5173'])
  } finally {
    await handle.stop()
  }
})

// ---------------------------------------------------------------------------
// Step 13: the readiness window
// ---------------------------------------------------------------------------

test('the API answers 503 until boot finishes, but the site and health do not', async () => {
  // Between listen and ready the server is up. Without the flag it would dispatch to
  // a module whose start() had not run, and would have been serving on whatever the
  // socket actually bound to while step 11 was still deciding.
  const paths = await withConfig({ modules: { slow: { enabled: true } } })

  let seenDuringStart: { api: number; site: number; health: number } | undefined
  let url = ''

  const slow: AnyModule = {
    id: 'slow',
    routes: () => ({ 'GET /x': () => ({ status: 200 }) }),
    start: async () => {
      const [api, site, health] = await Promise.all([
        fetch(`${url}/modules/slow/x`).then((r) => r.status),
        fetch(`${url}/index.html`).then((r) => r.status),
        fetch(`${url}/health`).then((r) => r.status),
      ])
      seenDuringStart = { api, site, health }
      return { stop: () => undefined }
    },
  }

  const site = {
    serve: async (path: string) =>
      path === '/index.html' ? { body: Buffer.from('<html>'), type: 'text/html' } : undefined,
  }

  // The module's start needs the URL, which boot only returns afterwards; a
  // listening server on a known loopback port lets it be computed up front.
  const chosen = takePort()
  const fixed = await withConfig({ modules: { slow: { enabled: true } } }, chosen)
  url = `http://127.0.0.1:${chosen}`
  void paths

  const handle = await bootWith(fixed, [slow], { site })
  try {
    assert.deepEqual(seenDuringStart, { api: 503, site: 200, health: 200 })
    // And once ready, the same route answers for real.
    assert.equal((await fetch(`${url}/modules/slow/x`)).status, 200)
  } finally {
    await handle.stop()
  }
})

// ---------------------------------------------------------------------------
// Origin, port, and degradation, over the real server
// ---------------------------------------------------------------------------

test('a page from the internet is refused, and told what the policy is', async () => {
  const paths = await withConfig({ modules: { example: { enabled: true } } })
  const handle = await bootWith(paths, [example])
  try {
    const response = await fetch(`${handle.localUrl}/modules/example/ping`, {
      headers: { origin: 'https://evil.com' },
    })
    assert.equal(response.status, 403)
    const body = await json<{ error: { code: string; message: string } }>(response)
    assert.equal(body.error.code, 'unknown-origin')
    assert.match(body.error.message, /evil\.com/)
  } finally {
    await handle.stop()
  }
})

test('the client loaded from this host is allowed', async () => {
  const chosen = takePort()
  const paths = await withConfig({ modules: { example: { enabled: true } } }, chosen)
  const handle = await bootWith(paths, [example])
  try {
    const response = await fetch(`http://127.0.0.1:${chosen}/modules/example/ping`, {
      headers: { origin: `http://127.0.0.1:${chosen}` },
    })
    assert.equal(response.status, 200)
  } finally {
    await handle.stop()
  }
})

test('the client loaded from the PUBLIC origin is allowed, through a real socket', async () => {
  // The whole chain the spec exists for, end to end: config → policyFor → the guard.
  // The unit tests prove each link; nothing else proves they are joined up, and the
  // request arrives at a loopback socket carrying an origin that is not loopback —
  // which is exactly the shape `tailscale serve` produces.
  const chosen = takePort()
  const paths = await withConfig({ modules: { example: { enabled: true } } }, chosen)
  const handle = await bootWith(paths, [example])
  try {
    const allowed = await fetch(`http://127.0.0.1:${chosen}/modules/example/ping`, {
      headers: { origin: 'https://mimac.tail1234.ts.net' },
    })
    assert.equal(allowed.status, 200)

    // And the trailing-dot form of the very same name is refused, because the
    // comparison is raw. This is what a config validated without the second half of
    // the guard would have produced on every single request.
    const dotted = await fetch(`http://127.0.0.1:${chosen}/modules/example/ping`, {
      headers: { origin: 'https://mimac.tail1234.ts.net.' },
    })
    assert.equal(dotted.status, 403)
  } finally {
    await handle.stop()
  }
})

test('a second environment on a taken port says which port and which environment', async () => {
  const chosen = takePort()
  const first = await withConfig({}, chosen)
  const handle = await bootWith(first)
  try {
    const second = await withConfig({}, chosen)
    await assert.rejects(
      () => bootWith(second),
      (error: BootError) => {
        assert.equal(error.code, 'port-in-use')
        assert.match(error.message, new RegExp(String(chosen)))
        assert.match(error.message, /prod environment/)
        return true
      },
    )
  } finally {
    await handle.stop()
  }
})

test('a module with a broken fragment is disabled and the daemon still serves', async () => {
  const { z } = await import('zod')
  const strict: AnyModule = {
    id: 'strict',
    configSchema: z.object({ apiKeyPath: z.string() }),
    routes: () => ({ 'GET /x': () => ({ status: 200 }) }),
  }

  const paths = await withConfig({ modules: { strict: { enabled: true } } })
  const handle = await bootWith(paths, [strict])
  try {
    const response = await fetch(`${handle.localUrl}/modules/strict/x`)
    assert.equal(response.status, 501)
    const body = await json<{ error: { message: string } }>(response)
    assert.match(body.error.message, /apiKeyPath/)

    // The whole point of degrading rather than aborting.
    assert.equal((await fetch(`${handle.localUrl}/health`)).status, 200)
  } finally {
    await handle.stop()
  }
})

test('a path that tries to climb out of a module prefix does not exist', async () => {
  const paths = await withConfig({ modules: { example: { enabled: true } } })
  const handle = await bootWith(paths, [example])
  try {
    const response = await fetch(`${handle.localUrl}/modules/example/../../health`, { redirect: 'manual' })
    // Normalised to /health, which is a real route — the point is that it never
    // reached the module dispatcher with a traversing path.
    assert.notEqual(response.status, 500)
  } finally {
    await handle.stop()
  }
})

// ---------------------------------------------------------------------------
// Push off — criterion 5 of the web-push spec, at the level it is decided
// ---------------------------------------------------------------------------

test('a keys.json it cannot use leaves push OFF and the daemon serving (criterion 5)', async () => {
  // The task (C3) asked for this test and the spec closed without it: every other test of
  // criterion 5 covers `createPushService` or `doctor` in isolation, and the decision that push
  // is a capability and not the network surface (ADR-0004) is taken HERE, in step 7 bis. A boot
  // that threw on an unreadable key file would take the whole daemon down with it, and nothing
  // would have caught that.
  const paths = await withConfig({ modules: { example: { enabled: true }, probe: { enabled: true } } })
  await mkdir(paths.push, { recursive: true })
  await writeFile(join(paths.push, 'keys.json'), 'not json at all', 'utf8')

  let reachable: boolean | undefined
  const probe: AnyModule = {
    id: 'probe',
    routes: (ctx) => ((reachable = ctx.notify.canReach()), {}),
  }

  const handle = await bootWith(paths, [example, probe], {})
  try {
    // READY, and the rest of the daemon does not know anything happened.
    assert.equal((await fetch(`${handle.localUrl}/health`)).status, 200)
    assert.equal((await fetch(`${handle.localUrl}/modules/example/ping`)).status, 200)

    // The push routes are gone rather than broken, and the module is told it cannot reach anyone,
    // which is what makes the permission gate deny instead of hanging on an ask nobody sees.
    assert.equal((await fetch(`${handle.localUrl}/push/public-key`)).status, 404)
    assert.equal(reachable, false)

    // And the file it could not parse is still there, unread and unreplaced.
    assert.equal(await readFile(join(paths.push, 'keys.json'), 'utf8'), 'not json at all')
  } finally {
    await handle.stop()
  }
})

// ---------------------------------------------------------------------------
// Peers (spec 2026-10-07, criterion 2): the network surface, so they ABORT
// ---------------------------------------------------------------------------

/** Every abort below must carry a remedy (CLAUDE.md §5), and none of them may leave a socket open. */
async function assertAborts(overrides: Record<string, unknown>, code: string, remedy: RegExp) {
  const port = takePort()
  const paths = await withConfig(overrides, port)
  let error: BootError | undefined
  try {
    // A boot that should have aborted and did not is stopped, so a red run fails instead of hanging.
    await (await bootWith(paths)).stop()
  } catch (caught) {
    error = caught as BootError
  }
  assert.equal(error?.code, code)
  assert.match(error?.remedy ?? '', remedy)
  // Refused before the bind: the port is still free.
  const probe = createHttpServer()
  await new Promise<void>((resolve, reject) => probe.once('error', reject).listen(port, '127.0.0.1', resolve))
  await new Promise<void>((resolve) => probe.close(() => resolve()))
}

test('a peer that is not a canonical origin aborts, with the peer rule’s own message', async () => {
  await assertAborts({ peers: [{ origin: 'https://omarchy.tail1234.ts.net.' }] }, 'config-invalid', /config\.template/)
})

test('more than one peer aborts', async () => {
  await assertAborts(
    { peers: [{ origin: 'https://a.tail1234.ts.net' }, { origin: 'https://b.tail1234.ts.net' }] },
    'config-invalid',
    /config\.template/,
  )
})

test('a peer that is this daemon’s own publicOrigin aborts', async () => {
  await assertAborts({ peers: [{ origin: 'https://mimac.tail1234.ts.net' }] }, 'peer-invalid', /other machine/i)
})

test('a peer that shares this host’s machineName aborts: two hosts would answer to one name', async () => {
  await assertAborts(
    { peers: [{ origin: 'https://mimac.othertailnet.ts.net' }] },
    'peer-invalid',
    /two hosts share the name mimac: rename one machine in Tailscale/,
  )
})

test('a peer whose name cannot travel in a path aborts', async () => {
  // `[::1]` is a canonical origin, and its first label is not a name `/peers/<name>/` can carry.
  await assertAborts({ peers: [{ origin: 'http://[::1]:7000' }] }, 'peer-invalid', /hostname/)
})

// ---------------------------------------------------------------------------
// The probe, wired (criterion 3): kernel timers, freed by BootHandle.stop
// ---------------------------------------------------------------------------

test('the peer is probed at start on kernel timers, and stop leaves no probe running', async () => {
  // The peer listens on `localhost` and this daemon is `127.0.0.1`: two loopback daemons need two
  // names, or criterion 2 aborts (design D2).
  const peerPort = takePort()
  let hits = 0
  const peer = createHttpServer((_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: 'p', ready: true, devices: 0 }))
  })
  await new Promise<void>((resolve) => peer.listen(peerPort, 'localhost', resolve))
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 3_000
    while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  const port = takePort()
  const paths = await withConfig({ publicOrigin: `http://127.0.0.1:${port}`, peers: [{ origin: `http://localhost:${peerPort}` }] }, port)
  const handle = await bootWith(paths, [], { peerProbeMs: 30 })
  try {
    await until(() => hits >= 2)
    assert.ok(hits >= 2, 'probed at start and then on its period')
    // Criterion 1, end to end: the name is machineName of each origin.
    const hosts = await json<{ name: string; self: boolean; reachable: boolean }[]>(await fetch(`${handle.localUrl}/hosts`))
    assert.deepEqual(hosts.map(({ name, self, reachable }) => ({ name, self, reachable })), [
      { name: '127', self: true, reachable: true },
      { name: 'localhost', self: false, reachable: true },
    ])
  } finally {
    await handle.stop()
  }
  const atStop = hits
  await new Promise((resolve) => setTimeout(resolve, 150))
  // At most the probe already on the wire when stop ran; a live 30 ms interval would add about five.
  assert.ok(hits <= atStop + 1, `${hits - atStop} probes after stop`)
  peer.closeAllConnections()
  await new Promise<void>((resolve) => peer.close(() => resolve()))
})

test('a peer that is not there at all: the daemon boots and serves', async () => {
  const port = takePort()
  const paths = await withConfig({ peers: [{ origin: `http://localhost:${takePort()}` }] }, port)
  const handle = await bootWith(paths)
  try {
    assert.equal((await fetch(`${handle.localUrl}/health`)).status, 200)
    assert.deepEqual(await json(await fetch(`${handle.localUrl}/hosts`)), [
      { name: 'mimac', self: true, reachable: true },
      { name: 'localhost', self: false, reachable: false, lastSeenAt: null },
    ])
  } finally {
    await handle.stop()
  }
})
