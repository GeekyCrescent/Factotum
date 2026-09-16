import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { statePaths } from '@factotum/kernel'
import { qrCommand } from './qr-command.ts'

const PROD = {
  environment: 'prod',
  listen: { address: '127.0.0.1', port: 7777 },
  publicOrigin: 'https://mimac.tail1234.ts.net',
  modules: { sessions: { enabled: true, sites: [{ id: 'notes', path: '/tmp' }] } },
}

async function world(env: 'prod' | 'dev', config: unknown = PROD) {
  const home = await mkdtemp(join(tmpdir(), 'factotum-qr-'))
  const paths = statePaths(env, home)
  await mkdir(paths.root, { recursive: true })
  await writeFile(paths.config, JSON.stringify(config), 'utf8')
  return { home, configPath: paths.config }
}

const collector = () => {
  const lines: string[] = []
  return { out: (line: string) => lines.push(line), text: () => lines.join('\n') }
}

test('it prints the public origin and a QR of it', async () => {
  const { home } = await world('prod')
  const { out, text } = collector()

  assert.equal(await qrCommand({ env: 'prod', home, out }), 0)
  assert.match(text(), /https:\/\/mimac\.tail1234\.ts\.net/)
  assert.match(text(), /[█▀▄]/)
})

test('it does NOT touch the config — which is the whole reason it exists', async () => {
  // Seeing the QR again used to mean running `init`, the command that replaces the
  // config, sites and all.
  const { home, configPath } = await world('prod')
  const before = await readFile(configPath, 'utf8')

  await qrCommand({ env: 'prod', home, out: () => undefined })

  assert.equal(await readFile(configPath, 'utf8'), before)
})

test('dev prints the URL and no QR, for the same reason init does not', async () => {
  const dev = { ...PROD, environment: 'dev', publicOrigin: 'http://127.0.0.1:7778' }
  const { home } = await world('dev', dev)
  const { out, text } = collector()

  assert.equal(await qrCommand({ env: 'dev', home, out }), 0)
  assert.match(text(), /http:\/\/127\.0\.0\.1:7778/)
  assert.doesNotMatch(text(), /[█▀▄]/)
})

test('a config that does not validate names the field instead of printing a QR of nothing', async () => {
  const { home } = await world('prod', { ...PROD, publicOrigin: 'https://mimac.tail1234.ts.net/' })
  const { out, text } = collector()

  assert.equal(await qrCommand({ env: 'prod', home, out }), 1)
  assert.match(text(), /does not validate at `publicOrigin`/)
})

test('no config at all points at init', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-qr-'))
  const { out, text } = collector()

  assert.equal(await qrCommand({ env: 'prod', home, out }), 1)
  assert.match(text(), /factotum init --env prod/)
})
