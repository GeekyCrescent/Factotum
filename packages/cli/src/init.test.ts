import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rootConfigSchema } from '@factotum/core'
import { init } from './init.ts'
import type { RunResult, Runner } from './tailscale.ts'

/**
 * `interfaces` is gone from InitDeps, and with it the nine call sites that passed it.
 * The bind is a constant now, so there is nothing to detect; what varies is the
 * MagicDNS name, and that is what `run` injects.
 */

/** Tailscale answering normally — WITH the trailing dot, as the real thing does. */
const withTailscale: Runner = async (cmd) => {
  if (cmd === 'claude') return { stdout: '', code: 'ENOENT', signal: null, timedOut: false }
  return {
    stdout: JSON.stringify({ Self: { DNSName: 'mimac.tail1234.ts.net.' } }),
    code: 0,
    signal: null,
    timedOut: false,
  }
}

/** Tailscale not installed. */
const withoutTailscale: Runner = async () =>
  ({ stdout: '', code: 'ENOENT', signal: null, timedOut: false }) satisfies RunResult

/** Installed, but MagicDNS gives no name. */
const withoutMagicDns: Runner = async () =>
  ({ stdout: JSON.stringify({ Self: {} }), code: 0, signal: null, timedOut: false }) satisfies RunResult

function collector() {
  const lines: string[] = []
  return { lines, out: (line: string) => lines.push(line), text: () => lines.join('\n') }
}

const configPath = (home: string, env = 'prod') => join(home, '.factotum', env, 'config.json')

async function readConfig(home: string, env = 'prod') {
  return JSON.parse(await readFile(configPath(home, env), 'utf8'))
}

const home = () => mkdtemp(join(tmpdir(), 'factotum-init-'))

// ---------------------------------------------------------------------------
// What init writes
// ---------------------------------------------------------------------------

test('the bind is loopback, and it is not a choice any more', async () => {
  // Replaces "writes the ADDRESS, never the interface name". That test existed to
  // pin down which of several detected addresses got written; there is no longer a
  // choice to get wrong, and the property worth pinning is that it is LOOPBACK —
  // which is what closes the door on other peers reaching the daemon directly.
  const h = await home()
  const { out } = collector()

  assert.equal(await init({ env: 'prod', home: h, run: withTailscale, out }), 0)

  const config = await readConfig(h)
  assert.equal(config.listen.address, '127.0.0.1')
  assert.equal(config.listen.interface, undefined)
  assert.equal(config.listen.port, 7777)
  assert.equal(config.environment, 'prod')
})

test('the publicOrigin is composed from the FQDN, WITHOUT the trailing dot', async () => {
  // The fake returns 'mimac.tail1234.ts.net.' because the real `tailscale status
  // --json` does. If that dot survives to the config, every POST is a 403.
  const h = await home()
  await init({ env: 'prod', home: h, run: withTailscale, out: () => undefined })

  assert.equal((await readConfig(h)).publicOrigin, 'https://mimac.tail1234.ts.net')
})

test('switches the example module on, so the walk-through ends with something visible', async () => {
  const h = await home()
  await init({ env: 'prod', home: h, run: withTailscale, out: () => undefined })
  assert.equal((await readConfig(h)).modules.example.enabled, true)
})

test('dev gets its own port so both environments can run at once', async () => {
  const h = await home()
  await init({ env: 'dev', home: h, run: withTailscale, out: () => undefined })
  const config = await readConfig(h, 'dev')
  assert.equal(config.listen.port, 7778)
  assert.equal(config.environment, 'dev')
})

// ---------------------------------------------------------------------------
// Criterion 31: what init writes must be something `start` accepts
// ---------------------------------------------------------------------------

test('WHAT INIT WRITES VALIDATES — parsed back against the real schema', async () => {
  // The guard against the whole class of bug where init produces a file that parses
  // as JSON and then fails at startup, in the first command everybody runs. Not an
  // eyeball check: the actual schema, on the actual bytes written to disk.
  const h = await home()
  assert.equal(await init({ env: 'prod', home: h, run: withTailscale, out: () => undefined }), 0)

  const raw = await readFile(configPath(h), 'utf8')
  const parsed = rootConfigSchema.safeParse(JSON.parse(raw))
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues))
})

test('what init writes for DEV validates too', async () => {
  const h = await home()
  assert.equal(await init({ env: 'dev', home: h, run: withTailscale, out: () => undefined }), 0)

  const raw = await readFile(configPath(h, 'dev'), 'utf8')
  const parsed = rootConfigSchema.safeParse(JSON.parse(raw))
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues))
})

// ---------------------------------------------------------------------------
// Criterion 30: no FQDN means no config
// ---------------------------------------------------------------------------

test('with no Tailscale it explains what is missing and writes NOTHING', async () => {
  // Replaces the old "with no private address" test, same shape and same reasoning:
  // a config that cannot start is worse than a clear refusal. The condition changed
  // — it is now the MagicDNS name rather than a private address — because the bind
  // no longer depends on the network.
  const h = await home()
  const { out, text } = collector()

  assert.equal(await init({ env: 'prod', home: h, run: withoutTailscale, out }), 1)
  assert.match(text(), /tailscale\.com/)
  assert.match(text(), /MagicDNS/)
  await assert.rejects(() => readFile(configPath(h), 'utf8'))
})

test('MagicDNS off is refused the same way, and it is a different failure', async () => {
  const h = await home()
  const { out, text } = collector()

  assert.equal(await init({ env: 'prod', home: h, run: withoutMagicDns, out }), 1)
  assert.match(text(), /MagicDNS/)
  await assert.rejects(() => readFile(configPath(h), 'utf8'))
})

test('dev does NOT need Tailscale, because its origin is local', async () => {
  // Falls out of the dev decision and is worth pinning: dev is for this machine, so
  // it must not be blocked by a tailnet it does not use.
  const h = await home()
  assert.equal(await init({ env: 'dev', home: h, run: withoutTailscale, out: () => undefined }), 0)
  assert.equal((await readConfig(h, 'dev')).publicOrigin, 'http://127.0.0.1:7778')
})

// ---------------------------------------------------------------------------
// Criterion 42: the QR, in prod only
// ---------------------------------------------------------------------------

test('prod prints the https URL and a QR of it', async () => {
  // Replaces the old QR test, which asserted /http:\/\/100\.87\.1\.2:7777/ — the
  // tailnet IP that nothing listens on any more. Without this the QR would have no
  // guardian at all.
  const h = await home()
  const { out, text } = collector()
  await init({ env: 'prod', home: h, run: withTailscale, out })

  assert.match(text(), /https:\/\/mimac\.tail1234\.ts\.net/)
  assert.doesNotMatch(text(), /http:\/\/100\.87\.1\.2/)
  // The QR renders as block characters; its presence is the thing being asserted.
  assert.match(text(), /[█▀▄]/)
  assert.match(text(), /Scan that from your phone/)
})

test('prod tells you to run `tailscale serve`, because init does not do it', async () => {
  const h = await home()
  const { out, text } = collector()
  await init({ env: 'prod', home: h, run: withTailscale, out })

  assert.match(text(), /tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:7777/)
})

test('dev prints NO QR, because a loopback QR opens nothing on a phone', async () => {
  const h = await home()
  const { out, text } = collector()
  await init({ env: 'dev', home: h, run: withTailscale, out })

  assert.match(text(), /http:\/\/127\.0\.0\.1:7778/)
  assert.doesNotMatch(text(), /[█▀▄]/)
  assert.doesNotMatch(text(), /Scan that from your phone/)
  assert.match(text(), /no secure context/)
})

// ---------------------------------------------------------------------------
// Idempotence: init writes into a stranger's home directory
// ---------------------------------------------------------------------------

test('an existing config is shown and left alone when nobody can be asked', async () => {
  // Non-interactive means no consent. Assuming yes would make the first impression
  // "it silently replaced my config".
  const h = await home()
  await mkdir(join(h, '.factotum', 'prod'), { recursive: true })
  await writeFile(configPath(h), '{"mine":true}', 'utf8')

  const { out, text } = collector()
  assert.equal(await init({ env: 'prod', home: h, run: withTailscale, out }), 0)

  assert.match(text(), /already exists/)
  assert.match(text(), /Nothing was written/)
  assert.equal(await readFile(configPath(h), 'utf8'), '{"mine":true}')
})

test('an existing config is kept when the answer is no', async () => {
  const h = await home()
  await mkdir(join(h, '.factotum', 'prod'), { recursive: true })
  await writeFile(configPath(h), '{"mine":true}', 'utf8')

  await init({
    env: 'prod',
    home: h,
    run: withTailscale,
    ask: async () => 'n',
    out: () => undefined,
  })

  assert.equal(await readFile(configPath(h), 'utf8'), '{"mine":true}')
})

test('an existing config is replaced only after an explicit yes', async () => {
  const h = await home()
  await mkdir(join(h, '.factotum', 'prod'), { recursive: true })
  await writeFile(configPath(h), '{"mine":true}', 'utf8')

  await init({
    env: 'prod',
    home: h,
    run: withTailscale,
    ask: async () => 'y',
    out: () => undefined,
  })

  assert.equal((await readConfig(h)).listen.address, '127.0.0.1')
  assert.equal((await readConfig(h)).publicOrigin, 'https://mimac.tail1234.ts.net')
})

test('the existing config is printed before anything is asked', async () => {
  // "Nothing is deleted until you say yes" is only credible if you can see what is
  // about to go.
  const h = await home()
  await mkdir(join(h, '.factotum', 'prod'), { recursive: true })
  await writeFile(configPath(h), '{"distinctive":"marker"}', 'utf8')

  const { out, text } = collector()
  await init({ env: 'prod', home: h, run: withTailscale, ask: async () => 'n', out })
  assert.match(text(), /distinctive/)
})

test('a refusal leaves an existing config untouched, rather than half-replacing it', async () => {
  // The order matters: the refusal happens before anything is written, so a machine
  // that loses Tailscale between two runs does not also lose its working config.
  const h = await home()
  await mkdir(join(h, '.factotum', 'prod'), { recursive: true })
  await writeFile(configPath(h), '{"mine":true}', 'utf8')

  const { out } = collector()
  assert.equal(
    await init({ env: 'prod', home: h, run: withoutTailscale, ask: async () => 'y', out }),
    1,
  )
  assert.equal(await readFile(configPath(h), 'utf8'), '{"mine":true}')
})
