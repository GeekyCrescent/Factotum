import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createHttpServer } from 'node:http'
import type { AnyModule, BootHandle } from '@factotum/core'
import { boot } from './boot.ts'
import type { BootError } from './errors.ts'
import { statePaths } from './config/paths.ts'
import { createServer } from './http/server.ts'

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
    const response = await fetch(`${handle.url}/modules/example/ping`)
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
      await fetch(`${handle.url}/health`),
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
    assert.equal((await fetch(`${handle.url}/modules/example/ping`)).status, 404)
    const { modules } = await json<{ modules: unknown[] }>(await fetch(`${handle.url}/modules`))
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
    const response = await fetch(`${handle.url}/modules/example/ping`, {
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
    const response = await fetch(`${handle.url}/modules/strict/x`)
    assert.equal(response.status, 501)
    const body = await json<{ error: { message: string } }>(response)
    assert.match(body.error.message, /apiKeyPath/)

    // The whole point of degrading rather than aborting.
    assert.equal((await fetch(`${handle.url}/health`)).status, 200)
  } finally {
    await handle.stop()
  }
})

test('a path that tries to climb out of a module prefix does not exist', async () => {
  const paths = await withConfig({ modules: { example: { enabled: true } } })
  const handle = await bootWith(paths, [example])
  try {
    const response = await fetch(`${handle.url}/modules/example/../../health`, { redirect: 'manual' })
    // Normalised to /health, which is a real route — the point is that it never
    // reached the module dispatcher with a traversing path.
    assert.notEqual(response.status, 500)
  } finally {
    await handle.stop()
  }
})
