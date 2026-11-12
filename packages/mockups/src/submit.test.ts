import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { linkSession, requestChange, startRun, stallRun } from './ops.ts'
import { openStore, type MockupsStore } from './store/store.ts'
import { CHECK_REAL_DATA, createSubmitTool, SUBMIT_STAGE } from './submit.ts'
import { captureLog, captureNotify, mockup, NOW, OTHER_SESSION, SESSION, withStep, type CapturedLog, type CapturedNotify } from './test-support.ts'
import { STAGE_IDS, type AgentToolResult, type Mockup, type Result } from './types.ts'

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

test('the family lists submit_stage and check_real_data', () => {
  const tools = tool().tools()
  assert.deepEqual(
    tools.map((t) => t.name),
    [SUBMIT_STAGE, CHECK_REAL_DATA],
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

test('review: a required document written in the work-dir instead of the mockup folder is refused', async () => {
  await seed()
  await writeFile(join(workDir, '01-brief.md'), '# Brief in the wrong place')
  const result = await call({ runId: 'r1', files: ['01-brief.md'], summary: 's' })
  assert.match(textOf(result), /01-brief\.md does not exist in .*mockup/)
  assert.equal(brief()?.status, 'running')
})

test('review: a push that throws does not turn an accepted submission into a refusal', async () => {
  notify = { sent: [], canReach: () => true, send: async () => { throw new Error('push down') } } as unknown as CapturedNotify
  await seed()
  await writeFile(join(vaultDir, '01-brief.md'), '# Brief')
  const result = await call({ runId: 'r1', files: ['01-brief.md'], summary: 's' })
  assert.equal(result.isError, undefined)
  assert.equal(brief()?.status, 'waiting')
  assert.ok(log.lines.some((line) => line.startsWith('warn mockup m1: the gate push failed')))
})

/** A concepts run, with the brief approved before it. */
async function seedConcepts(): Promise<void> {
  await store.change((file) => {
    const base = withStep(withStep(mockup({ id: 'm1', name: 'MTC app', vaultDir, workDir }), 'brief', { status: 'done', version: 1 }), 'concepts', { status: 'ready' })
    return { ok: true, value: { file: { ...file, mockups: [value(startRun(base, { kind: 'concepts', runId: 'c1', siteId: 'personal' }, NOW))] } } }
  })
  await writeFile(join(vaultDir, '02-concepts.md'), '---\ntitle: Conceptos\n---\n# Conceptos\n')
}
const concepts = () => store.current().mockups[0]?.stages.concepts
const option = (id: string, extra: Record<string, string> = {}) => ({ id, title: `Concept ${id}`, blurb: `Blurb ${id}`, ...extra })

test('crit. 16, check 4: a choosing stage with no options, 1 or 4 is refused, and nothing changes', async () => {
  await seedConcepts()
  for (const options of [undefined, [option('a')], [option('a'), option('b'), option('c'), option('d')]]) {
    const result = await call({ runId: 'c1', files: ['02-concepts.md'], summary: 's', ...(options === undefined ? {} : { options }) })
    assert.equal(result.isError, true)
    assert.match(textOf(result), /2 or 3 options/)
  }
  assert.equal(concepts()?.status, 'running')
})

test('crit. 16, check 4: two options with the same id are refused', async () => {
  await seedConcepts()
  const result = await call({ runId: 'c1', files: ['02-concepts.md'], summary: 's', options: [option('a'), option('a')] })
  assert.match(textOf(result), /same id/)
})

test('crit. 16, check 4: a stage without options that sends some is refused', async () => {
  await seed()
  await writeFile(join(vaultDir, '01-brief.md'), '# Brief')
  const result = await call({ runId: 'r1', files: ['01-brief.md'], summary: 's', options: [option('a'), option('b')] })
  assert.match(textOf(result), /takes no options/)
  assert.equal(brief()?.status, 'running')
})

test('crit. 16, check 4: 2 or 3 options are accepted and kept, with one push', async () => {
  await seedConcepts()
  const result = await call({ runId: 'c1', files: ['02-concepts.md'], summary: 's', options: [option('a'), option('b'), option('c')] })
  assert.equal(result.isError, undefined, textOf(result))
  assert.equal(concepts()?.status, 'waiting')
  assert.deepEqual(concepts()?.options?.map((o) => o.id), ['a', 'b', 'c'])
  assert.deepEqual(notify.sent.map((n) => n.title), ['MTC app: concepts ready'])
})

test('crit. 16, check 4: an option with a url where the stage takes none is refused (no link the screen would render)', async () => {
  await seedConcepts()
  const result = await call({ runId: 'c1', files: ['02-concepts.md'], summary: 's', options: [option('a', { url: 'javascript:alert(1)' }), option('b')] })
  assert.match(textOf(result), /option a has a url/)
  assert.equal(concepts()?.status, 'running')
})

/** A plan run, with brief and concepts behind it, and its three documents written. */
async function seedPlan(): Promise<void> {
  await store.change((file) => {
    let m = mockup({ id: 'm1', name: 'MTC app', vaultDir, workDir })
    m = withStep(withStep(m, 'brief', { status: 'done', version: 1 }), 'concepts', { status: 'done', version: 1, chosen: 'a' })
    m = withStep(m, 'plan', { status: 'ready' })
    return { ok: true, value: { file: { ...file, mockups: [value(startRun(m, { kind: 'plan', runId: 'p1', siteId: 'personal' }, NOW))] } } }
  })
  for (const doc of ['03-story-and-pages.md', '04-data.md', '05-visual-direction.md']) await writeFile(join(vaultDir, doc), `---\ntitle: ${doc}\n---\n# ${doc}\n`)
}
const plan = () => store.current().mockups[0]?.stages.plan
const PLAN_FILES = ['03-story-and-pages.md', '04-data.md', '05-visual-direction.md']
const direction = (id: string, url = `https://acme-directions-abc123-team.vercel.app/${id}.html`) => option(id, { url })

test('crit. 16, check 3: plan needs its three documents', async () => {
  await seedPlan()
  const result = await call({ runId: 'p1', files: ['03-story-and-pages.md', '04-data.md'], summary: 's', options: [direction('a'), direction('b')] })
  assert.match(textOf(result), /must include 05-visual-direction\.md/)
})

test('crit. 16, check 4: a direction without its url is refused', async () => {
  await seedPlan()
  const result = await call({ runId: 'p1', files: PLAN_FILES, summary: 's', options: [direction('a'), option('b')] })
  assert.match(textOf(result), /option b has no url/)
  assert.equal(plan()?.status, 'running')
})

test('crit. 16, check 5: a url that is not https://*.vercel.app is refused', async () => {
  await seedPlan()
  for (const url of ['http://acme-directions.vercel.app/a.html', 'https://evil.example.com/a.html', 'https://vercel.app.evil.com/a.html', 'javascript:alert(1)', 'https://vercel.app/a.html']) {
    const result = await call({ runId: 'p1', files: PLAN_FILES, summary: 's', options: [direction('a', url), direction('b')] })
    assert.equal(result.isError, true, url)
    assert.match(textOf(result), /https:\/\/<something>\.vercel\.app/, url)
  }
  const preview = await call({ runId: 'p1', files: PLAN_FILES, summary: 's', options: [direction('a'), direction('b')], previewUrl: 'https://example.com' })
  assert.match(textOf(preview), /previewUrl/)
  assert.equal(plan()?.status, 'running')
})

test('crit. 35: a direction that carries a copy of a private input is refused, and nothing changes', async () => {
  await seedPlan()
  await mkdir(join(workDir, 'inputs', 'private'), { recursive: true })
  await mkdir(join(workDir, 'directions'), { recursive: true })
  await writeFile(join(workDir, 'inputs', 'private', 'rows.csv'), 'real,rows\n1,2\n')
  await writeFile(join(workDir, 'directions', 'rows.csv'), 'real,rows\n1,2\n')
  const result = await call({ runId: 'p1', files: PLAN_FILES, summary: 's', options: [direction('a'), direction('b')] })
  assert.match(textOf(result), /directions\/rows\.csv is a copy of a real-data input/)
  assert.equal(plan()?.status, 'running')
  assert.deepEqual(notify.sent, [])
})

test('crit. 24: a plan with 2–3 directions, each with its vercel.app url, is accepted and the urls kept', async () => {
  await seedPlan()
  const result = await call({ runId: 'p1', files: PLAN_FILES, summary: 's', options: [direction('a'), direction('b'), direction('c')] })
  assert.equal(result.isError, undefined, textOf(result))
  assert.equal(plan()?.status, 'waiting')
  assert.equal(plan()?.options?.[1]?.url, 'https://acme-directions-abc123-team.vercel.app/b.html')
  assert.deepEqual(notify.sent.map((n) => n.title), ['MTC app: plan ready'])
})

async function check(raw: unknown, who: { sessionId?: string; siteId?: string } = {}): Promise<AgentToolResult> {
  return await tool().call({ sessionId: who.sessionId ?? SESSION, siteId: who.siteId ?? 'personal', toolUseId: 't', name: CHECK_REAL_DATA, raw })
}

test('crit. 35, before publishing: check_real_data refuses a copy of a private input, and says to take the deployment down', async () => {
  await seedPlan()
  await mkdir(join(workDir, 'inputs', 'private'), { recursive: true })
  await mkdir(join(workDir, 'directions'), { recursive: true })
  await writeFile(join(workDir, 'inputs', 'private', 'rows.csv'), 'real,rows\n1,2\n')
  await writeFile(join(workDir, 'directions', 'rows.csv'), 'real,rows\n1,2\n')
  const result = await check({ runId: 'p1' })
  assert.equal(result.isError, true)
  assert.match(textOf(result), /directions\/rows\.csv is a copy of a real-data input/)
  assert.match(textOf(result), /vercel remove/)
  assert.match(textOf(result), /Do not turn the protection off/)
  assert.equal(plan()?.status, 'running', 'a check changes nothing')
})

test('check_real_data clears what has no copy, and changes nothing', async () => {
  await seedPlan()
  await mkdir(join(workDir, 'directions'), { recursive: true })
  await writeFile(join(workDir, 'directions', 'index.html'), 'x')
  const result = await check({ runId: 'p1' })
  assert.equal(result.isError, undefined)
  assert.match(textOf(result), /^Clear:/)
  assert.equal(plan()?.status, 'running')
  assert.deepEqual(notify.sent, [])
})

test('check_real_data answers only the run’s own session and site, and only a live run', async () => {
  await seedPlan()
  assert.match(textOf(await check({ runId: 'nope' })), /no live run/)
  assert.match(textOf(await check({ runId: 'p1' }, { siteId: 'other' })), /another project/)
  assert.match(textOf(await check({ runId: 1 })), /runId/)
})

test('crit. 35: a guard refusal at submit also says to take the deployment down', async () => {
  await seedPlan()
  await mkdir(join(workDir, 'inputs', 'private'), { recursive: true })
  await mkdir(join(workDir, 'directions'), { recursive: true })
  await writeFile(join(workDir, 'inputs', 'private', 'rows.csv'), 'real,rows\n1,2\n')
  await writeFile(join(workDir, 'directions', 'rows.csv'), 'real,rows\n1,2\n')
  const result = await call({ runId: 'p1', files: PLAN_FILES, summary: 's', options: [direction('a'), direction('b')] })
  assert.match(textOf(result), /vercel remove/)
})

test('review, check 5: a vercel.app url of ANOTHER project than the stage’s is refused', async () => {
  await seedPlan()
  for (const url of ['https://login-factotum.vercel.app/a.html', 'https://acme-mockup-abc-team.vercel.app/a.html', 'https://acme-directionsx.vercel.app/a.html']) {
    const result = await call({ runId: 'p1', files: PLAN_FILES, summary: 's', options: [direction('a', url), direction('b')] })
    assert.match(textOf(result), /acme-directions/, url)
  }
  const alias = await call({ runId: 'p1', files: PLAN_FILES, summary: 's', options: [direction('a', 'https://acme-directions.vercel.app/a.html'), direction('b')] })
  assert.equal(alias.isError, undefined, textOf(alias))
})

test('review: check_real_data answers only a stage that publishes', async () => {
  await seedConcepts()
  assert.match(textOf(await check({ runId: 'c1' })), /publishes nothing/)
})

/** A build run on the work-dir's project, with the plan chosen behind it and the app's package.json written. */
async function seedBuild(): Promise<void> {
  await store.change((file) => {
    let m = mockup({ id: 'm1', name: 'MTC app', vaultDir, workDir, buildSiteId: 'acme' })
    for (const id of ['brief', 'concepts', 'plan'] as const) m = withStep(m, id, { status: 'done', version: 1 })
    m = withStep(m, 'build', { status: 'ready' })
    return { ok: true, value: { file: { ...file, mockups: [value(startRun(m, { kind: 'build', runId: 'b1', siteId: 'acme' }, NOW))] } } }
  })
  await mkdir(join(workDir, 'mockup-app'), { recursive: true })
  await writeFile(join(workDir, 'mockup-app', 'package.json'), '{"name":"acme"}\n')
}
const built = () => store.current().mockups[0]
const PREVIEW = 'https://acme-mockup-abc123-team.vercel.app'
const APP = ['mockup-app/package.json']
const callBuild = (raw: Record<string, unknown>) => call({ runId: 'b1', files: APP, summary: 's', ...raw }, { siteId: 'acme' })

test('crit. 16, 32: a build without its previewUrl is refused, and nothing changes', async () => {
  await seedBuild()
  const result = await callBuild({})
  assert.equal(result.isError, true)
  assert.match(textOf(result), /needs previewUrl/)
  assert.equal(built()?.stages.build.status, 'running')
})

test('crit. 16, check 3: a build must name the app it built, and the app must be in the work-dir', async () => {
  await seedBuild()
  assert.match(textOf(await callBuild({ files: ['notes.md'], previewUrl: PREVIEW })), /must include mockup-app\/package\.json/)
  await rm(join(workDir, 'mockup-app', 'package.json'))
  assert.match(textOf(await callBuild({ previewUrl: PREVIEW })), /mockup-app\/package\.json does not exist in .*Acme/)
  assert.equal(built()?.stages.build.status, 'running')
})

test('check 5, pinned: a build preview of the directions project, or any other, is refused', async () => {
  await seedBuild()
  for (const url of ['https://acme-directions-abc-team.vercel.app', 'https://evil.vercel.app', 'http://acme-mockup-abc-team.vercel.app']) {
    assert.match(textOf(await callBuild({ previewUrl: url })), /acme-mockup/, url)
  }
  assert.equal(built()?.stages.build.status, 'running')
})

test('crit. 16: a build that also hands a prodUrl is refused — it deploys a preview, never production', async () => {
  await seedBuild()
  const result = await callBuild({ previewUrl: PREVIEW, prodUrl: 'https://acme-mockup.vercel.app' })
  assert.match(textOf(result), /takes no prodUrl/)
  assert.equal(built()?.stages.build.status, 'running')
})

test('crit. 32: a build is accepted with its preview: waiting, the URL kept on the mockup, one push', async () => {
  await seedBuild()
  const result = await callBuild({ previewUrl: PREVIEW })
  assert.equal(result.isError, undefined, textOf(result))
  assert.equal(built()?.stages.build.status, 'waiting')
  assert.equal(built()?.urls.preview, PREVIEW)
  assert.deepEqual(notify.sent, [{ title: 'MTC app: build ready', body: 'Tap to review.', path: '/m/mockups/m1/build', tag: 'mockups-gate-m1-build' }])
})

test('crit. 35: a build whose app carries a copy of a private input is refused, at the check and at submit', async () => {
  await seedBuild()
  await mkdir(join(workDir, 'inputs', 'private'), { recursive: true })
  await writeFile(join(workDir, 'inputs', 'private', 'rows.csv'), 'real,rows\n1,2\n')
  await mkdir(join(workDir, 'mockup-app', 'data'), { recursive: true })
  await writeFile(join(workDir, 'mockup-app', 'data', 'seed.csv'), 'real,rows\n1,2\n')
  assert.match(textOf(await check({ runId: 'b1' }, { siteId: 'acme' })), /mockup-app\/data\/seed\.csv is a copy/)
  assert.match(textOf(await callBuild({ previewUrl: PREVIEW })), /mockup-app\/data\/seed\.csv is a copy/)
  assert.equal(built()?.stages.build.status, 'running')
})

test('crit. 16: a stage that deploys nothing refuses a previewUrl it was handed', async () => {
  await seed()
  await writeFile(join(vaultDir, '01-brief.md'), '# Brief')
  const result = await call({ runId: 'r1', files: ['01-brief.md'], summary: 's', previewUrl: PREVIEW })
  assert.match(textOf(result), /takes no previewUrl/)
  assert.equal(brief()?.status, 'running')
})

/** A deliver run, the build approved behind it, and the presenter guide written. */
async function seedDeliver(): Promise<void> {
  await store.change((file) => {
    let m = mockup({ id: 'm1', name: 'MTC app', vaultDir, workDir, buildSiteId: 'acme', urls: { preview: PREVIEW } })
    for (const id of ['brief', 'concepts', 'plan', 'build'] as const) m = withStep(m, id, { status: 'done', version: 1 })
    m = withStep(m, 'deliver', { status: 'ready' })
    return { ok: true, value: { file: { ...file, mockups: [value(startRun(m, { kind: 'deliver', runId: 'd1', siteId: 'acme' }, NOW))] } } }
  })
  await writeFile(join(vaultDir, '06-presenter-guide.md'), '---\ntitle: Guía\n---\n# Guía del presentador\n')
}
const PROD = 'https://acme-mockup.vercel.app'
const callDeliver = (raw: Record<string, unknown>) => call({ runId: 'd1', files: ['06-presenter-guide.md'], summary: 's', ...raw }, { siteId: 'acme' })

test('crit. 16, 33: a deliver without its prodUrl, or with a preview instead, is refused', async () => {
  await seedDeliver()
  assert.match(textOf(await callDeliver({})), /needs prodUrl/)
  assert.match(textOf(await callDeliver({ previewUrl: PREVIEW, prodUrl: PROD })), /takes no previewUrl/)
  assert.match(textOf(await callDeliver({ prodUrl: 'https://acme-directions.vercel.app' })), /acme-mockup/)
  assert.equal(built()?.stages.deliver.status, 'running')
})

test('crit. 16, check 3: a deliver must write 06-presenter-guide.md in the mockup folder', async () => {
  await seedDeliver()
  await rm(join(vaultDir, '06-presenter-guide.md'))
  assert.match(textOf(await callDeliver({ prodUrl: PROD })), /06-presenter-guide\.md does not exist/)
})

test('crit. 33: a deliver is accepted: done, the mockup delivered with both URLs, and no push — it has no gate', async () => {
  await seedDeliver()
  const result = await callDeliver({ prodUrl: PROD })
  assert.equal(result.isError, undefined, textOf(result))
  assert.equal(textOf(result), 'Submitted. End your turn now.')
  assert.equal(built()?.stages.deliver.status, 'done')
  assert.equal(built()?.status, 'delivered')
  assert.deepEqual(built()?.urls, { preview: PREVIEW, prod: PROD })
  assert.deepEqual(notify.sent, [])
})

// ── The changes track (criterion 36) ──

/** A delivered mockup with change c1 asked and its run x1 (kind `kind`) started. */
async function seedChange(kind: 'change' | 'redeploy' = 'change'): Promise<void> {
  await store.change((file) => {
    let m = mockup({ id: 'm1', name: 'MTC app', vaultDir, workDir, buildSiteId: 'acme', status: 'delivered', urls: { preview: PREVIEW, prod: PROD } })
    for (const id of STAGE_IDS) m = withStep(m, id, { status: 'done', version: 1 })
    m = value(requestChange(m, { changeId: 'c1', text: 'El logo confidencial más grande' }, NOW))
    if (kind === 'redeploy') m = { ...m, changes: m.changes.map((c) => ({ ...c, phase: 'approved' as const, version: 1 })) }
    return { ok: true, value: { file: { ...file, mockups: [value(startRun(m, { kind, changeId: 'c1', runId: 'x1', siteId: 'acme' }, NOW))] } } }
  })
  await mkdir(join(workDir, 'mockup-app'), { recursive: true })
  await writeFile(join(workDir, 'mockup-app', 'package.json'), '{"name":"acme"}\n')
}
const theChange = () => store.current().mockups[0]?.changes[0]
const CHANGE_PREVIEW = 'https://acme-mockup-chg-team.vercel.app'
const callChange = (raw: Record<string, unknown>) => call({ runId: 'x1', files: APP, summary: 's', ...raw }, { siteId: 'acme' })

test('crit. 16, 36: a change without its preview is refused; with it, it waits at its own gate with one push to the changes', async () => {
  await seedChange()
  assert.match(textOf(await callChange({})), /needs previewUrl/)
  const result = await callChange({ previewUrl: CHANGE_PREVIEW })
  assert.equal(result.isError, undefined, textOf(result))
  assert.equal(theChange()?.status, 'waiting')
  assert.equal(theChange()?.previewUrl, CHANGE_PREVIEW)
  assert.deepEqual(notify.sent, [{ title: 'MTC app: change ready', body: 'Tap to review.', path: '/m/mockups/m1/changes', tag: 'mockups-gate-m1-change' }])
  assert.ok(log.lines.includes('info mockup m1: change run x1 submitted, version 1, waiting'))
  assert.ok(!JSON.stringify([notify.sent, log.lines]).includes('confidencial'), 'crit. 42: the request is never logged nor pushed')
})

test('crit. 35: check_real_data answers a change run — it publishes', async () => {
  await seedChange()
  assert.match(textOf(await check({ runId: 'x1' }, { siteId: 'acme' })), /^Clear:/)
})

test('crit. 36: a redeploy must write changes.md and hand in production; accepted, the change is done and the mockup delivered', async () => {
  await seedChange('redeploy')
  assert.match(textOf(await call({ runId: 'x1', files: ['changes.md'], summary: 's', prodUrl: PROD }, { siteId: 'acme' })), /changes\.md does not exist/)
  await writeFile(join(vaultDir, 'changes.md'), '---\ntitle: Cambios\n---\n- 2026-11-13 — logo — https://acme-mockup.vercel.app\n')
  assert.match(textOf(await call({ runId: 'x1', files: ['changes.md'], summary: 's' }, { siteId: 'acme' })), /needs prodUrl/)
  const result = await call({ runId: 'x1', files: ['changes.md'], summary: 's', prodUrl: PROD }, { siteId: 'acme' })
  assert.equal(textOf(result), 'Submitted. End your turn now.')
  assert.equal(theChange()?.status, 'done')
  assert.equal(built()?.status, 'delivered')
  assert.deepEqual(notify.sent, [])
})

test('review (security H1): check_real_data and submit refuse a build whose token file would be uploaded', async () => {
  await seedBuild()
  await writeFile(join(workDir, 'mockup-app', '.env.local'), 'VERCEL_OIDC_TOKEN=x\n')
  assert.match(textOf(await check({ runId: 'b1' }, { siteId: 'acme' })), /^Not clear: mockup-app\/\.env\.local/)
  assert.match(textOf(await callBuild({ previewUrl: PREVIEW })), /mockup-app\/\.env\.local/)
  await writeFile(join(workDir, 'mockup-app', '.vercelignore'), '.env*\n.vercel\n')
  assert.equal((await callBuild({ previewUrl: PREVIEW })).isError, undefined)
})

test('review (code M2): a change cannot hand the production alias in as its preview', async () => {
  await seedChange()
  const result = await callChange({ previewUrl: PROD })
  assert.match(textOf(result), /previewUrl is the production URL/)
  assert.equal(theChange()?.status, 'running')
})
