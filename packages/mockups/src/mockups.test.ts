import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { createMockups, titleFor } from './mockups.ts'
import { STARTING_ABANDON_MS, SWEEP_EVERY_MS } from './shape.ts'
import { MOCKUPS_FILE } from './store/store.ts'
import { SUBMIT_STAGE } from './submit.ts'
import { captureLog, captureNotify, eventually, manualTimers, NOW, SESSION, type CapturedLog, type ManualTimers } from './test-support.ts'
import type { Mockup, Mockups, Result } from './types.ts'

let root: string
let projectsDir: string
let workRoot: string
let stateDir: string
let clock: Date
let log: CapturedLog
let timers: ManualTimers
let mockups: Mockups

const config = () => ({ docsSiteId: 'personal', vault: { projectsDir }, workRoot, model: 'opus[1m]' })

async function make(raw: unknown = config()): Promise<Mockups> {
  const created = await createMockups({ config: raw, stateDir, log, now: () => clock, timers: timers.timers, notify: captureNotify(), home: root, caseInsensitive: true })
  if (!created.ok) throw new Error(created.reason)
  return created.mockups
}

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.reason}`)
  return result.value
}
const code = (result: Result<unknown>): string => (result.ok ? 'ok' : result.error.code)

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mockups-facade-')))
  projectsDir = join(root, 'vault', '01-projects')
  workRoot = join(root, 'Work')
  stateDir = join(root, 'state')
  clock = NOW
  log = captureLog()
  timers = manualTimers()
  await mkdir(join(projectsDir, 'acme'), { recursive: true })
  await mkdir(join(workRoot, 'Acme'), { recursive: true })
  await writeFile(join(projectsDir, 'acme', 'acme.md'), '---\ntitle: Acme\nwork-dir: ~/Work/Acme\n---\n# Acme\n')
  mockups = await make()
})
afterEach(async () => {
  await mockups.stop()
  await rm(root, { recursive: true, force: true })
})

const EXISTING = { name: 'Acme app', client: 'Acme', project: { kind: 'existing', slug: 'acme' } }

async function created(): Promise<Mockup> {
  return value(await mockups.create(EXISTING)).mockup
}

/** A brief that ran and was submitted: waiting at its gate. */
async function waitingBrief(): Promise<Mockup> {
  const m = await created()
  const ticket = value(await mockups.startRun(m.id, { kind: 'brief' }))
  value(await mockups.linkRun(ticket.runId, { sessionId: SESSION }))
  await writeFile(join(m.vaultDir, '01-brief.md'), '---\ntitle: Brief\n---\n# Brief v1\n')
  const result = await mockups.agent.call({ sessionId: SESSION, siteId: 'personal', toolUseId: 't', name: SUBMIT_STAGE, raw: { runId: ticket.runId, files: ['01-brief.md'], summary: 's' } })
  assert.equal(result.isError, undefined, result.content[0]?.text)
  const after = mockups.get(m.id)
  assert.ok(after !== undefined)
  return after
}

test('a bad config is a reason, never a throw (crit. 2)', async () => {
  const bad = await createMockups({ config: { docsSiteId: '' }, stateDir, log, now: () => clock, timers: timers.timers, notify: captureNotify() })
  assert.equal(bad.ok, false)
})

test('crit. 3: a damaged mockups.json switches the module off with its reason', async () => {
  await mockups.stop()
  await writeFile(join(stateDir, MOCKUPS_FILE), '{"version":2}')
  const opened = await createMockups({ config: config(), stateDir, log, now: () => clock, timers: timers.timers, notify: captureNotify() })
  assert.match(opened.ok ? '' : opened.reason, /damaged/)
  mockups = await make({ ...config() }).catch(() => mockups)
})

test('setup carries what the screen needs for the cross-writes warning (crit. 2b)', () => {
  assert.deepEqual(mockups.setup(), { docsSiteId: 'personal', projectsDir, workRoot, crossWritesAllowed: false })
})

test('crit. 6: projects are listed with their work-dir expanded', async () => {
  assert.deepEqual(value(await mockups.projects()), [{ slug: 'acme', title: 'Acme', workDir: join(workRoot, 'Acme') }])
})

test('crit. 6: a mockup over an existing project: its folder in the vault, brief ready, no build project yet', async () => {
  const m = await created()
  assert.equal(m.vaultDir, join(projectsDir, 'acme', 'mockup'))
  assert.equal(m.workDir, join(workRoot, 'Acme'))
  assert.equal(m.project, 'acme')
  assert.equal(m.buildSiteId, null)
  assert.equal(m.stages.brief.status, 'ready')
  assert.deepEqual(mockups.list().map((one) => one.id), [m.id])
})

test('an unknown project is not-found; one without a work-dir is invalid', async () => {
  assert.equal(code(await mockups.create({ ...EXISTING, project: { kind: 'existing', slug: 'nope' } })), 'not-found')
  await mkdir(join(projectsDir, 'bare'))
  await writeFile(join(projectsDir, 'bare', 'bare.md'), '---\ntitle: Bare\n---\n')
  assert.equal(code(await mockups.create({ ...EXISTING, project: { kind: 'existing', slug: 'bare' } })), 'invalid')
})

test('crit. 8: a second mockup on a work-dir with an open one is a conflict that names it', async () => {
  await created()
  const second = await mockups.create({ ...EXISTING, name: 'Other' })
  assert.equal(code(second), 'conflict')
  assert.match(second.ok ? '' : second.error.reason, /Acme app/)
})

test('crit. 6: a mockup over a new project creates the hub and the work-dir; without mapFile, mapWarning', async () => {
  const result = value(
    await mockups.create({
      name: 'Beta',
      client: 'Beta Co',
      project: { kind: 'new', slug: 'beta-portal', title: 'Beta Portal', client: 'Beta Co', summary: 'A portal.', difficulty: 'low' },
    }),
  )
  assert.equal(result.mockup.workDir, join(workRoot, 'BetaPortal'))
  assert.equal(result.mockup.vaultDir, join(projectsDir, 'beta-portal', 'mockup'))
  assert.match(result.mapWarning ?? '', /map not updated/)
  assert.match(await readFile(join(projectsDir, 'beta-portal', 'beta-portal.md'), 'utf8'), /^---\ntitle: Beta Portal\n/)
})

test('crit. 7: site-match finds the project that IS the work-dir or CONTAINS it, without case on macOS', async () => {
  const m = await created()
  const same = value(await mockups.siteMatch(m.id, { projects: [{ id: 'acme', path: join(workRoot, 'acme').toUpperCase() }] }))
  assert.deepEqual(same, { siteId: 'acme' })
  const container = value(
    await mockups.siteMatch(m.id, {
      projects: [
        { id: 'all', path: root },
        { id: 'work', path: workRoot },
        { id: 'other', path: join(root, 'elsewhere') },
      ],
    }),
  )
  assert.deepEqual(container, { siteId: 'work' })
  assert.deepEqual(value(await mockups.siteMatch(m.id, { projects: [{ id: 'other', path: join(root, 'elsewhere') }] })), { siteId: null })
})

test('crit. 7: setSite records the project, or the refusal and its reason', async () => {
  const m = await created()
  const refused = value(await mockups.setSite(m.id, { refused: 'it is inside a project' }))
  assert.equal(refused.buildRefused, 'it is inside a project')
  const set = value(await mockups.setSite(m.id, { siteId: 'acme' }))
  assert.equal(set.buildSiteId, 'acme')
  assert.equal(set.buildRefused, undefined)
})

test('crit. 9–11: an upload, a private sample and a note land in the work-dir and in the list', async () => {
  const m = await created()
  await mkdir(join(stateDir, '.incoming'), { recursive: true })
  const part = join(stateDir, '.incoming', 'x.part')
  await writeFile(part, 'pdf')
  value(await mockups.addInput(m.id, { path: part, bytes: 3 }, { name: 'RFP.pdf' }))
  await writeFile(part, 'rows')
  value(await mockups.addInput(m.id, { path: part, bytes: 4 }, { name: 'rows.csv', private: '1' }))
  const after = value(await mockups.addNote(m.id, { text: 'secret meeting note' }))
  assert.deepEqual(
    after.inputs.map((input) => [input.name, input.kind, input.private]),
    [
      ['RFP.pdf', 'pdf', false],
      ['rows.csv', 'csv', true],
      ['notes-1.md', 'note', false],
    ],
  )
  assert.deepEqual((await readdir(join(m.workDir, 'inputs'))).sort(), ['RFP.pdf', 'notes-1.md', 'private'])
  assert.ok(!log.lines.join('\n').includes('secret meeting note'), 'crit. 42: no content in the log')
})

test('an upload without ?name= is invalid', async () => {
  const m = await created()
  assert.equal(code(await mockups.addInput(m.id, { path: join(root, 'x'), bytes: 1 }, {})), 'invalid')
})

test('crit. 12: with a stage running, adding inputs is a conflict with the reason', async () => {
  const m = await created()
  value(await mockups.startRun(m.id, { kind: 'brief' }))
  const note = await mockups.addNote(m.id, { text: 'late' })
  assert.equal(code(note), 'conflict')
  assert.match(note.ok ? '' : note.error.reason, /running/)
})

test('crit. 14: start makes a run on the docs site, with the prompt and the title', async () => {
  const m = await created()
  const ticket = value(await mockups.startRun(m.id, { kind: 'brief' }))
  assert.equal(ticket.siteId, 'personal')
  assert.equal(ticket.title, 'Mockup · brief · Acme app')
  assert.equal(ticket.model, 'opus[1m]')
  assert.match(ticket.text, new RegExp(ticket.runId))
  assert.equal(mockups.get(m.id)?.stages.brief.run?.id, ticket.runId)
})

test('crit. 19: a second start is a conflict; a stage of the next cut is not-yet', async () => {
  const m = await created()
  value(await mockups.startRun(m.id, { kind: 'brief' }))
  assert.equal(code(await mockups.startRun(m.id, { kind: 'brief' })), 'conflict')
  assert.equal(code(await mockups.startRun(m.id, { kind: 'deliver' })), 'not-yet')
  assert.equal(code(await mockups.startRun('nope', { kind: 'brief' })), 'not-found')
})

test('crit. 14: the title is cut to 80 characters without losing the stage', () => {
  const title = titleFor('brief', 'x'.repeat(200))
  assert.equal(title.length, 80)
  assert.ok(title.startsWith('Mockup · brief · xxx'))
  assert.ok(title.endsWith('…'))
})

test('crit. 15: abandon puts the stage back; link and stall go through the run id', async () => {
  const m = await created()
  const ticket = value(await mockups.startRun(m.id, { kind: 'brief' }))
  assert.equal(value(await mockups.stallRun(ticket.runId)).stages.brief.status, 'stalled')
  assert.equal(value(await mockups.abandonRun(ticket.runId, { reason: 'busy' })).stages.brief.status, 'ready')
  assert.equal(code(await mockups.abandonRun(ticket.runId, {})), 'not-found')
  assert.equal(code(await mockups.linkRun('nope', { sessionId: SESSION })), 'not-found')
})

test('crit. 25: the documents of a stage, read now; an unknown stage is invalid', async () => {
  const m = await waitingBrief()
  const docs = value(await mockups.docs(m.id, 'brief'))
  assert.equal(docs.files[0]?.name, '01-brief.md')
  assert.deepEqual(docs.files[0]?.frontmatter, { title: 'Brief' })
  assert.equal(code(await mockups.docs(m.id, 'nope')), 'invalid')
})

test('crit. 27: approving the brief leaves concepts ready; the screen launches it', async () => {
  const m = await waitingBrief()
  const decided = value(await mockups.decide(m.id, { step: 'brief', action: 'approve' }))
  assert.equal(decided.mockup.stages.brief.status, 'done')
  assert.equal(decided.mockup.stages.concepts.status, 'ready')
  assert.equal(decided.run, undefined)
})

test('crit. 29: a redo copies the document to _versions/ and starts the run with the comment and the path', async () => {
  const m = await waitingBrief()
  const decided = value(await mockups.decide(m.id, { step: 'brief', action: 'redo', comment: 'more on the QR login' }))
  assert.ok(decided.run !== undefined)
  assert.match(decided.run.text, /_versions\/01-brief-v1\.md/)
  assert.match(decided.run.text, /> more on the QR login/)
  assert.equal(await readFile(join(m.vaultDir, '_versions', '01-brief-v1.md'), 'utf8'), '---\ntitle: Brief\n---\n# Brief v1\n')
  assert.equal(await readFile(join(m.vaultDir, '01-brief.md'), 'utf8'), '---\ntitle: Brief\n---\n# Brief v1\n')
  assert.equal(decided.mockup.stages.brief.status, 'running')
  assert.ok(!log.lines.join('\n').includes('QR login'), 'crit. 42: the comment is not logged')
})

test('crit. 15, 29: a redo whose launch is abandoned goes back to waiting with the comment', async () => {
  const m = await waitingBrief()
  const decided = value(await mockups.decide(m.id, { step: 'brief', action: 'redo', comment: 'again' }))
  assert.ok(decided.run !== undefined)
  const back = value(await mockups.abandonRun(decided.run.runId, { reason: 'busy' }))
  assert.equal(back.stages.brief.status, 'waiting')
  assert.equal(back.stages.brief.pendingComment, 'again')
})

test('a redo on a stage that is not waiting copies nothing', async () => {
  const m = await created()
  assert.equal(code(await mockups.decide(m.id, { step: 'brief', action: 'redo', comment: 'x' })), 'conflict')
  await assert.rejects(readdir(join(m.vaultDir, '_versions')))
})

test('archive takes it out of the gallery', async () => {
  const m = await created()
  value(await mockups.archive(m.id))
  assert.deepEqual(mockups.list(), [])
  assert.equal(mockups.get(m.id)?.status, 'archived')
})

test('crit. 18: the sweep is armed every 60 s and stalls a run without a session after 10 min', async () => {
  const m = await created()
  value(await mockups.startRun(m.id, { kind: 'brief' }))
  assert.deepEqual(timers.pending(), [SWEEP_EVERY_MS])
  clock = new Date(NOW.getTime() + STARTING_ABANDON_MS)
  timers.fire(SWEEP_EVERY_MS)
  await eventually(() => mockups.get(m.id)?.stages.brief.status === 'stalled', 'the sweep stalled the run')
})

test('stop disarms the sweep', async () => {
  await mockups.stop()
  assert.deepEqual(timers.pending(), [])
  mockups = await make()
})

test('review: two creates at once on the same work-dir — one of them is a conflict', async () => {
  const [a, b] = await Promise.all([mockups.create(EXISTING), mockups.create({ ...EXISTING, name: 'Twin' })])
  assert.deepEqual([code(a), code(b)].sort(), ['conflict', 'ok'])
  assert.equal(mockups.list().length, 1)
})

test('review: projects() is a result, and an unreadable projects folder is a module-error, not an empty list', async () => {
  await mockups.stop()
  mockups = await make({ ...config(), vault: { projectsDir: join(root, 'missing') } })
  assert.equal(code(await mockups.projects()), 'module-error')
  assert.equal(code(await mockups.create(EXISTING)), 'module-error')
})

/** Concepts that ran and were submitted with options a, b, c: waiting at their gate. */
async function waitingConcepts(): Promise<Mockup> {
  const m = await waitingBrief()
  value(await mockups.decide(m.id, { step: 'brief', action: 'approve' }))
  const ticket = value(await mockups.startRun(m.id, { kind: 'concepts' }))
  value(await mockups.linkRun(ticket.runId, { sessionId: SESSION }))
  await writeFile(join(m.vaultDir, '02-concepts.md'), '---\ntitle: Conceptos\n---\n# Conceptos\n')
  const options = ['a', 'b', 'c'].map((id) => ({ id, title: `Concept ${id}`, blurb: `Blurb ${id}` }))
  const raw = { runId: ticket.runId, files: ['02-concepts.md'], summary: 's', options }
  const result = await mockups.agent.call({ sessionId: SESSION, siteId: 'personal', toolUseId: 't', name: SUBMIT_STAGE, raw })
  assert.equal(result.isError, undefined, result.content[0]?.text)
  const after = mockups.get(m.id)
  assert.ok(after !== undefined)
  return after
}

test('crit. 14: concepts start on the docs site, with a prompt that reads the brief', async () => {
  const m = await waitingBrief()
  value(await mockups.decide(m.id, { step: 'brief', action: 'approve' }))
  const ticket = value(await mockups.startRun(m.id, { kind: 'concepts' }))
  assert.equal(ticket.siteId, 'personal')
  assert.equal(ticket.title, 'Mockup · concepts · Acme app')
  assert.ok(ticket.text.includes(join(m.vaultDir, '01-brief.md')))
})

test('crit. 28: choosing writes chosen: <id> into 02-concepts.md and the state, and plan goes ready', async () => {
  const m = await waitingConcepts()
  const decided = value(await mockups.decide(m.id, { step: 'concepts', action: 'choose', optionId: 'b' }))
  assert.equal(decided.mockup.stages.concepts.chosen, 'b')
  assert.equal(decided.mockup.stages.concepts.status, 'done')
  assert.equal(decided.mockup.stages.plan.status, 'ready')
  assert.equal(await readFile(join(m.vaultDir, '02-concepts.md'), 'utf8'), '---\ntitle: Conceptos\nchosen: b\n---\n# Conceptos\n')
  assert.ok(log.lines.includes(`info mockup ${m.id}: concepts chosen, version 1`))
})

test('crit. 28: a choice without an option, or of one not offered, is invalid and the document is untouched', async () => {
  const m = await waitingConcepts()
  assert.equal(code(await mockups.decide(m.id, { step: 'concepts', action: 'choose' })), 'invalid')
  assert.equal(code(await mockups.decide(m.id, { step: 'concepts', action: 'choose', optionId: 'z' })), 'invalid')
  assert.equal(code(await mockups.decide(m.id, { step: 'concepts', action: 'approve' })), 'invalid')
  assert.equal(await readFile(join(m.vaultDir, '02-concepts.md'), 'utf8'), '---\ntitle: Conceptos\n---\n# Conceptos\n')
  assert.equal(mockups.get(m.id)?.stages.concepts.status, 'waiting')
})

test('crit. 28: a document that cannot take the choice is a module-error, and the state does not move', async () => {
  const m = await waitingConcepts()
  await rm(join(m.vaultDir, '02-concepts.md'))
  const result = await mockups.decide(m.id, { step: 'concepts', action: 'choose', optionId: 'b' })
  assert.equal(code(result), 'module-error')
  assert.equal(mockups.get(m.id)?.stages.concepts.status, 'waiting')
})

test('crit. 29: a redo of concepts copies 02-concepts.md to _versions/ and starts the run', async () => {
  const m = await waitingConcepts()
  const decided = value(await mockups.decide(m.id, { step: 'concepts', action: 'redo', comment: 'otro ángulo' }))
  assert.ok(decided.run !== undefined)
  assert.match(decided.run.text, /_versions\/02-concepts-v1\.md/)
  assert.equal(decided.mockup.stages.concepts.status, 'running')
})

test('crit. 28: plan starts with the chosen concept in its prompt, and the directions project named after the vault project', async () => {
  const m = await waitingConcepts()
  value(await mockups.decide(m.id, { step: 'concepts', action: 'choose', optionId: 'b' }))
  const ticket = value(await mockups.startRun(m.id, { kind: 'plan' }))
  assert.equal(ticket.siteId, 'personal')
  assert.match(ticket.text, /chose «Concept b» \(b\): Blurb b/)
  assert.ok(ticket.text.includes('acme-directions'))
})

test('crit. 29: a plan redo copies the documents AND directions/ before it starts, and names both', async () => {
  const m = await waitingConcepts()
  value(await mockups.decide(m.id, { step: 'concepts', action: 'choose', optionId: 'a' }))
  const ticket = value(await mockups.startRun(m.id, { kind: 'plan' }))
  value(await mockups.linkRun(ticket.runId, { sessionId: SESSION }))
  for (const doc of ['03-story-and-pages.md', '04-data.md', '05-visual-direction.md']) await writeFile(join(m.vaultDir, doc), `# ${doc}\n`)
  await mkdir(join(m.workDir, 'directions'), { recursive: true })
  await writeFile(join(m.workDir, 'directions', 'index.html'), 'v1')
  const options = ['a', 'b'].map((id) => ({ id, title: id, blurb: id, url: `https://acme-directions-x.vercel.app/${id}.html` }))
  const raw = { runId: ticket.runId, files: ['03-story-and-pages.md', '04-data.md', '05-visual-direction.md'], summary: 's', options }
  const submitted = await mockups.agent.call({ sessionId: SESSION, siteId: 'personal', toolUseId: 't', name: SUBMIT_STAGE, raw })
  assert.equal(submitted.isError, undefined, submitted.content[0]?.text)
  const decided = value(await mockups.decide(m.id, { step: 'plan', action: 'redo', comment: 'menos azul' }))
  assert.ok(decided.run !== undefined)
  assert.equal(await readFile(join(m.workDir, 'directions', '_versions', 'v1', 'index.html'), 'utf8'), 'v1')
  assert.ok(decided.run.text.includes(join(m.workDir, 'directions', '_versions', 'v1')))
  assert.ok(decided.run.text.includes(join(m.vaultDir, '_versions', '05-visual-direction-v1.md')))
})

test('review: two choices at once — one wins, and the document says what the state says', async () => {
  const m = await waitingConcepts()
  const [x, y] = await Promise.all([
    mockups.decide(m.id, { step: 'concepts', action: 'choose', optionId: 'a' }),
    mockups.decide(m.id, { step: 'concepts', action: 'choose', optionId: 'b' }),
  ])
  assert.deepEqual([code(x), code(y)].sort(), ['conflict', 'ok'])
  const chosen = mockups.get(m.id)?.stages.concepts.chosen
  assert.match(await readFile(join(m.vaultDir, '02-concepts.md'), 'utf8'), new RegExp(`\\nchosen: ${chosen}\\n`))
})

/** The plan submitted and direction a chosen: build ready, on a mockup whose work-dir is the sessions project acme. */
async function chosenPlan(): Promise<Mockup> {
  const m = await waitingConcepts()
  value(await mockups.decide(m.id, { step: 'concepts', action: 'choose', optionId: 'a' }))
  const ticket = value(await mockups.startRun(m.id, { kind: 'plan' }))
  value(await mockups.linkRun(ticket.runId, { sessionId: SESSION }))
  const files = ['03-story-and-pages.md', '04-data.md', '05-visual-direction.md']
  for (const doc of files) await writeFile(join(m.vaultDir, doc), `---\ntitle: ${doc}\n---\n# ${doc}\n`)
  const options = ['a', 'b'].map((id) => ({ id, title: `Direction ${id}`, blurb: id, url: `https://acme-directions-x.vercel.app/${id}.html` }))
  const submitted = await mockups.agent.call({ sessionId: SESSION, siteId: 'personal', toolUseId: 't', name: SUBMIT_STAGE, raw: { runId: ticket.runId, files, summary: 's', options } })
  assert.equal(submitted.isError, undefined, submitted.content[0]?.text)
  value(await mockups.decide(m.id, { step: 'plan', action: 'choose', optionId: 'a' }))
  return value(await mockups.setSite(m.id, { siteId: 'acme' }))
}

const BUILD_PREVIEW = 'https://acme-mockup-abc-team.vercel.app'

/** A build that ran and handed its preview: waiting at its gate. */
async function waitingBuild(): Promise<Mockup> {
  const m = await chosenPlan()
  const ticket = value(await mockups.startRun(m.id, { kind: 'build' }))
  value(await mockups.linkRun(ticket.runId, { sessionId: SESSION }))
  await mkdir(join(m.workDir, 'mockup-app'), { recursive: true })
  await writeFile(join(m.workDir, 'mockup-app', 'package.json'), '{"name":"acme"}\n')
  const raw = { runId: ticket.runId, files: ['mockup-app/package.json'], summary: 's', previewUrl: BUILD_PREVIEW }
  const result = await mockups.agent.call({ sessionId: SESSION, siteId: 'acme', toolUseId: 't', name: SUBMIT_STAGE, raw })
  assert.equal(result.isError, undefined, result.content[0]?.text)
  return mockups.get(m.id) ?? assert.fail('gone')
}

test('crit. 14: build needs the work-dir as a sessions project before it starts', async () => {
  const m = await chosenPlan()
  value(await mockups.setSite(m.id, { refused: 'it is inside a project' }))
  const refused = await mockups.startRun(m.id, { kind: 'build' })
  assert.equal(code(refused), 'conflict')
  assert.match(refused.ok ? '' : refused.error.reason, /no build project: it is inside a project/)
})

test('crit. 14, 28: build starts on the work-dir project, with the chosen direction and the <slug>-mockup project in its prompt', async () => {
  const m = await chosenPlan()
  const ticket = value(await mockups.startRun(m.id, { kind: 'build' }))
  assert.equal(ticket.siteId, 'acme')
  assert.equal(ticket.title, 'Mockup · build · Acme app')
  assert.match(ticket.text, /chose «Direction a» \(a\)/)
  assert.ok(ticket.text.includes('acme-mockup'))
  assert.ok(ticket.text.includes(join(m.workDir, 'mockup-app')))
})

test('crit. 32: a build handed in waits at its gate with its preview on the mockup', async () => {
  const m = await waitingBuild()
  assert.equal(m.stages.build.status, 'waiting')
  assert.equal(m.urls.preview, BUILD_PREVIEW)
})

test('crit. 29: a build redo starts with the comment and the preview it replaces, and copies nothing into the vault', async () => {
  const m = await waitingBuild()
  const decided = value(await mockups.decide(m.id, { step: 'build', action: 'redo', comment: 'el paso 3 más lento' }))
  assert.ok(decided.run !== undefined)
  assert.equal(decided.run.siteId, 'acme')
  assert.match(decided.run.text, /> el paso 3 más lento/)
  assert.ok(decided.run.text.includes(BUILD_PREVIEW))
  assert.deepEqual(await readdir(join(m.vaultDir, '_versions')).catch(() => []), [], 'no stage before it was redone, and build keeps no document')
  assert.equal(decided.mockup.stages.build.status, 'running')
})
