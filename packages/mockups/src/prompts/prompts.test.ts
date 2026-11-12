import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mockup, withStep } from '../test-support.ts'
import { briefPrompt } from './brief.ts'
import { choiceSection, type PromptContext } from './common.ts'
import { conceptsPrompt } from './concepts.ts'
import { contextFor, promptFor } from './index.ts'

const CTX: PromptContext = {
  runId: '0192f3a4-5b6c-7d8e-9f01-23456789abcd',
  stage: 'brief',
  name: 'MTC app',
  client: 'Medical Trust Center',
  vaultDir: '/Users/me/Obsidian/01-projects/medical-trust-center/mockup',
  workDir: '/Users/me/BWR/Projects/MedicalTrustCenter',
  inputs: [
    { name: 'MTC APP.pdf', kind: 'pdf', bytes: 1000, private: false, at: '2026-11-12T00:00:00.000Z' },
    { name: 'notas-junta.docx', kind: 'docx', bytes: 10, private: false, at: '2026-11-12T00:00:00.000Z' },
    { name: 'notes-1.md', kind: 'note', bytes: 10, private: false, at: '2026-11-12T00:00:00.000Z' },
    { name: 'pacientes.xlsx', kind: 'xlsx', bytes: 10, private: true, at: '2026-11-12T00:00:00.000Z' },
  ],
}

test('the brief prompt, first run', (t) => {
  t.assert.snapshot(briefPrompt(CTX))
})

test('the brief prompt, a redo: the previous version and the owner’s comment, literal', (t) => {
  const prompt = briefPrompt({ ...CTX, redo: { comment: 'Más detalle del ingreso por QR.\nY quita la parte de pagos.', previous: ['_versions/01-brief-v1.md'] } })
  assert.match(prompt, /_versions\/01-brief-v1\.md/)
  assert.match(prompt, /> Más detalle del ingreso por QR\.\n> Y quita la parte de pagos\./)
  t.assert.snapshot(prompt)
})

test('every prompt carries the runId, the absolute folders, the language rule and submit_stage', () => {
  const prompt = briefPrompt(CTX)
  for (const needle of [CTX.runId, CTX.vaultDir, CTX.workDir, `${CTX.workDir}/inputs`, 'submit_stage', 'language of the inputs', '01-brief.md']) {
    assert.ok(prompt.includes(needle), needle)
  }
})

test('outside plan, the private inputs are named as off limits and never listed to be read', () => {
  const prompt = briefPrompt(CTX)
  assert.match(prompt, /Do NOT open anything in .*inputs\/private/)
  assert.ok(!prompt.includes('pacientes.xlsx'))
})

test('Word through textutil, PDF through the read tool, and a PDF without text read as an image (A2)', () => {
  const prompt = briefPrompt(CTX)
  assert.match(prompt, /textutil -convert txt -stdout/)
  assert.match(prompt, /no text layer.*as an image/s)
})

test('promptFor answers brief and concepts, and null for a stage of a later block', () => {
  assert.equal(promptFor(CTX), briefPrompt(CTX))
  assert.equal(promptFor({ ...CTX, stage: 'concepts' }), conceptsPrompt({ ...CTX, stage: 'concepts' }))
  assert.equal(promptFor({ ...CTX, stage: 'plan' }), null)
})

test('no inputs yet: the prompt says so instead of an empty list', () => {
  assert.match(briefPrompt({ ...CTX, inputs: [] }), /There are no inputs listed yet/)
})

test('P1.4: exactly ONE step is marked as the one that sells it', () => {
  const prompt = briefPrompt(CTX)
  assert.match(prompt, /Mark exactly ONE step/)
  assert.doesNotMatch(prompt, /favour the steps that would sell it/)
})

test('P1.4: the frame fits an internal project too, not only a client of BWR sold in a meeting', () => {
  const prompt = briefPrompt({ ...CTX, client: 'Factotum (internal)' })
  assert.doesNotMatch(prompt, /a mockup for a client of BWR/)
  assert.match(prompt, /owner's own project/)
  assert.match(prompt, /prototype to decide the design, not a sales demo/)
})

const CONCEPTS: PromptContext = { ...CTX, stage: 'concepts' }

test('the concepts prompt, first run', (t) => {
  t.assert.snapshot(conceptsPrompt(CONCEPTS))
})

test('the concepts prompt reads the approved brief, writes 02-concepts.md and hands 2 or 3 options', () => {
  const prompt = conceptsPrompt(CONCEPTS)
  for (const needle of [`${CTX.vaultDir}/01-brief.md`, `${CTX.vaultDir}/02-concepts.md`, '2 or 3', 'options', CTX.runId, 'submit_stage']) {
    assert.ok(prompt.includes(needle), needle)
  }
  assert.match(prompt, /for whom/i)
  assert.doesNotMatch(prompt, /in the meeting/, 'P1.4: an internal project has no meeting')
  assert.match(prompt, /the step that would sell it/i)
  assert.match(prompt, /risk/i)
  assert.match(prompt, /Do NOT open anything in .*inputs\/private/)
})

test('the concepts prompt, a redo: the previous version and the comment, literal', (t) => {
  const prompt = conceptsPrompt({ ...CONCEPTS, redo: { comment: 'Un tercer ángulo, más sobrio.', previous: ['_versions/02-concepts-v1.md'] } })
  assert.match(prompt, /_versions\/02-concepts-v1\.md/)
  assert.match(prompt, /> Un tercer ángulo, más sobrio\./)
  t.assert.snapshot(prompt)
})

test('crit. 28: the next stage receives the choice — its id, title and blurb, and the document it is in', () => {
  const section = choiceSection({
    ...CTX,
    stage: 'plan',
    chosen: { stage: 'concepts', file: '02-concepts.md', option: { id: 'b', title: 'Check-in in one tap', blurb: 'The QR is the product.' } },
  })
  assert.match(section, /chose «Check-in in one tap» \(b\)/)
  assert.match(section, /The QR is the product\./)
  assert.ok(section.includes(`${CTX.vaultDir}/02-concepts.md`))
  assert.equal(choiceSection(CTX), '')
})

test('crit. 28: contextFor hands a stage the choice of the stage before it', () => {
  const options = [
    { id: 'a', title: 'A', blurb: 'a' },
    { id: 'b', title: 'B', blurb: 'b' },
  ]
  const m = withStep(withStep(mockup({ id: 'm' }), 'concepts', { status: 'done', version: 1, options, chosen: 'b' }), 'plan', { status: 'ready' })
  const ctx = contextFor(m, 'plan', 'r1')
  assert.deepEqual(ctx.chosen, { stage: 'concepts', file: '02-concepts.md', option: options[1] })
  assert.equal(contextFor(m, 'concepts', 'r1').chosen, undefined)
  assert.equal(ctx.runId, 'r1')
  assert.equal(ctx.vaultDir, m.vaultDir)
})
