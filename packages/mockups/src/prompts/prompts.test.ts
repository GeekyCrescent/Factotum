import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mockup, withStep } from '../test-support.ts'
import { briefPrompt } from './brief.ts'
import { choiceSection, type PromptContext } from './common.ts'
import { conceptsPrompt } from './concepts.ts'
import { buildPrompt } from './build.ts'
import { planPrompt } from './plan.ts'
import { contextFor, promptFor } from './index.ts'

const CTX: PromptContext = {
  runId: '0192f3a4-5b6c-7d8e-9f01-23456789abcd',
  stage: 'brief',
  project: 'medical-trust-center',
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

test('promptFor answers brief, concepts, plan and build, and null for a kind of a later block', () => {
  assert.equal(promptFor(CTX), briefPrompt(CTX))
  assert.equal(promptFor({ ...CTX, stage: 'concepts' }), conceptsPrompt({ ...CTX, stage: 'concepts' }))
  assert.equal(promptFor({ ...CTX, stage: 'plan' }), planPrompt({ ...CTX, stage: 'plan' }))
  assert.equal(promptFor({ ...CTX, stage: 'build' }), buildPrompt({ ...CTX, stage: 'build' }))
  assert.equal(promptFor({ ...CTX, stage: 'change' }), null)
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
  assert.equal(ctx.project, m.project)
  assert.deepEqual(ctx.chosen, { stage: 'concepts', file: '02-concepts.md', option: options[1] })
  assert.equal(contextFor(m, 'concepts', 'r1').chosen, undefined)
  assert.equal(ctx.runId, 'r1')
  assert.equal(ctx.vaultDir, m.vaultDir)
})

const PLAN: PromptContext = {
  ...CTX,
  stage: 'plan',
  chosen: { stage: 'concepts', file: '02-concepts.md', option: { id: 'b', title: 'Check-in in one tap', blurb: 'The QR is the product.' } },
}

test('the plan prompt, first run', (t) => {
  t.assert.snapshot(planPrompt(PLAN))
})

test('crit. 23: the plan asks for the story in one sentence, 6 to 12 steps with ONE that sells, pages, cast and scenario', () => {
  const prompt = planPrompt(PLAN)
  for (const needle of ['03-story-and-pages.md', '04-data.md', '05-visual-direction.md', 'one sentence', '6 to 12', 'exactly ONE', 'cast', 'scenario', 'Next.js']) {
    assert.ok(prompt.includes(needle), needle)
  }
})

test('crit. 23: every animation names the step it serves, in a step → animation → what it causes table', () => {
  const prompt = planPrompt(PLAN)
  assert.match(prompt, /\| Step \| Animation \| What it causes \|/)
  assert.match(prompt, /Every row names a step of 03-story-and-pages\.md/)
})

test('crit. 24: the directions are a static site in <workDir>/directions/, one page per direction, deployed to a preview', () => {
  const prompt = planPrompt(PLAN)
  assert.ok(prompt.includes(`${CTX.workDir}/directions`))
  assert.match(prompt, /index\.html/)
  assert.match(prompt, /<id>\.html/)
  assert.match(prompt, /vercel deploy --yes/)
  assert.doesNotMatch(prompt, /vercel deploy (--yes )?--prod/)
  assert.match(prompt, /a preview, never `--prod`/)
  assert.match(prompt, /url.*<id>\.html/s)
})

test('crit. 34, D4 (A3): the deploy is opened — protection off after deploying, and the URL answers 200 before it is handed', () => {
  const prompt = planPrompt(PLAN)
  assert.ok(prompt.includes('vercel project protection disable medical-trust-center-directions --sso'))
  assert.ok(prompt.includes('vercel link --yes --project medical-trust-center-directions'))
  assert.match(prompt, /200/)
  assert.match(prompt, /curl/)
})

test('crit. 37: if vercel fails, the session does not submit; it says so and ends', () => {
  assert.match(planPrompt(PLAN), /If `vercel` fails.*do NOT call `submit_stage`/s)
})

test('only plan may look at the private inputs, for their shape, never to copy (D4; crit. 35)', () => {
  const prompt = planPrompt(PLAN)
  assert.doesNotMatch(prompt, /Do NOT open anything in/)
  assert.match(prompt, /only to learn the SHAPE/)
  assert.match(prompt, /Never copy a file or a value/)
  assert.ok(!prompt.includes('pacientes.xlsx'), 'the private names are never listed')
})

test('crit. 28: the plan builds on the concept the owner chose', () => {
  const prompt = planPrompt(PLAN)
  assert.match(prompt, /chose «Check-in in one tap» \(b\)/)
  assert.ok(prompt.includes(`${CTX.vaultDir}/02-concepts.md`))
})

test('crit. 29: a plan redo names the previous documents and the previous directions, absolute', () => {
  const previous = ['_versions/03-story-and-pages-v1.md', `${CTX.workDir}/directions/_versions/v1`]
  const prompt = planPrompt({ ...PLAN, redo: { comment: 'Menos azul.', previous } })
  assert.ok(prompt.includes(`${CTX.vaultDir}/_versions/03-story-and-pages-v1.md`))
  assert.ok(prompt.includes(`- ${CTX.workDir}/directions/_versions/v1`))
  assert.ok(!prompt.includes(`${CTX.vaultDir}${CTX.workDir}`))
})

test('crit. 35: the deploy stays protected until check_real_data clears it; a refusal takes it down', () => {
  const prompt = planPrompt(PLAN)
  const enable = prompt.indexOf('vercel project protection enable medical-trust-center-directions --sso')
  const deploy = prompt.indexOf('vercel deploy --yes')
  const checked = prompt.indexOf('check_real_data')
  const disable = prompt.indexOf('vercel project protection disable')
  assert.ok(enable !== -1 && enable < deploy && deploy < checked && checked < disable, 'enable → deploy → check → disable')
  assert.match(prompt, /vercel remove <url> --yes/)
})

const BUILD: PromptContext = {
  ...CTX,
  stage: 'build',
  chosen: { stage: 'plan', file: '05-visual-direction.md', option: { id: 'c', title: 'Fichero', blurb: 'Cards you flip.', url: 'https://medical-trust-center-directions-x.vercel.app/c.html' } },
}

test('the build prompt, first run', (t) => {
  t.assert.snapshot(buildPrompt(BUILD))
})

test('crit. 32: the build makes the app in <workDir>/mockup-app/, builds it clean and deploys a preview from THAT folder', () => {
  const prompt = buildPrompt(BUILD)
  assert.ok(prompt.includes(`${CTX.workDir}/mockup-app`))
  assert.match(prompt, /npm run build/)
  assert.match(prompt, /Publish .*mockup-app to a Vercel preview, from inside that folder/)
  assert.ok(prompt.includes('vercel link --yes --project medical-trust-center-mockup'))
  assert.match(prompt, /a preview, never `--prod`/)
  assert.doesNotMatch(prompt, /vercel deploy (--yes )?--prod/)
})

test('crit. 32: the build reads the plan, seeds ALL its data from ONE file made from 04-data.md, and animates the chosen direction', () => {
  const prompt = buildPrompt(BUILD)
  for (const doc of ['01-brief.md', '03-story-and-pages.md', '04-data.md', '05-visual-direction.md']) assert.ok(prompt.includes(`${CTX.vaultDir}/${doc}`), doc)
  assert.match(prompt, /ONE file/)
  assert.match(prompt, /chose «Fichero» \(c\)/)
  assert.ok(prompt.includes(`${CTX.workDir}/directions/c.html`), 'the chosen direction’s page, as the reference')
  assert.match(prompt, /prefers-reduced-motion/)
  assert.match(prompt, /390/)
})

test('crit. 32: the build hands in previewUrl and names the app it built', () => {
  const prompt = buildPrompt(BUILD)
  assert.match(prompt, /previewUrl/)
  assert.ok(prompt.includes('files ["mockup-app/package.json"]'))
})

test('crit. 35: the build preview stays protected until check_real_data clears it', () => {
  const prompt = buildPrompt(BUILD)
  const enable = prompt.indexOf('vercel project protection enable medical-trust-center-mockup --sso')
  const deploy = prompt.indexOf('vercel deploy --yes')
  const checked = prompt.indexOf('check_real_data')
  const disable = prompt.indexOf('vercel project protection disable medical-trust-center-mockup --sso')
  assert.ok(enable !== -1 && enable < deploy && deploy < checked && checked < disable, 'enable → deploy → check → disable')
})

test('crit. 37 and the private inputs: a failed vercel ends without submitting; inputs/private is off limits in build', () => {
  const prompt = buildPrompt(BUILD)
  assert.match(prompt, /If `vercel` fails.*do NOT call `submit_stage`/s)
  assert.match(prompt, /Do NOT open anything in .*inputs\/private/)
})

test('crit. 29: a build redo carries the comment, literal, and the preview it replaces', (t) => {
  const prompt = buildPrompt({ ...BUILD, urls: { preview: 'https://medical-trust-center-mockup-old-team.vercel.app' }, redo: { comment: 'El paso 3 más lento.', previous: [] } })
  assert.match(prompt, /> El paso 3 más lento\./)
  assert.ok(prompt.includes('https://medical-trust-center-mockup-old-team.vercel.app'))
  assert.match(prompt, /the app as it is now in .*mockup-app/)
  t.assert.snapshot(prompt)
})

test('crit. 28: contextFor hands build the direction chosen at plan, and the mockup’s URLs', () => {
  const options = [
    { id: 'a', title: 'A', blurb: 'a', url: 'https://p-directions-x.vercel.app/a.html' },
    { id: 'b', title: 'B', blurb: 'b', url: 'https://p-directions-x.vercel.app/b.html' },
  ]
  const m = { ...withStep(mockup({ id: 'm' }), 'plan', { status: 'done', version: 1, options, chosen: 'a' }), urls: { preview: 'https://p-mockup-x.vercel.app' } }
  const ctx = contextFor(m, 'build', 'r1')
  assert.deepEqual(ctx.chosen, { stage: 'plan', file: '05-visual-direction.md', option: options[0] })
  assert.deepEqual(ctx.urls, { preview: 'https://p-mockup-x.vercel.app' })
})
