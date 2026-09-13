import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { init } from './init.ts'

const withTailscale = (() => ({
  lo0: [{ address: '127.0.0.1', internal: true }],
  utun4: [{ address: '100.87.1.2', internal: false }],
})) as never

const withoutTailscale = (() => ({
  lo0: [{ address: '127.0.0.1', internal: true }],
})) as never

function collector() {
  const lines: string[] = []
  return { lines, out: (line: string) => lines.push(line), text: () => lines.join('\n') }
}

const configPath = (home: string) => join(home, '.factotum', 'prod', 'config.json')

async function readConfig(home: string) {
  return JSON.parse(await readFile(configPath(home), 'utf8'))
}

test('writes the ADDRESS, never the interface name', async () => {
  // On macOS the utunN number changes across reboots and the 100.x address does not.
  // Writing the name would stop the daemon starting one morning, and the fix would be
  // editing a file by hand — which is what the clone-and-go promise forbids.
  const home = await mkdtemp(join(tmpdir(), 'factotum-init-'))
  const { out } = collector()

  assert.equal(await init({ env: 'prod', home, interfaces: withTailscale, out }), 0)

  const config = await readConfig(home)
  assert.equal(config.listen.address, '100.87.1.2')
  assert.equal(config.listen.interface, undefined)
  assert.equal(config.listen.port, 7777)
  assert.equal(config.environment, 'prod')
})

test('switches the example module on, so the walk-through ends with something visible', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-init-'))
  await init({ env: 'prod', home, interfaces: withTailscale, out: () => undefined })
  assert.equal((await readConfig(home)).modules.example.enabled, true)
})

test('dev gets its own port so both environments can run at once', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-init-'))
  await init({ env: 'dev', home, interfaces: withTailscale, out: () => undefined })
  const config = JSON.parse(await readFile(join(home, '.factotum', 'dev', 'config.json'), 'utf8'))
  assert.equal(config.listen.port, 7778)
  assert.equal(config.environment, 'dev')
})

test('with no private address it explains Tailscale and writes nothing', async () => {
  // Deliberately NOT falling back to loopback: a config that starts but cannot be
  // reached from a phone is a worse outcome than a clear refusal.
  const home = await mkdtemp(join(tmpdir(), 'factotum-init-'))
  const { out, text } = collector()

  assert.equal(await init({ env: 'prod', home, interfaces: withoutTailscale, out }), 1)
  assert.match(text(), /tailscale\.com/)
  await assert.rejects(() => readFile(configPath(home), 'utf8'))
})

// ---------------------------------------------------------------------------
// Idempotence: init writes into a stranger's home directory
// ---------------------------------------------------------------------------

test('an existing config is shown and left alone when nobody can be asked', async () => {
  // Non-interactive means no consent. Assuming yes would make the first impression
  // "it silently replaced my config".
  const home = await mkdtemp(join(tmpdir(), 'factotum-init-'))
  await mkdir(join(home, '.factotum', 'prod'), { recursive: true })
  await writeFile(configPath(home), '{"mine":true}', 'utf8')

  const { out, text } = collector()
  assert.equal(await init({ env: 'prod', home, interfaces: withTailscale, out }), 0)

  assert.match(text(), /already exists/)
  assert.match(text(), /Nothing was written/)
  assert.equal(await readFile(configPath(home), 'utf8'), '{"mine":true}')
})

test('an existing config is kept when the answer is no', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-init-'))
  await mkdir(join(home, '.factotum', 'prod'), { recursive: true })
  await writeFile(configPath(home), '{"mine":true}', 'utf8')

  await init({
    env: 'prod',
    home,
    interfaces: withTailscale,
    ask: async () => 'n',
    out: () => undefined,
  })

  assert.equal(await readFile(configPath(home), 'utf8'), '{"mine":true}')
})

test('an existing config is replaced only after an explicit yes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-init-'))
  await mkdir(join(home, '.factotum', 'prod'), { recursive: true })
  await writeFile(configPath(home), '{"mine":true}', 'utf8')

  await init({
    env: 'prod',
    home,
    interfaces: withTailscale,
    ask: async () => 'y',
    out: () => undefined,
  })

  assert.equal((await readConfig(home)).listen.address, '100.87.1.2')
})

test('the existing config is printed before anything is asked', async () => {
  // "Nothing is deleted until you say yes" is only credible if you can see what is
  // about to go.
  const home = await mkdtemp(join(tmpdir(), 'factotum-init-'))
  await mkdir(join(home, '.factotum', 'prod'), { recursive: true })
  await writeFile(configPath(home), '{"distinctive":"marker"}', 'utf8')

  const { out, text } = collector()
  await init({ env: 'prod', home, interfaces: withTailscale, ask: async () => 'n', out })
  assert.match(text(), /distinctive/)
})

test('the QR and the URL both appear, because typing an IP on a phone is where people quit', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-init-'))
  const { out, text } = collector()
  await init({ env: 'prod', home, interfaces: withTailscale, out })
  assert.match(text(), /http:\/\/100\.87\.1\.2:7777/)
})
