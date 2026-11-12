import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COMMENT_MAX_CHARS,
  NAME_MAX_CHARS,
  NOTE_MAX_CHARS,
  parseAbandon,
  parseCreate,
  parseDecision,
  parseLink,
  parseNote,
  parseRun,
  parseSite,
  parseSiteMatch,
  parseSubmit,
  uploadName,
} from './shape.ts'

const SESSION = '0192f3a4-5b6c-7d8e-9f01-23456789abcd'

test('create over an existing project needs a name, a client and the slug', () => {
  const shaped = parseCreate({ name: 'MTC app', client: 'MTC', project: { kind: 'existing', slug: 'medical-trust-center' } })
  assert.deepEqual(shaped, { ok: true, value: { name: 'MTC app', client: 'MTC', project: { kind: 'existing', slug: 'medical-trust-center' } } })
})

test('create over a new project needs title, client, summary and difficulty; due is optional', () => {
  const project = { kind: 'new', slug: 'acme-portal', title: 'Acme portal', client: 'Acme', summary: 'A portal.', difficulty: 'medium' }
  const ok = parseCreate({ name: 'Acme', client: 'Acme', project })
  assert.equal(ok.ok, true)
  const withDue = parseCreate({ name: 'Acme', client: 'Acme', project: { ...project, due: '2026-12-01' } })
  assert.equal(withDue.ok, true)
  const badDue = parseCreate({ name: 'Acme', client: 'Acme', project: { ...project, due: '2026-02-30' } })
  assert.deepEqual(badDue.ok ? null : badDue.field, 'project.due')
  const badDifficulty = parseCreate({ name: 'Acme', client: 'Acme', project: { ...project, difficulty: 'easy' } })
  assert.deepEqual(badDifficulty.ok ? null : badDifficulty.field, 'project.difficulty')
})

test('create refuses a slug that could leave the projects folder, a long name and an unknown key', () => {
  const bad = (raw: unknown) => {
    const shaped = parseCreate(raw)
    return shaped.ok ? 'ok' : shaped.field
  }
  assert.equal(bad({ name: 'x', client: 'y', project: { kind: 'existing', slug: '../etc' } }), 'project.slug')
  assert.equal(bad({ name: 'x'.repeat(NAME_MAX_CHARS + 1), client: 'y', project: { kind: 'existing', slug: 'a' } }), 'name')
  assert.equal(bad({ name: 'x', client: 'y', project: { kind: 'existing', slug: 'a' }, extra: 1 }), 'extra')
  assert.equal(bad('nope'), 'body')
  assert.equal(bad({ name: '  ', client: 'y', project: { kind: 'existing', slug: 'a' } }), 'name')
})

test('a run names its kind; a decision needs a stage and an action of the closed list', () => {
  assert.deepEqual(parseRun({ kind: 'brief' }), { ok: true, value: { kind: 'brief' } })
  assert.equal(parseRun({ kind: 'nope' }).ok, false)
  assert.deepEqual(parseDecision({ step: 'brief', action: 'approve' }), { ok: true, value: { step: 'brief', action: 'approve' } })
  assert.deepEqual(parseDecision({ step: 'brief', action: 'redo', comment: 'more on QR' }), {
    ok: true,
    value: { step: 'brief', action: 'redo', comment: 'more on QR' },
  })
  const long = parseDecision({ step: 'brief', action: 'redo', comment: 'x'.repeat(COMMENT_MAX_CHARS + 1) })
  assert.equal(long.ok ? null : long.field, 'comment')
  assert.equal(parseDecision({ step: 'brief', action: 'shrug' }).ok, false)
})

test('a note carries text up to its limit', () => {
  assert.deepEqual(parseNote({ text: 'met them' }), { ok: true, value: { text: 'met them' } })
  assert.equal(parseNote({ text: '' }).ok, false)
  assert.equal(parseNote({ text: 'x'.repeat(NOTE_MAX_CHARS + 1) }).ok, false)
})

test('site-match carries the sessions projects; site is a siteId or a refusal', () => {
  assert.deepEqual(parseSiteMatch({ projects: [{ id: 'mtc', path: '/a/b' }] }), { ok: true, value: { projects: [{ id: 'mtc', path: '/a/b' }] } })
  assert.equal(parseSiteMatch({ projects: [{ id: 'Bad Id', path: '/a' }] }).ok, false)
  assert.deepEqual(parseSite({ siteId: 'mtc' }), { ok: true, value: { siteId: 'mtc' } })
  assert.deepEqual(parseSite({ refused: 'it is inside a project' }), { ok: true, value: { refused: 'it is inside a project' } })
  assert.equal(parseSite({}).ok, false)
})

test('linking takes a uuidv7; abandon takes an optional reason', () => {
  assert.deepEqual(parseLink({ sessionId: SESSION }), { ok: true, value: { sessionId: SESSION } })
  assert.equal(parseLink({ sessionId: 'abc' }).ok, false)
  assert.deepEqual(parseAbandon({}), { ok: true, value: {} })
  assert.deepEqual(parseAbandon(undefined), { ok: true, value: {} })
  assert.deepEqual(parseAbandon({ reason: 'busy' }), { ok: true, value: { reason: 'busy' } })
})

test('submit_stage input: runId, files, summary; options and urls optional', () => {
  const ok = parseSubmit({ runId: SESSION, files: ['01-brief.md'], summary: 'done' })
  assert.deepEqual(ok, { ok: true, value: { runId: SESSION, files: ['01-brief.md'], summary: 'done' } })
  const options = parseSubmit({ runId: SESSION, files: ['a.md'], summary: 's', options: [{ id: 'a', title: 'A', blurb: 'b', url: 'https://x.vercel.app' }] })
  assert.equal(options.ok, true)
  assert.equal(parseSubmit({ runId: SESSION, files: [], summary: 's' }).ok, false)
  assert.equal(parseSubmit({ runId: SESSION, files: ['a'], summary: 'x'.repeat(601) }).ok, false)
})

test('an upload name is a plain file name: no folder, no leading dot, nothing a shell would read', () => {
  assert.deepEqual(uploadName('MTC APP.pdf'), { ok: true, value: 'MTC APP.pdf' })
  assert.deepEqual(uploadName('notas-junta.docx'), { ok: true, value: 'notas-junta.docx' })
  assert.equal(uploadName(undefined).ok, false)
  assert.equal(uploadName('../x.pdf').ok, false)
  assert.equal(uploadName('a/b.pdf').ok, false)
  assert.equal(uploadName('.env').ok, false)
  assert.equal(uploadName('x'.repeat(201)).ok, false)
  assert.equal(uploadName('a\nb.pdf').ok, false)
})
