import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execPath } from 'node:process'
import { execRunner, readFqdn, readServeStatus, type RunResult, type Runner } from './tailscale.ts'

/**
 * The fixtures are REAL OUTPUT, captured from `tailscale` 1.102.2 on a live tailnet
 * during block A of this spec. Inventing the shape of this JSON is how you write a
 * parser that works only against your imagination.
 */

const ok = (stdout: string): RunResult => ({ stdout, code: 0, signal: null, timedOut: false })
const fails = (code: number | string | null, timedOut = false): RunResult => ({
  stdout: '',
  code,
  signal: timedOut ? 'SIGTERM' : null,
  timedOut,
})

const runner = (result: RunResult): Runner => async () => result

// Captured verbatim: serve on, funnel off.
const SERVING = JSON.stringify({
  TCP: { '443': { HTTPS: true } },
  Web: {
    'juans-macbook-pro.tailbd0167.ts.net:443': {
      Handlers: { '/': { Proxy: 'http://127.0.0.1:7777' } },
    },
  },
})

// Captured verbatim: the ONLY difference when funnel is on is the AllowFunnel key.
const FUNNELLED = JSON.stringify({
  TCP: { '443': { HTTPS: true } },
  Web: {
    'juans-macbook-pro.tailbd0167.ts.net:443': {
      Handlers: { '/': { Proxy: 'http://127.0.0.1:7777' } },
    },
  },
  AllowFunnel: { 'juans-macbook-pro.tailbd0167.ts.net:443': true },
})

// ---------------------------------------------------------------------------
// readServeStatus
// ---------------------------------------------------------------------------

test('serving on 443 yields an origin with NO :443, so it can be compared', async () => {
  // The trap this function exists for. The JSON key always carries the port, but a
  // canonical origin omits 443 — and publicOrigin is validated as canonical. Build
  // the origin naively and `doctor` reports a mismatch on every correct machine.
  const status = await readServeStatus(runner(ok(SERVING)))
  assert.equal(status.kind, 'serving')
  assert.equal(status.servedOrigin, 'https://juans-macbook-pro.tailbd0167.ts.net')
  assert.equal(status.target, 'http://127.0.0.1:7777')
  assert.equal(status.funnel, false)
})

test('the served origin matches a valid publicOrigin exactly', async () => {
  // The comparison `doctor` actually makes, spelled out: these two strings come from
  // completely different places and must be byte-identical.
  const status = await readServeStatus(runner(ok(SERVING)))
  assert.equal(status.servedOrigin, 'https://juans-macbook-pro.tailbd0167.ts.net')
})

test('a non-default port IS kept, because serve can be told to use one', async () => {
  // Measured: `tailscale serve --bg --https=8443 <target>` works.
  const json = JSON.stringify({
    Web: { 'host.tail1234.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7777' } } } },
  })
  const status = await readServeStatus(runner(ok(json)))
  assert.equal(status.servedOrigin, 'https://host.tail1234.ts.net:8443')
})

test('funnel is detected, and it is the only difference in the JSON', async () => {
  const status = await readServeStatus(runner(ok(FUNNELLED)))
  assert.equal(status.kind, 'serving')
  assert.equal(status.funnel, true)
})

test('funnel on a DIFFERENT port does not raise the alarm for this one', async () => {
  // A warning that fires for the wrong port is a warning that gets ignored.
  const json = JSON.stringify({
    Web: { 'host.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7777' } } } },
    AllowFunnel: { 'host.tail1234.ts.net:8443': true },
  })
  const status = await readServeStatus(runner(ok(json)))
  assert.equal(status.funnel, false)
})

test('serving something else is reported with the target, not as an error', async () => {
  const json = JSON.stringify({
    Web: { 'host.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } },
  })
  const status = await readServeStatus(runner(ok(json)))
  assert.equal(status.kind, 'serving')
  assert.equal(status.target, 'http://127.0.0.1:3000')
})

test('an empty config is not-serving — what an off switch actually leaves behind', async () => {
  // Measured: `tailscale funnel --https=443 off` prints exactly `{}`, because it
  // removes the whole serve config rather than just the funnel flag.
  const status = await readServeStatus(runner(ok('{}')))
  assert.equal(status.kind, 'not-serving')
  assert.equal(status.funnel, false)
})

test('a non-zero exit is not-serving', async () => {
  const status = await readServeStatus(runner(fails(1)))
  assert.equal(status.kind, 'not-serving')
})

test('a MISSING BINARY is unknown, which is a different thing from not serving', async () => {
  // The distinction the whole RunResult type exists for. ENOENT arrives as a STRING
  // code; with `code: number` this case is indistinguishable from "not serving", and
  // doctor would tell someone without Tailscale to go and fix their serve config.
  const status = await readServeStatus(runner(fails('ENOENT')))
  assert.equal(status.kind, 'unknown')
})

test('a timeout is unknown too, because tailscaled may still be starting', async () => {
  const status = await readServeStatus(runner(fails(null, true)))
  assert.equal(status.kind, 'unknown')
})

test('unparseable output is unknown rather than a crash', async () => {
  const status = await readServeStatus(runner(ok('not json at all')))
  assert.equal(status.kind, 'unknown')
})

// ---------------------------------------------------------------------------
// readFqdn
// ---------------------------------------------------------------------------

test('the TRAILING DOT is stripped, and the real output has one', async () => {
  // THE SINGLE MOST LIKELY FAILURE IN THIS SPEC. Captured from a live tailnet:
  // Self.DNSName comes back fully qualified, with the dot. A browser sends the name
  // without it. The policy compares raw strings, so leaving the dot on is 403 for
  // everything, with two identical-looking values on screen.
  const json = JSON.stringify({ Self: { DNSName: 'juans-macbook-pro.tailbd0167.ts.net.' } })
  assert.equal(await readFqdn(runner(ok(json))), 'juans-macbook-pro.tailbd0167.ts.net')
})

test('a name without a dot is left alone', async () => {
  const json = JSON.stringify({ Self: { DNSName: 'host.tail1234.ts.net' } })
  assert.equal(await readFqdn(runner(ok(json))), 'host.tail1234.ts.net')
})

test('the stripped name composes an origin the schema accepts', async () => {
  // Closing the loop: what init composes from this must survive the criterion-14
  // guard, and the un-stripped version must not.
  const json = JSON.stringify({ Self: { DNSName: 'host.tail1234.ts.net.' } })
  const fqdn = await readFqdn(runner(ok(json)))
  const origin = `https://${fqdn}`
  assert.equal(origin, new URL(origin).origin)
  assert.equal(new URL(origin).hostname.endsWith('.'), false)
})

test('no Tailscale means undefined, not a crash and not a guess', async () => {
  assert.equal(await readFqdn(runner(fails('ENOENT'))), undefined)
})

test('MagicDNS off leaves no name, which init must refuse to work around', async () => {
  assert.equal(await readFqdn(runner(ok(JSON.stringify({ Self: {} })))), undefined)
  assert.equal(await readFqdn(runner(ok(JSON.stringify({ Self: { DNSName: '' } })))), undefined)
})

test('a name that is nothing but dots is undefined, not an empty origin', async () => {
  assert.equal(await readFqdn(runner(ok(JSON.stringify({ Self: { DNSName: '.' } })))), undefined)
})

test('unparseable status output is undefined', async () => {
  assert.equal(await readFqdn(runner(ok('<html>'))), undefined)
})

// ---------------------------------------------------------------------------
// execRunner — the real adapter.
//
// Everything above runs against fakes, which proves the PARSING and proves nothing
// about the mapping from a Node error to a RunResult. That mapping is the whole
// reason the type has three differently-shaped `code` values, so it gets real
// processes. `process.execPath` rather than `sh`: the tests are already running
// under it, so it is guaranteed present and the test does not assume a shell.
// ---------------------------------------------------------------------------

test('execRunner: a normal exit gives code 0 and the stdout', async () => {
  const result = await execRunner(execPath, ['-e', 'process.stdout.write("hello")'])
  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'hello')
  assert.equal(result.timedOut, false)
})

test('execRunner: a non-zero exit gives the NUMBER, and keeps the stdout', async () => {
  const result = await execRunner(execPath, [
    '-e',
    'process.stdout.write("partial"); process.exit(3)',
  ])
  assert.equal(result.code, 3)
  assert.equal(result.stdout, 'partial')
  assert.equal(result.timedOut, false)
})

test('execRunner: a missing binary gives the STRING ENOENT', async () => {
  // The case that made `code: number` unworkable. It has to be distinguishable from
  // an exit code, or "Tailscale is not installed" reads as "your serve is misconfigured".
  const result = await execRunner('definitely-not-a-real-binary-factotum', [])
  assert.equal(result.code, 'ENOENT')
  assert.equal(result.timedOut, false)
})

test('execRunner: a timeout is flagged as such, not as an exit code', async () => {
  const result = await execRunner(execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
    timeoutMs: 200,
  })
  assert.equal(result.timedOut, true)
  assert.notEqual(result.signal, null)
})

test('execRunner never rejects, because every caller here reports instead of stopping', async () => {
  // A diagnostic tool that throws on the broken machine is the worst place to throw.
  await assert.doesNotReject(() => execRunner('definitely-not-a-real-binary-factotum', []))
})
