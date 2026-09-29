import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moduleStateDir, statePaths } from '@factotum/kernel'
import { rootConfigSchema } from '@factotum/core'
import { siteCommand, stripEnvFlag } from './site-command.ts'
import type { RunResult, Runner } from './tailscale.ts'

/**
 * `factotum site` READS the projects; it never writes them (spec 2026-09-29, criterion 7). These
 * tests changed direction with that: `add` and `rm` used to write the config and restart, and now
 * they say how it is done and exit 1 — except for switching the module on where it never was.
 */

const ok: RunResult = { stdout: '', code: 0, signal: null, timedOut: false }
const fails: RunResult = { stdout: '', code: 1, signal: null, timedOut: false }

function recorder(result: RunResult = ok) {
  const calls: string[][] = []
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args])
    return result
  }
  return { calls, run }
}

const ON = { enabled: true, catalog: [{ id: 'free', label: 'Free prompt', invoke: { kind: 'none' } }] }

const BASE = {
  environment: 'prod',
  listen: { address: '127.0.0.1', port: 7777 },
  publicOrigin: 'https://mimac.tail1234.ts.net',
  modules: { example: { enabled: true }, sessions: ON },
}

async function world(config: unknown = BASE) {
  const home = await mkdtemp(join(tmpdir(), 'factotum-site-'))
  const paths = statePaths('prod', home)
  await mkdir(paths.root, { recursive: true })
  await writeFile(paths.config, JSON.stringify(config, null, 2), 'utf8')
  const dir = join(home, 'work')
  await mkdir(dir, { recursive: true })
  const registry = join(moduleStateDir(paths, 'sessions'), 'projects.json')
  return { home, dir, configPath: paths.config, registry }
}

async function withRegistry(registry: string, content: unknown): Promise<void> {
  await mkdir(join(registry, '..'), { recursive: true })
  await writeFile(registry, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
}

const collector = () => {
  const lines: string[] = []
  return { lines, out: (line: string) => lines.push(line), text: () => lines.join('\n') }
}

const readConfig = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as { modules: Record<string, Record<string, unknown> | undefined> }

// ---------------------------------------------------------------------------
// add and rm: said, not done
// ---------------------------------------------------------------------------

test('ADD WRITES NOTHING: code 1, the app first, and the way without a phone with an example entry (criterion 7)', async () => {
  const { home, dir, configPath, registry } = await world()
  const before = await readFile(configPath, 'utf8')
  const { run } = recorder()
  const { out, text } = collector()

  const code = await siteCommand({ env: 'prod', argv: ['add', dir, '--id', 'work'], home, out, run, uid: 501, platform: 'darwin' })

  assert.equal(code, 1)
  assert.equal(await readFile(configPath, 'utf8'), before, 'the config is untouched')
  await assert.rejects(() => readFile(registry, 'utf8'), /ENOENT/, 'and the registry is not written')
  assert.match(
    text(),
    new RegExp(
      `Add it from the app \\(Projects\\)\\. Without a phone: \`factotum uninstall --env prod\`, add an entry to ${registry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(example below\\), \`factotum install --env prod\``,
    ),
  )
  assert.match(text(), /rewrites the LaunchAgent with the PATH/)
  assert.match(text(), new RegExp(`\\{"id":"work","path":"${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\}`))
})

test('the way without a phone matches how the daemon runs: in the foreground, or off macOS', async () => {
  const { home, dir } = await world()
  const foreground = collector()
  await siteCommand({ env: 'prod', argv: ['add', dir], home, out: foreground.out, run: recorder(fails).run, uid: 501, platform: 'darwin' })
  assert.match(foreground.text(), /stop `factotum start --env prod`, add an entry to .*, and start it again/)
  assert.match(foreground.text(), /"id":"<id>"/, 'no --id: a placeholder, the daemon derives the real one')

  const linux = collector()
  const { calls, run } = recorder()
  await siteCommand({ env: 'prod', argv: ['add', dir], home, out: linux.out, run, platform: 'linux' })
  assert.deepEqual(calls, [])
  assert.match(linux.text(), /your supervisor's unit/)
})

test('RM WRITES NOTHING either, and says the app deletes the history too (criterion 7)', async () => {
  const { home, configPath } = await world()
  const before = await readFile(configPath, 'utf8')
  const { out, text } = collector()
  const code = await siteCommand({ env: 'prod', argv: ['rm', 'work'], home, out, run: recorder().run, uid: 501, platform: 'darwin' })
  assert.equal(code, 1)
  assert.equal(await readFile(configPath, 'utf8'), before)
  assert.match(text(), /Remove it from the app \(Projects\), which also deletes its history/)
  assert.match(text(), /delete its entry from .*projects\.json/)
})

test('add and rm with nothing to name print how to call them and exit 2', async () => {
  const { home } = await world()
  assert.equal(await siteCommand({ env: 'prod', argv: ['add'], home, out: () => undefined }), 2)
  assert.equal(await siteCommand({ env: 'prod', argv: ['rm'], home, out: () => undefined }), 2)
})

// ---------------------------------------------------------------------------
// switching the module on, where it never was
// ---------------------------------------------------------------------------

const ABSENT = { ...BASE, modules: { example: { enabled: true } } }

test('WITH THE MODULE ABSENT, add switches it on with "Free prompt", restarts, and STILL exits 1 (criterion 7)', async () => {
  const { home, dir, configPath } = await world(ABSENT)
  const { calls, run } = recorder()
  const { out, text } = collector()

  const code = await siteCommand({ env: 'prod', argv: ['add', dir, '--yes'], home, out, run, uid: 501, platform: 'darwin' })

  assert.equal(code, 1, 'the project itself was not added')
  const config = await readConfig(configPath)
  assert.equal(config.modules['sessions']?.['enabled'], true)
  assert.deepEqual(config.modules['sessions']?.['catalog'], ON.catalog)
  assert.equal(rootConfigSchema.safeParse(config).success, true)
  assert.deepEqual(calls[1], ['launchctl', 'kickstart', '-k', 'gui/501/com.factotum.prod'])
  assert.match(text(), /switched the sessions module on/)
  assert.match(text(), /Add it from the app/)
})

test('switching it on asks first, and without a terminal or --yes writes NOTHING', async () => {
  const { home, dir, configPath } = await world(ABSENT)
  const before = await readFile(configPath, 'utf8')
  const { out, text } = collector()
  assert.equal(await siteCommand({ env: 'prod', argv: ['add', dir], home, out, run: recorder().run }), 1)
  assert.equal(await readFile(configPath, 'utf8'), before)
  assert.match(text(), /pass --yes/)

  const asked: string[] = []
  const no = collector()
  await siteCommand({ env: 'prod', argv: ['add', dir], home, out: no.out, ask: async (q) => (asked.push(q), 'n') })
  assert.match(asked[0] ?? '', /Switch it on\?/)
  assert.equal(await readFile(configPath, 'utf8'), before)
})

test('the question says when switching it on makes the config’s sites writable', async () => {
  const config = { ...BASE, modules: { sessions: { sites: [{ id: 'old', path: '/Users/me/old' }] } } }
  const { home, dir } = await world(config)
  const asked: string[] = []
  await siteCommand({ env: 'prod', argv: ['add', dir, '--no-restart'], home, out: () => undefined, ask: async (q) => (asked.push(q), 'y') })
  assert.match(asked[0] ?? '', /with the 1 site\(s\) already in the config/)
})

test('--no-restart switches it on and says it takes effect at the next start', async () => {
  const { home, dir } = await world(ABSENT)
  const { calls, run } = recorder()
  const { out, text } = collector()
  await siteCommand({ env: 'prod', argv: ['add', dir, '--yes', '--no-restart'], home, out, run, uid: 501, platform: 'darwin' })
  assert.deepEqual(calls.filter((c) => c[1] === 'kickstart'), [])
  assert.match(text(), /next start/)
})

test('AN `enabled: false` SOMEBODY WROTE is not overruled: nothing is written, and it says so', async () => {
  const { home, dir, configPath } = await world({ ...BASE, modules: { sessions: { ...ON, enabled: false } } })
  const before = await readFile(configPath, 'utf8')
  const { out, text } = collector()
  const code = await siteCommand({ env: 'prod', argv: ['add', dir, '--yes'], home, out, run: recorder().run, platform: 'linux' })
  assert.equal(code, 1)
  assert.equal(await readFile(configPath, 'utf8'), before)
  assert.match(text(), /switched off in the config/)
})

test('a config the module schema would refuse is not switched on over', async () => {
  const { home, dir, configPath } = await world({ ...BASE, modules: { sessions: { sites: [{ id: 'Bad Id', path: '/x' }] } } })
  const before = await readFile(configPath, 'utf8')
  const { out, text } = collector()
  assert.equal(await siteCommand({ env: 'prod', argv: ['add', dir, '--yes'], home, out }), 1)
  assert.equal(await readFile(configPath, 'utf8'), before)
  assert.match(text(), /sessions\.sites/)
})

// ---------------------------------------------------------------------------
// list: the registry, or the config before there is one
// ---------------------------------------------------------------------------

test('LIST READS THE REGISTRY when there is one, names included, and ignores the config (criterion 7)', async () => {
  const { home, registry } = await world({ ...BASE, modules: { sessions: { ...ON, sites: [{ id: 'old', path: '/Users/me/old' }] } } })
  await withRegistry(registry, {
    version: 1,
    projects: [{ id: 'web', path: '/Users/me/web', name: 'Web app' }, { path: 'no-id' }],
    shared: [{ path: '/Users/me/notes' }],
  })
  const { out, text } = collector()
  assert.equal(await siteCommand({ env: 'prod', argv: ['list'], home, out }), 0)
  assert.match(text(), /web +\/Users\/me\/web {2}\(Web app\)/)
  assert.match(text(), /\(shared\) +\/Users\/me\/notes/)
  assert.match(text(), /skipped projects\[1\]/)
  assert.doesNotMatch(text(), /\/Users\/me\/old/)

  const json = collector()
  await siteCommand({ env: 'prod', argv: ['list', '--json'], home, out: json.out })
  const parsed = JSON.parse(json.text()) as { source: string; sites: { id: string }[]; sharedPaths: string[] }
  assert.equal(parsed.source, 'registry')
  assert.deepEqual(parsed.sites.map((s) => s.id), ['web'])
  assert.deepEqual(parsed.sharedPaths, ['/Users/me/notes'])
})

test('with no registry yet, list shows the config — what the daemon will seed it with', async () => {
  const { home } = await world({ ...BASE, modules: { sessions: { ...ON, sites: [{ id: 'old', path: '/Users/me/old' }] } } })
  const { out, text } = collector()
  await siteCommand({ env: 'prod', argv: ['list', '--json'], home, out })
  assert.deepEqual(JSON.parse(text()).sites, [{ id: 'old', path: '/Users/me/old' }])
  assert.equal(JSON.parse(text()).source, 'config')
})

test('list with nothing declared says what that means', async () => {
  const { home } = await world()
  const { out, text } = collector()
  await siteCommand({ env: 'prod', argv: ['list'], home, out })
  assert.match(text(), /nowhere it may write/)
  assert.match(text(), /seeds it from the config/)
})

test('a broken registry is said, with how to fix it, and exits 1', async () => {
  const { home, registry } = await world()
  await withRegistry(registry, '{ nope')
  const { out, text } = collector()
  assert.equal(await siteCommand({ env: 'prod', argv: ['list'], home, out }), 1)
  assert.match(text(), /registry is broken/)
})

test('with no config it points at init rather than writing one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-site-'))
  const { out, text } = collector()
  const code = await siteCommand({ env: 'prod', argv: ['list'], home, out })
  assert.equal(code, 1)
  assert.match(text(), /factotum init --env prod/)
})

test('a config that is not JSON is said, not thrown', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-site-'))
  const paths = statePaths('prod', home)
  await mkdir(paths.root, { recursive: true })
  await writeFile(paths.config, '{ nope', 'utf8')
  const { out, text } = collector()
  assert.equal(await siteCommand({ env: 'prod', argv: ['add', '/x'], home, out }), 1)
  assert.match(text(), /not valid JSON/)
})

test('an unknown subcommand prints the usage and exits 2', async () => {
  const { out, text } = collector()
  assert.equal(await siteCommand({ env: 'prod', argv: ['frobnicate'], out }), 2)
  assert.match(text(), /factotum site add <path>/)
})

test('stripEnvFlag removes --env and its value, and touches nothing otherwise', () => {
  assert.deepEqual(stripEnvFlag(['list', '--env', 'dev', '--json']), ['list', '--json'])
})

test('with no --env present the subcommand SURVIVES', () => {
  assert.deepEqual(stripEnvFlag(['add', '/x']), ['add', '/x'])
})
