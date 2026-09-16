import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bootoutArgs,
  bootstrapArgs,
  composePlist,
  labelFor,
  logPaths,
  plistPath,
  type PlistInput,
} from './supervise.ts'
import { install, uninstall } from './install.ts'
import type { RunResult, Runner } from './tailscale.ts'

const base: PlistInput = {
  env: 'prod',
  nodePath: '/opt/homebrew/bin/node',
  mainPath: '/Users/you/Factotum/packages/cli/dist/main.js',
  stateRoot: '/Users/you/.factotum/prod',
  path: '/opt/homebrew/bin:/usr/bin:/bin',
}

// ---------------------------------------------------------------------------
// The three keys that get forgotten, asserted rather than eyeballed
// ---------------------------------------------------------------------------

test('RunAtLoad is true — without it the job never starts at login', () => {
  // THE REGRESSION THIS EXISTS TO CATCH. With `KeepAlive` as a boolean, launchd
  // starts the job on load as a side effect of keeping it alive. Switching to the
  // dictionary form below takes that away, so a plist with the dictionary and no
  // RunAtLoad survives a crash and never comes up at login — which is the only
  // reason anyone installs it.
  const plist = composePlist(base)
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/)
})

test('KeepAlive is a DICTIONARY, not true, so a broken config stays down visibly', () => {
  // As `true`, launchd restarts unconditionally: a config the daemon refuses to boot
  // on becomes a silent restart loop instead of a failure someone can see.
  const plist = composePlist(base)
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>Crashed<\/key>\s*<true\/>\s*<\/dict>/)
  assert.doesNotMatch(plist, /<key>KeepAlive<\/key>\s*<true\/>/)
})

test('the captured PATH is in the plist, or every session dies with ENOENT', () => {
  // `packages/sessions/src/run.ts` launches `claude` BY NAME, and a LaunchAgent
  // inherits launchd's minimal PATH. Without this the daemon is perfectly healthy and
  // every session fails — which is why checking that the daemon is up does not cover it.
  const plist = composePlist(base)
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/)
})

// ---------------------------------------------------------------------------
// dev and prod must not collide
// ---------------------------------------------------------------------------

test('dev and prod get different labels, or installing one evicts the other', () => {
  assert.equal(labelFor('prod'), 'com.factotum.prod')
  assert.equal(labelFor('dev'), 'com.factotum.dev')
  assert.notEqual(labelFor('prod'), labelFor('dev'))
})

test('dev and prod get different plist paths', () => {
  assert.notEqual(plistPath('/Users/you', 'prod'), plistPath('/Users/you', 'dev'))
  assert.match(plistPath('/Users/you', 'prod'), /Library\/LaunchAgents\/com\.factotum\.prod\.plist$/)
})

test('dev and prod get different log paths, so they do not interleave', () => {
  const prod = logPaths('/Users/you/.factotum/prod')
  const dev = logPaths('/Users/you/.factotum/dev')
  assert.notEqual(prod.out, dev.out)
  assert.notEqual(prod.err, dev.err)
  // Under the env's state root: StatePaths has `root`, `config` and `modules`, and
  // there is no `stateDir` to reach for.
  assert.match(prod.out, /\.factotum\/prod\//)
})

test('the plist runs THIS environment, both as an argument and in the environment', () => {
  const dev = composePlist({ ...base, env: 'dev', stateRoot: '/Users/you/.factotum/dev' })
  assert.match(dev, /<string>--env<\/string>\s*<string>dev<\/string>/)
  assert.match(dev, /<key>FACTOTUM_ENV<\/key>\s*<string>dev<\/string>/)
})

test('it wraps `factotum start` rather than replacing it', () => {
  const plist = composePlist(base)
  assert.match(plist, /<string>start<\/string>/)
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/)
})

test('a path with an ampersand does not produce invalid XML', () => {
  const plist = composePlist({ ...base, path: '/opt/a&b/bin' })
  assert.match(plist, /<string>\/opt\/a&amp;b\/bin<\/string>/)
})

// ---------------------------------------------------------------------------
// bootstrap and bootout are NOT symmetric. This is where the first attempt fails.
// ---------------------------------------------------------------------------

test('bootstrap takes a FILE PATH and bootout takes a SERVICE TARGET', () => {
  assert.deepEqual(bootstrapArgs(501, '/Users/you/Library/LaunchAgents/com.factotum.prod.plist'), [
    'bootstrap',
    'gui/501',
    '/Users/you/Library/LaunchAgents/com.factotum.prod.plist',
  ])
  assert.deepEqual(bootoutArgs(501, 'prod'), ['bootout', 'gui/501/com.factotum.prod'])
})

// ---------------------------------------------------------------------------
// install / uninstall
// ---------------------------------------------------------------------------

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

test('install writes the plist and bootstraps it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-sup-'))
  const { calls, run } = recorder()

  const code = await install({
    env: 'prod',
    home,
    run,
    uid: 501,
    platform: 'darwin',
    mainPath: '/somewhere/main.js',
    path: '/usr/bin',
    out: () => undefined,
  })

  assert.equal(code, 0)
  const written = await readFile(plistPath(home, 'prod'), 'utf8')
  assert.match(written, /com\.factotum\.prod/)
  assert.match(written, /<key>RunAtLoad<\/key>\s*<true\/>/)

  // bootout first so that re-installing does not need two commands.
  assert.deepEqual(calls[0], ['launchctl', 'bootout', 'gui/501/com.factotum.prod'])
  assert.equal(calls[1]?.[1], 'bootstrap')
})

test('install creates the LOG DIRECTORY, because launchd will not', async () => {
  // If StandardOutPath's directory is missing the job fails to start, and it fails
  // without writing anything to the log it could not open.
  const home = await mkdtemp(join(tmpdir(), 'factotum-sup-'))
  const { run } = recorder()

  await install({
    env: 'prod',
    home,
    run,
    uid: 501,
    platform: 'darwin',
    mainPath: '/somewhere/main.js',
    path: '/usr/bin',
    out: () => undefined,
  })

  const { out } = logPaths(join(home, '.factotum', 'prod'))
  // The directory must exist; the log file itself is launchd's to create.
  await assert.doesNotReject(() => readFile(join(home, '.factotum', 'prod'), 'utf8').catch((e) => {
    if ((e as NodeJS.ErrnoException).code === 'EISDIR') return ''
    throw e
  }))
  assert.match(out, /daemon\.log$/)
})

test('install reports a launchctl refusal instead of claiming success', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-sup-'))
  const lines: string[] = []
  const run: Runner = async (_cmd, args) => (args[0] === 'bootstrap' ? fails : ok)

  const code = await install({
    env: 'prod',
    home,
    run,
    uid: 501,
    platform: 'darwin',
    mainPath: '/somewhere/main.js',
    path: '/usr/bin',
    out: (l) => lines.push(l),
  })

  assert.equal(code, 1)
  assert.match(lines.join('\n'), /refused to load/)
})

test('uninstall boots the service out and removes the plist', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-sup-'))
  const { calls, run } = recorder()
  await install({ env: 'prod', home, run, uid: 501,
    platform: 'darwin', mainPath: '/m.js', path: '/usr/bin', out: () => undefined })
  calls.length = 0

  const code = await uninstall({ env: 'prod', home, run, uid: 501, platform: 'darwin', out: () => undefined })

  assert.equal(code, 0)
  assert.deepEqual(calls[0], ['launchctl', 'bootout', 'gui/501/com.factotum.prod'])
  await assert.rejects(() => readFile(plistPath(home, 'prod'), 'utf8'))
})

test('on Linux it refuses instead of writing a plist nothing will ever read', async () => {
  // Without this, `install` on Linux writes `~/Library/LaunchAgents/…` — a directory
  // that means nothing there — and then fails on a `launchctl` that does not exist,
  // with ENOENT. The plist stays behind. This is the first thing anyone trying
  // factotum on a second machine hits, so it says what to do instead.
  const home = await mkdtemp(join(tmpdir(), 'factotum-sup-'))
  const { calls, run } = recorder()
  const lines: string[] = []

  const code = await install({
    env: 'prod',
    home,
    run,
    uid: 1000,
    mainPath: '/m.js',
    path: '/usr/bin',
    platform: 'linux',
    out: (line) => lines.push(line),
  })

  assert.equal(code, 1)
  assert.deepEqual(calls, [], 'launchctl must not be called')
  await assert.rejects(() => readFile(plistPath(home, 'prod'), 'utf8'), 'no plist left behind')
  const text = lines.join('\n')
  assert.match(text, /macOS/)
  assert.match(text, /systemd/)
  assert.match(text, /factotum start/)
})

test('uninstall refuses on Linux too, rather than removing a file it never wrote', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-sup-'))
  const { calls, run } = recorder()

  const code = await uninstall({ env: 'prod', home, run, uid: 1000, platform: 'linux', out: () => undefined })

  assert.equal(code, 1)
  assert.deepEqual(calls, [])
})

test('uninstalling something that was never loaded is quiet and still exits 0', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-sup-'))
  const run: Runner = async () => fails

  const code = await uninstall({ env: 'prod', home, run, uid: 501, platform: 'darwin', out: () => undefined })
  assert.equal(code, 0)
})
