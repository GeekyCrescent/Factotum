import assert from 'node:assert/strict'
import { test } from 'node:test'
import { briefPrompt } from './brief.ts'
import type { PromptContext } from './common.ts'
import { promptFor } from './index.ts'

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

test('promptFor answers the brief, and null for a stage of a later cut', () => {
  assert.equal(promptFor(CTX), briefPrompt(CTX))
  assert.equal(promptFor({ ...CTX, stage: 'concepts' }), null)
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
