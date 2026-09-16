import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { statePaths } from '@factotum/kernel'
import { rootConfigSchema } from '@factotum/core'
import { siteCommand, stripEnvFlag } from './site-command.ts'
import type { RunResult, Runner } from './tailscale.ts'

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

const BASE = {
  environment: 'prod',
  listen: { address: '127.0.0.1', port: 7777 },
  publicOrigin: 'https://mimac.tail1234.ts.net',
  modules: { example: { enabled: true } },
}

async function world(config: unknown = BASE) {
  const home = await mkdtemp(join(tmpdir(), 'factotum-site-'))
  const paths = statePaths('prod', home)
  await mkdir(paths.root, { recursive: true })
  await writeFile(paths.config, JSON.stringify(config, null, 2), 'utf8')
  const dir = join(home, 'work')
  await mkdir(dir, { recursive: true })
  return { home, dir, configPath: paths.config }
}

const collector = () => {
  const lines: string[] = []
  return { lines, out: (line: string) => lines.push(line), text: () => lines.join('\n') }
}

interface Fragment {
  readonly enabled?: boolean
  readonly sites?: { id: string; path: string }[]
  readonly sharedPaths?: string[]
  readonly catalog?: { id: string }[]
}

const readConfig = async (path: string) =>
  JSON.parse(await readFile(path, 'utf8')) as { modules: Record<string, Fragment | undefined> }

const sessionsOf = async (path: string): Promise<Fragment> => (await readConfig(path)).modules['sessions'] ?? {}

// ---------------------------------------------------------------------------
// It widens the permission boundary, so it asks
// ---------------------------------------------------------------------------

test('without a terminal and without --yes it writes NOTHING', async () => {
  // The case that matters: a script, or an agent with a shell, running this
  // unattended. Assuming consent here is how a boundary grows without a decision.
  const { home, dir, configPath } = await world()
  const { out, text } = collector()

  const code = await siteCommand({ env: 'prod', argv: ['add', dir], home, out })

  assert.equal(code, 0)
  assert.match(text(), /--yes/)
  assert.equal((await readConfig(configPath)).modules['sessions'], undefined)
})

test('answering no leaves the config untouched', async () => {
  const { home, dir, configPath } = await world()
  const { out, text } = collector()

  await siteCommand({ env: 'prod', argv: ['add', dir], home, out, ask: async () => 'n' })

  assert.match(text(), /Nothing was written/)
  assert.equal((await readConfig(configPath)).modules['sessions'], undefined)
})

test('the question names what is being granted, not just "continue?"', async () => {
  const { home, dir } = await world()
  const asked: string[] = []
  await siteCommand({
    env: 'prod',
    argv: ['add', dir],
    home,
    out: () => undefined,
    ask: async (q) => {
      asked.push(q)
      return 'n'
    },
  })
  assert.match(asked[0] ?? '', /write in site "work"/)
})

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

test('add writes a config that VALIDATES, with the id derived from the directory', async () => {
  const { home, dir, configPath } = await world()
  const { run } = recorder(fails) // not installed: restart is a no-op
  const { out } = collector()

  const code = await siteCommand({
    env: 'prod',
    argv: ['add', dir, '--yes'],
    home,
    out,
    run,
    uid: 501,
    platform: 'darwin',
  })

  assert.equal(code, 0)
  const written = await readConfig(configPath)
  assert.equal(rootConfigSchema.safeParse(written).success, true)
  const sessions = await sessionsOf(configPath)
  assert.deepEqual(sessions.sites, [{ id: 'work', path: dir }])
  assert.equal(sessions.enabled, true)
})

test('--shared adds to sharedPaths and says the thing about locks out loud', async () => {
  const { home, dir, configPath } = await world()
  const { out, text } = collector()

  await siteCommand({
    env: 'prod',
    argv: ['add', dir, '--shared', '--yes', '--no-restart'],
    home,
    out,
  })

  assert.deepEqual((await sessionsOf(configPath)).sharedPaths, [dir])
  assert.match(text(), /nothing locks a shared path/i)
})

test('a directory that does not exist is refused BEFORE the config is touched', async () => {
  // The daemon would refuse it at startup, with the module disabled. Saying it now
  // means the person who typed the path is still there to fix it.
  const { home, configPath } = await world()
  const { out, text } = collector()

  const code = await siteCommand({ env: 'prod', argv: ['add', '/no/such/dir', '--yes'], home, out })

  assert.equal(code, 1)
  assert.match(text(), /is not a directory that exists/)
  assert.equal((await readConfig(configPath)).modules['sessions'], undefined)
})

test('a second site with the same id is refused and nothing is written', async () => {
  const { home, dir, configPath } = await world()
  const argv = ['add', dir, '--yes', '--no-restart']
  await siteCommand({ env: 'prod', argv, home, out: () => undefined })

  const { out, text } = collector()
  const code = await siteCommand({ env: 'prod', argv, home, out })

  assert.equal(code, 1)
  assert.match(text(), /already declared as "work"/)
  assert.equal((await sessionsOf(configPath)).sites?.length, 1)
})

test('an existing sessions block keeps its catalog and its other sites', async () => {
  const existing = {
    ...BASE,
    modules: {
      example: { enabled: true },
      sessions: {
        enabled: true,
        sites: [{ id: 'notes', path: '/tmp' }],
        catalog: [{ id: 'review', label: 'Review', invoke: { kind: 'command', name: 'code-review' } }],
      },
    },
  }
  const { home, dir, configPath } = await world(existing)

  await siteCommand({ env: 'prod', argv: ['add', dir, '--yes', '--no-restart'], home, out: () => undefined })

  const sessions = await sessionsOf(configPath)
  assert.deepEqual((sessions.sites ?? []).map((s) => s.id), ['notes', 'work'])
  assert.deepEqual((sessions.catalog ?? []).map((c) => c.id), ['review'])
})

// ---------------------------------------------------------------------------
// The restart, which is the point of the command existing
// ---------------------------------------------------------------------------

test('after writing, it kickstarts the LaunchAgent for this environment', async () => {
  const { home, dir } = await world()
  const { calls, run } = recorder()
  const { out, text } = collector()

  await siteCommand({ env: 'prod', argv: ['add', dir, '--yes'], home, out, run, uid: 501, platform: 'darwin' })

  assert.deepEqual(calls[0], ['launchctl', 'print', 'gui/501/com.factotum.prod'])
  assert.deepEqual(calls[1], ['launchctl', 'kickstart', '-k', 'gui/501/com.factotum.prod'])
  assert.match(text(), /restarted com\.factotum\.prod/)
})

test('--no-restart writes and says the daemon still has the old boundary', async () => {
  const { home, dir } = await world()
  const { calls, run } = recorder()
  const { out, text } = collector()

  await siteCommand({
    env: 'prod',
    argv: ['add', dir, '--yes', '--no-restart'],
    home,
    out,
    run,
    uid: 501,
    platform: 'darwin',
  })

  assert.deepEqual(calls, [], 'launchctl must not be called')
  assert.match(text(), /old boundary/)
})

test('when nothing is installed it says so instead of claiming a restart', async () => {
  const { home, dir } = await world()
  const { run } = recorder(fails)
  const { out, text } = collector()

  await siteCommand({ env: 'prod', argv: ['add', dir, '--yes'], home, out, run, uid: 501, platform: 'darwin' })

  assert.match(text(), /not installed as a/)
  assert.doesNotMatch(text(), /restarted/)
})

test('off macOS it prints what to run rather than guessing the supervisor', async () => {
  const { home, dir } = await world()
  const { calls, run } = recorder()
  const { out, text } = collector()

  await siteCommand({ env: 'prod', argv: ['add', dir, '--yes'], home, out, run, uid: 1000, platform: 'linux' })

  assert.deepEqual(calls, [])
  assert.match(text(), /systemctl --user restart/)
})

// ---------------------------------------------------------------------------
// list and rm
// ---------------------------------------------------------------------------

test('list --json is machine readable, which is how an agent reads it', async () => {
  const { home, dir } = await world()
  await siteCommand({ env: 'prod', argv: ['add', dir, '--yes', '--no-restart'], home, out: () => undefined })

  const { out, text } = collector()
  await siteCommand({ env: 'prod', argv: ['list', '--json'], home, out })

  assert.deepEqual(JSON.parse(text()), { sites: [{ id: 'work', path: dir }], sharedPaths: [] })
})

test('list with nothing declared says what that means', async () => {
  const { home } = await world()
  const { out, text } = collector()
  await siteCommand({ env: 'prod', argv: ['list'], home, out })
  assert.match(text(), /nowhere it may write/)
})

test('rm takes a site id or a shared path, and warns about the live session', async () => {
  const { home, dir, configPath } = await world()
  await siteCommand({ env: 'prod', argv: ['add', dir, '--yes', '--no-restart'], home, out: () => undefined })

  const { out, text } = collector()
  const code = await siteCommand({ env: 'prod', argv: ['rm', 'work', '--no-restart'], home, out })

  assert.equal(code, 0)
  assert.deepEqual((await sessionsOf(configPath)).sites, [])
  assert.match(text(), /denied on its next write/)
})

test('rm of something undeclared fails instead of succeeding quietly', async () => {
  const { home } = await world()
  const { out, text } = collector()
  const code = await siteCommand({ env: 'prod', argv: ['rm', 'ghost'], home, out })
  assert.equal(code, 1)
  assert.match(text(), /no site or shared path "ghost"/)
})

test('with no config it points at init rather than writing one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-site-'))
  const { out, text } = collector()
  const code = await siteCommand({ env: 'prod', argv: ['list'], home, out })
  assert.equal(code, 1)
  assert.match(text(), /factotum init --env prod/)
})

test('an unknown subcommand prints the usage and exits 2', async () => {
  const { out, text } = collector()
  assert.equal(await siteCommand({ env: 'prod', argv: ['frobnicate'], out }), 2)
  assert.match(text(), /factotum site add <path>/)
})

// ---------------------------------------------------------------------------
// stripEnvFlag — the bug that only running it caught
// ---------------------------------------------------------------------------

test('stripEnvFlag removes --env and its value, and touches nothing otherwise', () => {
  assert.deepEqual(stripEnvFlag(['add', '/p', '--env', 'dev', '--yes']), ['add', '/p', '--yes'])
  assert.deepEqual(stripEnvFlag(['--env', 'prod', 'list']), ['list'])
})

test('with no --env present the subcommand SURVIVES', () => {
  // The first version filtered by index and `indexOf` returns -1, so `-1 + 1` dropped
  // argv[0]: every `factotum site …` printed the usage instead of running.
  assert.deepEqual(stripEnvFlag(['add', '/p', '--yes']), ['add', '/p', '--yes'])
  assert.deepEqual(stripEnvFlag(['list']), ['list'])
})
