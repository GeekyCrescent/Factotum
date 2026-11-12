import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { linkSession, startRun, stallRun } from './ops.ts'
import { openStore, type MockupsStore } from './store/store.ts'
import { createSubmitTool, SUBMIT_STAGE } from './submit.ts'
import { captureLog, captureNotify, mockup, NOW, OTHER_SESSION, SESSION, type CapturedLog, type CapturedNotify } from './test-support.ts'
import type { AgentToolResult, Mockup, Result } from './types.ts'

let root: string
let vaultDir: string
let workDir: string
let store: MockupsStore
let log: CapturedLog
let notify: CapturedNotify

const value = (r: Result<Mockup>): Mockup => {
  if (!r.ok) throw new Error(r.error.reason)
  return r.value
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mockups-submit-')))
  vaultDir = join(root, 'vault', 'acme', 'mockup')
  workDir = join(root, 'work', 'Acme')
  await mkdir(vaultDir, { recursive: true })
  await mkdir(workDir, { recursive: true })
  const opened = await openStore({ dir: join(root, 'state'), now: NOW, log: captureLog() })
  assert.ok(opened.ok)
  store = opened.store
  log = captureLog()
  notify = captureNotify()
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function seed(transform: (m: Mockup) => Mockup = (m) => m): Promise<void> {
  const base = value(startRun(mockup({ id: 'm1', name: 'MTC app', vaultDir, workDir }), { kind: 'brief', runId: 'r1', siteId: 'personal' }, NOW))
  const m = transform(base)
  await store.change((file) => ({ ok: true, value: { file: { ...file, mockups: [m] } } }))
}

function tool() {
  return createSubmitTool({ store, now: () => NOW, log, notify, caseInsensitive: false })
}

async function call(raw: unknown, who: { sessionId?: string; siteId?: string } = {}): Promise<AgentToolResult> {
  return await tool().call({ sessionId: who.sessionId ?? SESSION, siteId: who.siteId ?? 'personal', toolUseId: 't', name: SUBMIT_STAGE, raw })
}

const textOf = (result: AgentToolResult): string => result.content.map((c) => c.text).join('')
const brief = () => store.current().mockups[0]?.stages.brief

test('the family lists one tool, submit_stage, with its schema', () => {
  const tools = tool().tools()
  assert.deepEqual(
    tools.map((t) => t.name),
    [SUBMIT_STAGE],
  )
})

test('another tool name is refused', async () => {
  const result = await tool().call({ sessionId: SESSION, siteId: 'personal', toolUseId: 't', name: 'nope', raw: {} })
  assert.equal(result.isError, true)
})

test('arguments that are not the shape are refused with the field', async () => {
  await seed()
  const result = await call({ runId: 'r1' })
  assert.equal(result.isError, true)
  assert.match(textOf(result), /files/)
})

test('crit. 16, check 1: a run that does not exist is refused, and nothing changes', async () => {
  await seed()
  await writeFile(join(vaultDir, '01-brief.md'), '# Brief')
  const result = await call({ runId: 'nope', files: ['01-brief.md'], summary: 's' })
  assert.equal(result.isError, true)
  assert.match(textOf(result), /no live run/)
  assert.equal(brief()?.status, 'running')
})

test('crit. 16, check 2: another site than the run’s is refused', async () => {
  await seed()
  await writeFile(join(vaultDir, '01-brief.md'), '# Brief')
  const result = await call({ runId: 'r1', files: ['01-brief.md'], summary: 's' }, { siteId: 'other' })
  assert.equal(result.isError, true)
  assert.match(textOf(result), /project/)
  assert.equal(brief()?.status, 'running')
})

test('crit. 16, check 2: another session than the one linked is refused', async () => {
  await seed((m) => value(linkSession(m, 'r1', OTHER_SESSION, NOW)))
  await writeFile(join(vaultDir, '01-brief.md'), '# Brief')
  const result = await call({ runId: 'r1', files: ['01-brief.md'], summary: 's' })
  assert.equal(result.isError, true)
  assert.match(textOf(result), /another session/)
  assert.equal(brief()?.status, 'running')
})

test('crit. 16, check 3: a required file missing from the list or from the disk is refused', async () => {
  await seed()
  const missing = await call({ runId: 'r1', files: ['01-brief.md'], summary: 's' })
  assert.equal(missing.isError, true)
  assert.match(textOf(missing), /01-brief\.md does not exist/)
  await writeFile(join(vaultDir, 'other.md'), 'x')
  const unnamed = await call({ runId: 'r1', files: ['other.md'], summary: 's' })
  assert.match(textOf(unnamed), /must include 01-brief\.md/)
  assert.equal(brief()?.status, 'running')
})

test('crit. 16, check 3: an empty file is refused', async () => {
  await seed()
  await writeFile(join(vaultDir, '01-brief.md'), '  \n')
  const result = await call({ runId: 'r1', files: ['01-brief.md'], summary: 's' })
  assert.match(textOf(result), /01-brief\.md is empty/)
})

test('crit. 16, check 3: a file whose real path falls outside the mockup folders is refused', async () => {
  await seed()
  await writeFile(join(vaultDir, '01-brief.md'), '# Brief')
  await writeFile(join(root, 'secret.md'), 'x')
  await symlink(join(root, 'secret.md'), join(vaultDir, 'link.md'))
  const linked = await call({ runId: 'r1', files: ['01-brief.md', 'link.md'], summary: 's' })
  assert.match(textOf(linked), /link\.md is outside/)
  const climbing = await call({ runId: 'r1', files: ['01-brief.md', '../../../secret.md'], summary: 's' })
  assert.match(textOf(climbing), /is outside/)
  const absolute = await call({ runId: 'r1', files: ['01-brief.md', join(root, 'secret.md')], summary: 's' })
  assert.match(textOf(absolute), /is outside/)
  assert.equal(brief()?.status, 'running')
})

test('a file of the work-dir is found there', async () => {
  await seed()
  await writeFile(join(vaultDir, '01-brief.md'), '# Brief')
  await writeFile(join(workDir, 'extra.txt'), 'x')
  const result = await call({ runId: 'r1', files: ['01-brief.md', 'extra.txt'], summary: 's' })
  assert.equal(result.isError, undefined)
})

test('accepted: waiting, version 1, linked, one push with a fixed body and nothing of the content (crit. 26)', async () => {
  await seed()
  await writeFile(join(vaultDir, '01-brief.md'), '# Brief')
  const result = await call({ runId: 'r1', files: ['01-brief.md'], summary: 'confidential summary of the RFP' })
  assert.equal(result.isError, undefined)
  assert.equal(textOf(result), 'Submitted. The owner will review it. End your turn now.')
  assert.equal(brief()?.status, 'waiting')
  assert.equal(brief()?.version, 1)
  assert.deepEqual(notify.sent, [{ title: 'MTC app: brief ready', body: 'Tap to review.', path: '/m/mockups/m1/brief', tag: 'mockups-gate-m1-brief' }])
  assert.deepEqual(log.lines, ['info mockup m1: brief run r1 submitted, version 1, waiting'])
  assert.ok(!JSON.stringify(notify.sent).includes('confidential'))
  assert.ok(!log.lines.join().includes('confidential'))
})

test('crit. 26: with no device to reach, no push is sent', async () => {
  notify = captureNotify(false)
  await seed()
  await writeFile(join(vaultDir, '01-brief.md'), '# Brief')
  await call({ runId: 'r1', files: ['01-brief.md'], summary: 's' })
  assert.deepEqual(notify.sent, [])
})

test('crit. 17, 18: a stalled run without a session is accepted, and its session is the one that submitted', async () => {
  await seed((m) => value(stallRun(m, 'r1', NOW)))
  await writeFile(join(vaultDir, '01-brief.md'), '# Brief')
  const result = await call({ runId: 'r1', files: ['01-brief.md'], summary: 's' })
  assert.equal(result.isError, undefined)
  assert.equal(brief()?.status, 'waiting')
})

test('a second submission of the same run is refused: it is no longer live', async () => {
  await seed()
  await writeFile(join(vaultDir, '01-brief.md'), '# Brief')
  await call({ runId: 'r1', files: ['01-brief.md'], summary: 's' })
  const again = await call({ runId: 'r1', files: ['01-brief.md'], summary: 's' })
  assert.match(textOf(again), /no live run/)
  assert.equal(notify.sent.length, 1)
})
