import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CUT_KINDS, isLaunchable, nextStage, RUN_SPECS, STAGES } from './stages.ts'
import { STAGE_IDS } from './types.ts'

test('the stage table carries the five stages of D2, in order, each pointing at the next', () => {
  assert.deepEqual(Object.keys(STAGES), [...STAGE_IDS])
  assert.equal(nextStage('brief'), 'concepts')
  assert.equal(nextStage('concepts'), 'plan')
  assert.equal(nextStage('plan'), 'build')
  assert.equal(nextStage('build'), 'deliver')
  assert.equal(nextStage('deliver'), null)
})

test('brief, concepts and plan run on the docs site; build and deliver on the work-dir', () => {
  assert.deepEqual(
    STAGE_IDS.map((id) => STAGES[id].site),
    ['docs', 'docs', 'docs', 'work', 'work'],
  )
})

test('the documents each stage must write are the fixed names of D2', () => {
  assert.deepEqual(STAGES.brief.files, ['01-brief.md'])
  assert.deepEqual(STAGES.concepts.files, ['02-concepts.md'])
  assert.deepEqual(STAGES.plan.files, ['03-story-and-pages.md', '04-data.md', '05-visual-direction.md'])
  assert.deepEqual(STAGES.deliver.files, ['06-presenter-guide.md'])
})

test('the gates: approve on brief and build, choose on concepts and plan, none on deliver', () => {
  assert.deepEqual(
    STAGE_IDS.map((id) => STAGES[id].gate),
    ['approve', 'choose', 'choose', 'approve', null],
  )
  assert.deepEqual(STAGES.plan.options, { min: 2, max: 3, url: true })
  assert.deepEqual(STAGES.concepts.options, { min: 2, max: 3, url: false })
  assert.equal(STAGES.brief.options, null)
})

test('changes are not a stage: change has a gate on the work-dir, redeploy has none', () => {
  assert.equal(RUN_SPECS.change.site, 'work')
  assert.equal(RUN_SPECS.change.gate, 'approve')
  assert.equal(RUN_SPECS.redeploy.gate, null)
  assert.equal(RUN_SPECS.brief, STAGES.brief)
})

test('cut 2, block F, launches brief and concepts; plan arrives with block G', () => {
  assert.deepEqual(CUT_KINDS, ['brief', 'concepts'])
  assert.equal(isLaunchable('concepts'), true)
  assert.equal(isLaunchable('plan'), false)
  assert.equal(isLaunchable('change'), false)
})

test('crit. 28: the choice of a choosing stage is written into ONE of its documents', () => {
  assert.equal(STAGES.concepts.chosenIn, '02-concepts.md')
  assert.equal(STAGES.plan.chosenIn, '05-visual-direction.md')
  assert.equal(STAGES.brief.chosenIn, undefined)
})
