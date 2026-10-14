import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ignoreDigest, remoteKey, sessionPaths } from '@factotum/sessions'
import { reportHandoff } from './doctor-handoff.ts'

const run$ = promisify(execFile)
const PEER = 'https://omarchy.tail1234.ts.net'

/** A bare remote and a clone of it, registered as `vault`, all with an empty global git config. */
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'factotum-doctor-handoff-'))
  const globalConfig = join(home, 'gitconfig')
  await writeFile(globalConfig, '')
  const env = { PATH: process.env['PATH'], HOME: home, XDG_CONFIG_HOME: join(home, 'xdg'), GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }
  const bare = join(home, 'remote.git')
  const clone = join(home, 'vault')
  await run$('git', ['init', '--quiet', '--bare', bare], { env })
  await run$('git', ['clone', '--quiet', bare, clone], { env })
  const stateDir = join(home, 'state')
  await mkdir(stateDir, { recursive: true })
  const registry = join(stateDir, 'projects.json')
  await writeFile(registry, JSON.stringify({ version: 1, projects: [{ id: 'vault', path: clone }], shared: [] }))
  return { home, env, bare, clone, stateDir, registry }
}

type Setup = Awaited<ReturnType<typeof setup>>

function peerAnswering(body: unknown, delayMs = 0): typeof globalThis.fetch {
  return (async (url: string, init?: RequestInit) => {
    assert.equal(url, `${PEER}/modules/sessions/handoff/projects`)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs)
      init?.signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('aborted'))))
    })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
}

const down = (async () => {
  throw new Error('down')
}) as unknown as typeof globalThis.fetch

async function run(s: Setup, fetch: typeof globalThis.fetch, peerTimeoutMs?: number): Promise<string> {
  const lines: string[] = []
  await reportHandoff({ stateDir: s.stateDir, registry: s.registry, peers: [{ origin: PEER }], out: (line) => lines.push(line), fetch, gitEnv: s.env, ...(peerTimeoutMs !== undefined ? { peerTimeoutMs } : {}) })
  return lines.join('\n')
}

test('a project whose origin answers: «reads origin without asking»; one that does not: CANNOT READ (criterion 35)', async () => {
  const s = await setup()
  assert.match(await run(s, down), /vault\n\s+reads origin without asking/)
  await run$('git', ['remote', 'set-url', 'origin', join(s.home, 'gone.git')], { cwd: s.clone, env: s.env })
  assert.match(await run(s, down), /CANNOT READ origin without asking/)
})

test('the ignore rules against the peer’s: the same, different (and which), or not compared when it is down', async () => {
  const s = await setup()
  const key = remoteKey(s.bare)
  const same = await ignoreDigest(s.clone, s.env)
  assert.match(await run(s, peerAnswering([{ key, ignoreDigest: same }])), /ignore rules match omarchy/)
  assert.match(await run(s, peerAnswering([{ key, ignoreDigest: { ...same, info: 'other' } }])), /IGNORE RULES DIFFER from omarchy \(info\): see docs\/hosts\.md/)
  assert.match(await run(s, down), /ignore rules not compared: omarchy unreachable/)
  assert.match(await run(s, peerAnswering([{ key: 'github.com/else/where', ignoreDigest: same }])), /omarchy has no clone of it/)
})

test('a peer that takes its time is compared, not called unreachable: the read budget is not the probe’s 3 s (v4.3)', async () => {
  const s = await setup()
  const same = await ignoreDigest(s.clone, s.env)
  // 300 ms here stands for the 5 s of the task: what matters is that the budget is the handoff's.
  assert.match(await run(s, peerAnswering([{ key: remoteKey(s.bare), ignoreDigest: same }], 300)), /ignore rules match omarchy/)
  assert.match(await run(s, peerAnswering([], 300), 50), /not compared: omarchy unreachable/)
})

test('a journal in abort-failed is shown with its hid, its project, what is left, and its folder', async () => {
  const s = await setup()
  const hid = '0199e0c0-0000-7000-8000-0000000000ab'
  const paths = sessionPaths(s.stateDir)
  await mkdir(paths.handoffDir(hid), { recursive: true })
  await writeFile(
    paths.journalFile(hid, 'vault'),
    JSON.stringify({ hid, siteId: 'vault', role: 'target', peer: 'mac', phase: 'abort-failed', at: 'x', installed: [], replaced: [], stoppedServices: [], warnings: [], targetWarnings: [], leftovers: [{ step: 'restoreSession', kind: 'session', id: 'x' }] }),
  )
  const report = await run(s, down)
  assert.match(report, new RegExp(`${hid} vault ABORT-FAILED: left restoreSession`))
  assert.match(report, new RegExp(paths.handoffWork(hid, 'vault').replaceAll('/', '\\/')))
})

test('no registry, no projects: nothing to say, and no throw', async () => {
  const s = await setup()
  const lines: string[] = []
  await reportHandoff({ stateDir: s.stateDir, registry: join(s.home, 'none.json'), peers: [], out: (line) => lines.push(line), fetch: down, gitEnv: s.env })
  assert.deepEqual(lines, [])
})

test('a peer that answers 404 runs a factotum from before the handoff: said so, not "unreachable"', async () => {
  const s = await setup()
  const old = (async () => new Response('{}', { status: 404 })) as unknown as typeof globalThis.fetch
  assert.match(await run(s, old), /omarchy runs a factotum from before the handoff/)
})
