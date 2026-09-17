import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { statePaths } from '@factotum/kernel'
import { doctor, type DoctorDeps } from './doctor.ts'
import type { RunResult, Runner } from './tailscale.ts'

/**
 * This file did not exist before this spec. Everything external is injected — the
 * `tailscale` and `claude` binaries, the network interfaces, the daemon — because a
 * diagnostic tool's tests must not depend on the machine they run on, which is the
 * exact property the tool is trying to establish about someone else's machine.
 */

const PUBLIC = 'https://mimac.tail1234.ts.net'

const SERVING = JSON.stringify({
  Web: { 'mimac.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7777' } } } },
})
const FUNNELLED = JSON.stringify({
  Web: { 'mimac.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7777' } } } },
  AllowFunnel: { 'mimac.tail1234.ts.net:443': true },
})

const ok = (stdout: string): RunResult => ({ stdout, code: 0, signal: null, timedOut: false })
const missing: RunResult = { stdout: '', code: 'ENOENT', signal: null, timedOut: false }

/** Answers per command, so `claude` and `tailscale` can differ in one run. */
function runner(serve: RunResult, claude: RunResult = ok('1.2.3')): Runner {
  return async (cmd) => (cmd === 'claude' ? claude : serve)
}

/** Loopback only: the shipping bind, and present on every machine. */
const loopbackOnly = (() => ({ lo0: [{ address: '127.0.0.1', internal: true }] })) as never
/** A machine with Tailscale up on an interface, for the `listen.interface` case. */
const withTailscale = (() =>
  ({
    lo0: [{ address: '127.0.0.1', internal: true }],
    tailscale0: [{ address: '100.87.1.2', internal: false }],
  })) as never

async function withConfig(env: 'prod' | 'dev', config: unknown): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'factotum-doctor-'))
  const paths = statePaths(env, home)
  await mkdir(paths.root, { recursive: true })
  await writeFile(paths.config, JSON.stringify(config), 'utf8')
  return home
}

const goodProd = {
  environment: 'prod',
  listen: { address: '127.0.0.1', port: 7777 },
  publicOrigin: PUBLIC,
  modules: { example: { enabled: true } },
}

/** Runs doctor and returns everything it printed, joined. */
async function report(home: string, overrides: Partial<DoctorDeps> = {}): Promise<string> {
  const lines: string[] = []
  const code = await doctor({
    home,
    out: (line) => lines.push(line),
    fetch: (async () => {
      throw new Error('no daemon')
    }) as unknown as typeof globalThis.fetch,
    run: runner(ok(SERVING)),
    interfaces: loopbackOnly,
    ...overrides,
  })
  assert.equal(code, 0, 'doctor always exits 0: it reports, it does not judge')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// The five situations of task D11, plus dev and listen.interface
// ---------------------------------------------------------------------------

test('serve on and matching: says so, and names both origins', async () => {
  const home = await withConfig('prod', goodProd)
  const output = await report(home)

  assert.match(output, /public {6}https:\/\/mimac\.tail1234\.ts\.net/)
  assert.match(output, /https:\/\/mimac\.tail1234\.ts\.net \(publicOrigin\)/)
  assert.match(output, /http:\/\/127\.0\.0\.1:7777 \(the bind — the way in if serve stops\)/)
  assert.match(output, /serve {7}serving https:\/\/mimac\.tail1234\.ts\.net -> http:\/\/127\.0\.0\.1:7777/)
  assert.match(output, /funnel {6}off/)
})

test('serve off: says nothing is terminating TLS, and does not pretend otherwise', async () => {
  const home = await withConfig('prod', goodProd)
  const output = await report(home, { run: runner(ok('{}')) })

  assert.match(output, /NOT SERVING/)
  // The daemon still runs without it; doctor must not imply the machine is broken.
  assert.match(output, /https:\/\/mimac\.tail1234\.ts\.net \(publicOrigin\)/)
})

test('serve off: the suggested command points at the BIND and is runnable', async () => {
  // Asserting the whole command, not that a line mentioning `serve` exists. The first
  // version of this composed the target by rewriting publicOrigin's scheme and
  // emitted `http://127.0.0.1:mimac.tail1234.ts.net` — it compiled, and a test that
  // only looked for "NOT SERVING" was perfectly happy with it. Running `doctor` by
  // hand is what found it.
  const home = await withConfig('prod', goodProd)
  const output = await report(home, { run: runner(ok('{}')) })

  assert.match(output, /tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:7777$/m)
  assert.doesNotMatch(output, /127\.0\.0\.1:mimac/)
})

test('serve off on a custom port suggests THAT port', async () => {
  const home = await withConfig('prod', { ...goodProd, listen: { address: '127.0.0.1', port: 9999 } })
  const output = await report(home, { run: runner(ok('{}')) })

  assert.match(output, /tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:9999$/m)
})

test('funnel on: shouts, and says what turning it off ALSO removes', async () => {
  const home = await withConfig('prod', goodProd)
  const output = await report(home, { run: runner(ok(FUNNELLED)) })

  assert.match(output, /funnel {6}ON — THIS DAEMON IS EXPOSED TO THE INTERNET/)
  // Measured: `tailscale funnel --https=443 off` wipes the whole serve config, so an
  // operator following this line lands with no TLS at all unless it is said here.
  assert.match(output, /also removes the whole serve config/)
})

test('serving something ELSE prints both strings, because they look alike', async () => {
  const home = await withConfig('prod', goodProd)
  const other = JSON.stringify({
    Web: { 'otra.tail9999.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } },
  })
  const output = await report(home, { run: runner(ok(other)) })

  assert.match(output, /MISMATCH/)
  assert.match(output, /serving https:\/\/otra\.tail9999\.ts\.net/)
  assert.match(output, /but publicOrigin is https:\/\/mimac\.tail1234\.ts\.net/)
  // Nothing holds publicOrigin's port, so the command is safe to print.
  assert.match(output, /tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:7777$/m)
})

// ---------------------------------------------------------------------------
// Sharing serve with another service — the machine this spec was built on
// ---------------------------------------------------------------------------

const PUBLIC_8443 = `${PUBLIC}:8443`
const prodOn8443 = {
  ...goodProd,
  listen: { address: '127.0.0.1', port: 7877 },
  publicOrigin: PUBLIC_8443,
}

test('another service on 443 and factotum on 8443: serving, not MISMATCH', async () => {
  const shared = JSON.stringify({
    Web: {
      'mimac.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7777' } } },
      'mimac.tail1234.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7877' } } },
    },
  })
  const home = await withConfig('prod', prodOn8443)
  const output = await report(home, { run: runner(ok(shared)) })

  assert.match(output, /serve {7}serving https:\/\/mimac\.tail1234\.ts\.net:8443 -> http:\/\/127\.0\.0\.1:7877/)
  assert.doesNotMatch(output, /MISMATCH/)
})

test('serve off with publicOrigin on 8443 suggests --https=8443, not 443', async () => {
  const home = await withConfig('prod', prodOn8443)
  const output = await report(home, { run: runner(ok('{}')) })

  assert.match(output, /tailscale serve --bg --https=8443 http:\/\/127\.0\.0\.1:7877$/m)
  assert.doesNotMatch(output, /--https=443/)
})

test('publicOrigin served by ANOTHER backend: TAKEN, and no command that would replace it', async () => {
  // The incident: 443 on this name belonged to another service, and pasting
  // `serve --https=443` pointed it at factotum instead — cutting that service off.
  const home = await withConfig('prod', { ...goodProd, listen: { address: '127.0.0.1', port: 7877 } })
  const output = await report(home, { run: runner(ok(SERVING)) })

  assert.match(output, /serve {7}TAKEN — https:\/\/mimac\.tail1234\.ts\.net -> http:\/\/127\.0\.0\.1:7777/)
  assert.match(output, /REPLACE/)
  assert.match(output, /:8443/)
  assert.doesNotMatch(output, /tailscale serve --bg --https=443/)
})

test('funnel on 8443: the off command names 8443, and warns it wipes EVERY handler', async () => {
  const funnelled = JSON.stringify({
    Web: { 'mimac.tail1234.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7877' } } } },
    AllowFunnel: { 'mimac.tail1234.ts.net:8443': true },
  })
  const home = await withConfig('prod', prodOn8443)
  const output = await report(home, { run: runner(ok(funnelled)) })

  assert.match(output, /tailscale funnel --https=8443 off/)
  assert.match(output, /every serve handler on this machine/)
  assert.match(output, /tailscale serve status --json/)
})

test('no tailscale binary is UNKNOWN, not "you forgot to set up serve"', async () => {
  const home = await withConfig('prod', goodProd)
  const output = await report(home, { run: runner(missing, missing) })

  assert.match(output, /serve {7}UNKNOWN/)
  assert.match(output, /claude CLI {4}NOT FOUND on PATH/)
  assert.doesNotMatch(output, /NOT SERVING/)
})

// ---------------------------------------------------------------------------
// A config without publicOrigin — which is EVERY config written before this spec
// ---------------------------------------------------------------------------

test('a config missing publicOrigin NAMES THE FIELD', async () => {
  // Without the issue path this reads "does not validate: Invalid input", and the
  // person reading it has no idea which key. This spec invalidates every existing
  // config, so this is the single most common thing doctor will print.
  const home = await withConfig('prod', {
    environment: 'prod',
    listen: { address: '127.0.0.1', port: 7777 },
    modules: {},
  })
  const output = await report(home)

  assert.match(output, /does not validate at `publicOrigin`/)
})

test('a non-canonical publicOrigin also names the field', async () => {
  const home = await withConfig('prod', { ...goodProd, publicOrigin: `${PUBLIC}.` })
  const output = await report(home)

  assert.match(output, /does not validate at `publicOrigin`/)
  assert.match(output, /trailing dot/)
})

test('a config that is not JSON at all is reported, not thrown', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-doctor-'))
  const paths = statePaths('prod', home)
  await mkdir(paths.root, { recursive: true })
  await writeFile(paths.config, '{ not json', 'utf8')

  const output = await report(home)
  assert.match(output, /is not valid JSON/)
})

// ---------------------------------------------------------------------------
// Criterion 13, the other half. The logical half is in the kernel's policy.test.ts.
// ---------------------------------------------------------------------------

test('with listen.interface, doctor does NOT print a local origin', async () => {
  // `boot` leaves localOrigin undefined for a non-loopback bind. If doctor computed
  // the rule itself it would print one anyway, and would be lying in the config used
  // as the proof for criterion 26. Both go through `policyFor`, so they cannot differ.
  const home = await withConfig('prod', {
    environment: 'prod',
    listen: { interface: 'tailscale0', port: 7777 },
    publicOrigin: PUBLIC,
    modules: {},
  })
  const output = await report(home, { interfaces: withTailscale })

  assert.match(output, /listen {6}100\.87\.1\.2:7777 \(via tailscale0\)/)
  assert.match(output, /https:\/\/mimac\.tail1234\.ts\.net \(publicOrigin\)/)
  assert.doesNotMatch(output, /the way in if serve stops/)
})

test('an interface that does not exist is explained, not crashed on', async () => {
  // `resolveListen` throws a BootError here. doctor used to skip the whole branch,
  // printing no origins at all; now it catches and says what it could not do.
  const home = await withConfig('prod', {
    environment: 'prod',
    listen: { interface: 'wg0', port: 7777 },
    publicOrigin: PUBLIC,
    modules: {},
  })
  const output = await report(home, { interfaces: loopbackOnly })

  assert.match(output, /CANNOT RESOLVE/)
  assert.match(output, /wg0/)
  assert.match(output, /https:\/\/mimac\.tail1234\.ts\.net \(publicOrigin\)/)
})

test('an address no interface holds is explained — the stale-config case', async () => {
  // The common one in the wild: the config still says the old tailnet address after
  // a reinstall. This is exactly when a diagnosis is wanted, and it used to be when
  // `resolveListen` would have thrown straight through doctor.
  const home = await withConfig('prod', { ...goodProd, listen: { address: '100.99.99.99', port: 7777 } })
  const output = await report(home, { interfaces: loopbackOnly })

  assert.match(output, /CANNOT RESOLVE/)
  assert.match(output, /100\.99\.99\.99/)
})

// ---------------------------------------------------------------------------
// Criterion 43: dev
// ---------------------------------------------------------------------------

test('serve is NOT checked in dev, or every run reports a false alarm', async () => {
  // A machine has one MagicDNS name and serve fronts one backend, so dev's
  // publicOrigin is its own loopback origin. Since doctor walks both environments,
  // checking serve in dev would report a mismatch permanently.
  const home = await withConfig('dev', {
    environment: 'dev',
    listen: { address: '127.0.0.1', port: 7778 },
    publicOrigin: 'http://127.0.0.1:7778',
    modules: {},
  })
  const output = await report(home)

  assert.match(output, /not checked in dev/)
  assert.doesNotMatch(output, /MISMATCH/)
  assert.doesNotMatch(output, /NOT SERVING/)
})

test('a dev config with the vite origin shows it, since that is where it belongs', async () => {
  const home = await withConfig('dev', {
    environment: 'dev',
    listen: { address: '127.0.0.1', port: 7778, extraOrigins: ['http://localhost:5173'] },
    publicOrigin: 'http://127.0.0.1:7778',
    modules: {},
  })
  const output = await report(home)

  assert.match(output, /http:\/\/localhost:5173 \(from listen\.extraOrigins\)/)
})

// ---------------------------------------------------------------------------
// The daemon
// ---------------------------------------------------------------------------

test('a running daemon is probed on the LOCAL url, not the public one', async () => {
  // Probing the public origin would make doctor's answer depend on the proxy being
  // up, which is one of the things doctor exists to tell you about.
  const asked: string[] = []
  const home = await withConfig('prod', goodProd)
  const output = await report(home, {
    fetch: (async (url: string) => {
      asked.push(String(url))
      return new Response(JSON.stringify({ modules: [] }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof globalThis.fetch,
  })

  assert.deepEqual(asked, ['http://127.0.0.1:7777/modules'])
  assert.match(output, /daemon {6}running at http:\/\/127\.0\.0\.1:7777/)
})

test('a disabled module is named with its reason', async () => {
  const home = await withConfig('prod', goodProd)
  const output = await report(home, {
    fetch: (async () =>
      new Response(
        JSON.stringify({
          modules: [{ id: 'sessions', status: { kind: 'disabled', reason: 'bad catalog entry' } }],
        }),
        { headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch,
  })

  assert.match(output, /DISABLED {4}sessions: bad catalog entry/)
})

test('no config at all points at init rather than reporting a failure', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-doctor-'))
  const output = await report(home)

  assert.match(output, /no config at .*prod.*run `factotum init --env prod`/s)
  assert.match(output, /no config at .*dev.*run `factotum init --env dev`/s)
})

// ---------------------------------------------------------------------------
// push — three states, and never a key or an endpoint (criterion 3)
// ---------------------------------------------------------------------------

async function withPushState(home: string, devices: number, keys: 'none' | 'good' | 'garbage'): Promise<void> {
  const { createPushService } = await import('@factotum/kernel')
  const { writeFile: write } = await import('node:fs/promises')
  const paths = statePaths('prod', home)
  if (keys === 'none') return
  await mkdir(paths.push, { recursive: true })
  if (keys === 'garbage') {
    await write(join(paths.push, 'keys.json'), 'garbage', 'utf8')
    return
  }
  const push = await createPushService({
    dir: paths.push,
    machine: 'mimac',
    subject: PUBLIC,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    deliver: async () => ({ statusCode: 201 }),
  })
  for (let i = 0; i < devices; i++) {
    await push.subscribe({ endpoint: `https://fcm.googleapis.com/fcm/send/SECRET-${i}`, keys: { p256dh: 'BP', auth: 'au' } })
  }
  await push.settled()
}

test('push, no key pair yet: says the daemon creates one — and doctor itself creates NOTHING', async () => {
  const { readdir } = await import('node:fs/promises')
  const home = await withConfig('prod', goodProd)
  const output = await report(home)

  assert.match(output, /push {8}not set up yet/)
  await assert.rejects(readdir(statePaths('prod', home).push), 'a diagnostic must not create the thing it reports on')
})

test('push, keys but no devices: the normal state before the app is installed, said as such', async () => {
  const home = await withConfig('prod', goodProd)
  await withPushState(home, 0, 'good')
  const output = await report(home)

  assert.match(output, /push {8}ready, no devices subscribed/)
})

test('push, with devices: the count and the cap', async () => {
  const home = await withConfig('prod', goodProd)
  await withPushState(home, 2, 'good')
  const output = await report(home)

  assert.match(output, /push {8}ready, 2 devices subscribed \(at most 5\)/)
})

test('push, unusable key file: OFF with the reason, which names the remedy', async () => {
  const home = await withConfig('prod', goodProd)
  await withPushState(home, 0, 'garbage')
  const output = await report(home)

  assert.match(output, /push {8}OFF/)
  assert.match(output, /delete/i)
})

test('push output never carries a key or an endpoint (criterion 3)', async () => {
  const home = await withConfig('prod', goodProd)
  await withPushState(home, 3, 'good')
  const { readFile: read } = await import('node:fs/promises')
  const keys = JSON.parse(await read(join(statePaths('prod', home).push, 'keys.json'), 'utf8')) as { publicKey: string; privateKey: string }

  const output = await report(home)

  assert.doesNotMatch(output, /SECRET-|fcm\.googleapis/)
  assert.equal(output.includes(keys.privateKey), false)
  assert.equal(output.includes(keys.publicKey), false)
})
