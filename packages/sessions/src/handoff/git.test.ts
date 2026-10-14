import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitIn, git, remoteWithClones } from '../test-git.ts'
import { runGit } from '../git.ts'
import {
  GIT_HANDOFF_TIMEOUT_MS,
  HANDOFF_GIT_CONFIG,
  handoffEnv,
  handoffGit,
  handoffTimeoutMs,
  ignoreDigest,
  remoteKey,
} from './git.ts'
import { GIT_LOCAL_TIMEOUT_MS, GIT_NET_TIMEOUT_MS } from '../git.ts'

// ---------------------------------------------------------------------------
// G1 — remoteKey (design D7): the four forms, all lower case, no `.git`
// ---------------------------------------------------------------------------

test('remoteKey reads the four forms of one remote as one key', () => {
  for (const url of [
    'git@github.com:GeekyCrescent/jarvis-vault.git',
    'ssh://git@github.com/GeekyCrescent/jarvis-vault',
    'ssh://git@github.com:22/GeekyCrescent/jarvis-vault.git',
    'https://github.com/GeekyCrescent/jarvis-vault',
    'https://user@github.com/GeekyCrescent/jarvis-vault.git/',
  ]) {
    assert.equal(remoteKey(url), 'github.com/geekycrescent/jarvis-vault', url)
  }
})

test('remoteKey lowers the host and the path: two remotes that differ only in case are one key', () => {
  assert.equal(remoteKey('git@GIT.BWR.MX:BWR/bwr_kizuna.git'), 'git.bwr.mx/bwr/bwr_kizuna')
  assert.equal(remoteKey('git@git.bwr.mx:bwr/BWR_KIZUNA'), remoteKey('ssh://git@git.bwr.mx/bwr/bwr_kizuna.git'))
})

test('remoteKey keeps a local path a path, so two clones of one bare remote pair up', () => {
  assert.equal(remoteKey('/tmp/x/remote.git'), '/tmp/x/remote')
  assert.equal(remoteKey('file:///tmp/x/remote.git'), '/tmp/x/remote')
})

test('remoteKey of nothing is undefined', () => {
  assert.equal(remoteKey(''), undefined)
  assert.equal(remoteKey('   '), undefined)
})

// ---------------------------------------------------------------------------
// G1d — the timeouts (design D10, «Timeouts»): one table, 60 s by default, never the 5 s
// ---------------------------------------------------------------------------

test('every handoff command gets its timeout from the one table, and an unknown one gets 60 s', () => {
  const slow = [
    ['checkout', '--no-overwrite-ignore', 'main'],
    ['merge', '--ff-only', '--no-overwrite-ignore', 'abc'],
    ['reset', '-q'],
    ['read-tree', 'HEAD'],
    ['read-tree', '-m', '-u', 'HEAD', 'abc'],
    ['commit-tree', 'abc', '-p', 'HEAD', '-m', 'x'],
    ['write-tree'],
    ['diff-files', '--quiet'],
    ['status', '--porcelain=v1', '-z', '--ignored'],
    ['add', '-A'],
    ['bundle', 'create', 'x'],
    ['fetch', '/some/code.bundle', 'refs/x/*:refs/x/*'],
    ['rev-list', '--count', 'HEAD'],
    ['clean', '-fd'],
    ['diff-tree', '-r', 'a', 'b'],
    ['something-new'],
  ]
  for (const args of slow) assert.equal(handoffTimeoutMs(args), GIT_HANDOFF_TIMEOUT_MS, args.join(' '))
  assert.equal(GIT_HANDOFF_TIMEOUT_MS, 60_000)
  // `fetch origin` is the network; `fetch <bundle>` is local and heavy (requirements §8, v4.3).
  assert.equal(handoffTimeoutMs(['fetch', 'origin']), GIT_NET_TIMEOUT_MS)
  assert.equal(handoffTimeoutMs(['fetch', '--quiet', 'origin']), GIT_NET_TIMEOUT_MS)
  for (const args of [['rev-parse', 'HEAD'], ['update-ref', 'refs/x', 'abc'], ['cat-file', '-e', 'abc^{commit}'], ['merge-base', '--is-ancestor', 'a', 'b'], ['for-each-ref'], ['config', '--get', 'x'], ['branch', '-D', 'x']]) {
    assert.equal(handoffTimeoutMs(args), GIT_LOCAL_TIMEOUT_MS, args.join(' '))
  }
})

// ---------------------------------------------------------------------------
// G1b — HANDOFF_GIT_CONFIG (design D10, guardrail 13): no hooks, no maintenance, BY THE ENVIRONMENT
// ---------------------------------------------------------------------------

test('the handoff config travels in GIT_CONFIG_COUNT/KEY/VALUE, never as -c, and appends to one already there', () => {
  const env = handoffEnv({ PATH: '/bin' })
  assert.equal(env['GIT_CONFIG_COUNT'], String(HANDOFF_GIT_CONFIG.length))
  const pairs = HANDOFF_GIT_CONFIG.map((_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]])
  assert.deepEqual(pairs, HANDOFF_GIT_CONFIG.map(([key, value]) => [key, value]))
  assert.deepEqual(Object.fromEntries(HANDOFF_GIT_CONFIG), {
    'core.hooksPath': '/dev/null',
    'maintenance.auto': 'false',
    'gc.auto': '0',
    'commit.gpgSign': 'false',
    'core.fsmonitor': 'false',
    'submodule.recurse': 'false',
  })
  assert.equal(env['PATH'], '/bin')

  const appended = handoffEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'x' })
  assert.equal(appended['GIT_CONFIG_COUNT'], String(HANDOFF_GIT_CONFIG.length + 1))
  assert.equal(appended['GIT_CONFIG_KEY_0'], 'user.name')
  assert.equal(appended['GIT_CONFIG_KEY_1'], 'core.hooksPath')
})

async function hookedClone() {
  const remote = await remoteWithClones()
  const marker = join(remote.home, 'hook-ran')
  const hooks = join(remote.site, '.git', 'hooks')
  for (const name of ['post-checkout', 'post-merge', 'reference-transaction']) {
    await writeFile(join(hooks, name), `#!/bin/sh\necho ${name} >> "${marker}"\n`)
    await chmod(join(hooks, name), 0o755)
  }
  return { remote, marker }
}

async function ran(marker: string): Promise<string> {
  return await readFile(marker, 'utf8').catch(() => '')
}

test('no hook of the repo runs in the handoff’s checkout, merge --ff-only or fetch (guardrail 13)', async () => {
  const { remote, marker } = await hookedClone()
  await commitIn(remote.other, 'b.md', 'b\n')
  await git(remote.other, 'push', '--quiet')

  await handoffGit(remote.site, ['fetch', 'origin'])
  await handoffGit(remote.site, ['checkout', '--no-overwrite-ignore', '-b', 'feature'])
  await handoffGit(remote.site, ['checkout', '--no-overwrite-ignore', 'main'])
  await handoffGit(remote.site, ['merge', '--ff-only', '--no-overwrite-ignore', 'origin/main'])
  assert.equal(await ran(marker), '')

  // The same commands without the handoff's config do run them: the test can see a hook.
  await runGit(['checkout', '-b', 'other'], 5_000, remote.site)
  assert.match(await ran(marker), /post-checkout/)
})

test('a handoff fetch still reads core.sshCommand first: args[0] is `fetch`, not `-c`', async () => {
  const remote = await remoteWithClones()
  const marker = join(remote.home, 'ssh-ran')
  const ssh = join(remote.home, 'fake-ssh')
  await writeFile(ssh, `#!/bin/sh\necho ran > "${marker}"\nexit 1\n`)
  await chmod(ssh, 0o755)
  await git(remote.site, 'config', 'core.sshCommand', ssh)
  await git(remote.site, 'remote', 'set-url', 'origin', 'ssh://git@example.invalid/x.git')

  await assert.rejects(handoffGit(remote.site, ['fetch', 'origin']))
  // With GIT_SSH_COMMAND forced to BatchMode, the repo's own command would never have run.
  assert.equal((await ran(marker)).trim(), 'ran')
})

test('the pull before a launch (D5) runs WITHOUT the handoff config', async () => {
  const freshness = await readFile(new URL('../freshness.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(freshness, /handoff/i)
})

// ---------------------------------------------------------------------------
// G1c — ignoreDigest (design D10, «Las reglas de ignorar de cada host»)
// ---------------------------------------------------------------------------

async function bareHome() {
  const home = await mkdtemp(join(tmpdir(), 'factotum-ignore-home-'))
  const xdg = join(home, 'xdg')
  const globalConfig = join(home, 'gitconfig')
  await writeFile(globalConfig, '')
  // Nothing of the machine running the test: its own ~/.config/git/ignore must not count.
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }
  return { home, xdg, globalConfig, env }
}

async function freshRepo(env: NodeJS.ProcessEnv): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'factotum-ignore-'))
  await runGit(['init', '--quiet'], 5_000, dir, env)
  return dir
}

test('with no excludesFile and no rules in info/exclude, two fresh repos digest the same: git init’s template does not count', async () => {
  const { env } = await bareHome()
  const a = await ignoreDigest(await freshRepo(env), env)
  const b = await ignoreDigest(await freshRepo(env), env)
  assert.deepEqual(a, { global: 'none', info: 'none' })
  assert.deepEqual(a, b)
})

test('a line in .git/info/exclude changes `info`; a core.excludesFile changes `global`', async () => {
  const { env, home, globalConfig } = await bareHome()
  const repo = await freshRepo(env)
  const before = await ignoreDigest(repo, env)
  await writeFile(join(repo, '.git', 'info', 'exclude'), '# a comment\nobsidian_askpass.sh\n')
  const withInfo = await ignoreDigest(repo, env)
  assert.notEqual(withInfo.info, before.info)
  assert.equal(withInfo.global, 'none')

  const excludes = join(home, 'my-ignore')
  await writeFile(excludes, '**/.claude/settings.local.json\n')
  await writeFile(globalConfig, `[core]\n\texcludesFile = ${excludes}\n`)
  const withGlobal = await ignoreDigest(repo, env)
  assert.notEqual(withGlobal.global, 'none')
  assert.equal(withGlobal.info, withInfo.info)
})

test('without core.excludesFile, $XDG_CONFIG_HOME/git/ignore is the global file', async () => {
  const { env, xdg } = await bareHome()
  const repo = await freshRepo(env)
  await mkdir(join(xdg, 'git'), { recursive: true })
  await writeFile(join(xdg, 'git', 'ignore'), '*.log\n')
  assert.notEqual((await ignoreDigest(repo, env)).global, 'none')
})

test('a comment or an empty line more changes nothing; the order does', async () => {
  const { env } = await bareHome()
  const repo = await freshRepo(env)
  const exclude = join(repo, '.git', 'info', 'exclude')
  await writeFile(exclude, 'a\nb\n')
  const plain = await ignoreDigest(repo, env)
  await writeFile(exclude, '# hello\na\n\n   \nb\n# bye\n')
  assert.deepEqual(await ignoreDigest(repo, env), plain)
  await writeFile(exclude, 'b\na\n')
  assert.notEqual((await ignoreDigest(repo, env)).info, plain.info)
})
