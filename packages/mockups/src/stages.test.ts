import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CUT_KINDS, isLaunchable, nextStage, RUN_SPECS, STAGES, vercelProjectOf } from './stages.ts'
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

test('cut 3, block L: every kind of run launches — the five stages, change and redeploy', () => {
  assert.deepEqual(CUT_KINDS, ['brief', 'concepts', 'plan', 'build', 'deliver', 'change', 'redeploy'])
  assert.equal(isLaunchable('change'), true)
  assert.equal(isLaunchable('redeploy'), true)
})

test('crit. 16, 32, 33, 36: what each publishing run hands in — a preview from build and change, production from deliver and redeploy', () => {
  assert.deepEqual(
    Object.entries(RUN_SPECS).map(([kind, spec]) => [kind, spec.hands ?? null]),
    [
      ['brief', null],
      ['concepts', null],
      ['plan', null],
      ['build', 'previewUrl'],
      ['deliver', 'prodUrl'],
      ['change', 'previewUrl'],
      ['redeploy', 'prodUrl'],
    ],
  )
})

test('crit. 32: build and change must name the app they built in the work-dir; redeploy writes changes.md in the vault', () => {
  assert.deepEqual(RUN_SPECS.build.workFiles, ['mockup-app/package.json'])
  assert.deepEqual(RUN_SPECS.change.workFiles, ['mockup-app/package.json'])
  assert.deepEqual(RUN_SPECS.redeploy.files, ['changes.md'])
  assert.equal(RUN_SPECS.brief.workFiles, undefined)
})

test('check 5 is pinned to the stage’s own Vercel project: <slug>-directions for plan, <slug>-mockup for the app', () => {
  assert.equal(vercelProjectOf('acme', 'plan'), 'acme-directions')
  for (const kind of ['build', 'deliver', 'change', 'redeploy'] as const) assert.equal(vercelProjectOf('acme', kind), 'acme-mockup', kind)
  assert.equal(vercelProjectOf('acme', 'brief'), null)
})

test('crit. 35: the guard runs on what publishes — plan, build, deliver, change, redeploy — and not on brief nor concepts', () => {
  assert.deepEqual(
    Object.entries(RUN_SPECS).filter(([, spec]) => spec.guard).map(([kind]) => kind).sort(),
    ['build', 'change', 'deliver', 'plan', 'redeploy'],
  )
})

test('crit. 28: the choice of a choosing stage is written into ONE of its documents', () => {
  assert.equal(STAGES.concepts.chosenIn, '02-concepts.md')
  assert.equal(STAGES.plan.chosenIn, '05-visual-direction.md')
  assert.equal(STAGES.brief.chosenIn, undefined)
})
