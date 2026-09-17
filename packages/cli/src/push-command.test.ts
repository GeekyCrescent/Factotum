import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPushService, inspectPush, statePaths } from '@factotum/kernel'
import { pushCommand } from './push-command.ts'

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined }
const up: typeof fetch = async () => new Response('{}', { status: 200 })
const down: typeof fetch = async () => {
  throw new TypeError('fetch failed')
}

async function homeWithDevices(count: number): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'factotum-push-cmd-'))
  const paths = statePaths('prod', home)
  await mkdir(paths.root, { recursive: true })
  await writeFile(
    paths.config,
    JSON.stringify({ environment: 'prod', listen: { address: '127.0.0.1', port: 7777 }, publicOrigin: 'https://m.t.ts.net', modules: {} }),
  )
  const push = await createPushService({
    dir: paths.push,
    machine: 'm',
    subject: 'https://m.t.ts.net',
    log: quiet,
    deliver: async () => ({ statusCode: 201 }),
  })
  for (let i = 0; i < count; i++) {
    await push.subscribe({ endpoint: `https://fcm.googleapis.com/fcm/send/d${i}`, keys: { p256dh: 'BP', auth: 'au' } })
  }
  await push.settled()
  return home
}

function capture() {
  const lines: string[] = []
  return { lines, out: (line: string) => void lines.push(line) }
}

test('with the daemon stopped, reset forgets every device and says how many (criterion 57)', async () => {
  const home = await homeWithDevices(5)
  const { lines, out } = capture()

  const code = await pushCommand({ env: 'prod', argv: ['reset'], home, out, fetch: down })

  assert.equal(code, 0)
  assert.deepEqual(await inspectPush(statePaths('prod', home).push), { kind: 'ready', subscriptions: 0, warning: undefined })
  assert.match(lines.join('\n'), /5/)
})

test('WITH THE DAEMON RUNNING, reset REFUSES and touches nothing', async () => {
  // The daemon holds the subscriptions in memory and writes the list whole on its next change.
  // Clearing the file under it would be undone by the next device that subscribes — and a
  // command that reports "done" when it is about to be undone is the one kind this CLI refuses
  // to be (restart.ts: "It NEVER pretends").
  const home = await homeWithDevices(3)
  const { lines, out } = capture()

  const code = await pushCommand({ env: 'prod', argv: ['reset'], home, out, fetch: up })

  assert.equal(code, 1)
  assert.deepEqual(await inspectPush(statePaths('prod', home).push), { kind: 'ready', subscriptions: 3, warning: undefined })
  assert.match(lines.join('\n'), /running/)
  // The way out, with commands that already exist.
  assert.match(lines.join('\n'), /factotum uninstall --env prod/)
})

test('with no config there can be no daemon, so reset proceeds', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-push-cmd-'))
  const { out } = capture()

  const code = await pushCommand({ env: 'prod', argv: ['reset'], home, out, fetch: up })

  assert.equal(code, 0)
})

test('an unknown subcommand prints the usage and exits 2, touching nothing', async () => {
  const home = await homeWithDevices(1)
  const { lines, out } = capture()

  assert.equal(await pushCommand({ env: 'prod', argv: ['nuke'], home, out, fetch: down }), 2)
  assert.equal(await pushCommand({ env: 'prod', argv: [], home, out, fetch: down }), 2)
  assert.match(lines.join('\n'), /push reset/)
  assert.deepEqual(await inspectPush(statePaths('prod', home).push), { kind: 'ready', subscriptions: 1, warning: undefined })
})

test('nothing printed is a key or an endpoint', async () => {
  const home = await homeWithDevices(2)
  const { lines, out } = capture()
  await pushCommand({ env: 'prod', argv: ['reset'], home, out, fetch: down })
  assert.doesNotMatch(lines.join('\n'), /fcm\.googleapis|send\/d[0-9]/)
})
