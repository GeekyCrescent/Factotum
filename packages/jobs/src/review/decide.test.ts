import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { appOf, controlled, eventsOf, insertApp, insertFollowup, queueStore, rig, SEED_ARTIFACTS } from '../ai/test-queue.ts'
import type { Approved } from '../send/send.ts'
import { appTransition } from '../state.ts'
import type { Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { NOW, valueOf } from '../test-state.ts'
import { capturedLog, eventually, tempBase } from '../test-support.ts'
import { fail, ok, type Profile, type Result, type SendKind, type Warning } from '../types.ts'
import type { Batch, ReviewItemRef } from './batch.ts'
import { decide, NOT_A_FIT, type DecideDeps, type Decision } from './decide.ts'
import { openReview } from './open.ts'
import { seenOf } from './seen.ts'

const TZ = 'Australia/Sydney'
const CLAIM: Warning = { code: 'unsupported-claim', where: 'cv', detail: 'claim 1', blocks: true, overridden: null }
const STACK: Warning = { code: 'forbidden-stack', where: 'cv', detail: 'Java', blocks: true, overridden: null }

interface World {
  readonly db: Db
  readonly deps: DecideDeps
  readonly approvals: { id: string; kind: SendKind; addressOverride: boolean }[]
  readonly relinted: string[]
  readonly start: () => Batch
  readonly batch: () => Batch | null
  readonly letters: ReturnType<typeof controlled>
}

async function world(approveResult: Result<Approved> = ok({ state: 'sending', kind: 'initial' })): Promise<World> {
  const db = await queueStore(tempBase())
  valueOf(
    db.tx((q) => {
      repo.insertProfileVersion(q, { version: 2, createdAt: NOW.toISOString(), profile: { batchSize: 10 } as Profile }, { kind: 'profile-saved' }, NOW)
      return ok(undefined)
    }),
  )
  const letters = controlled()
  const { queue } = rig(db, { handlers: { letter: letters.handler, rewrite: controlled().handler } })
  const approvals: World['approvals'] = []
  const relinted: string[] = []
  let n = 0
  const newId = (): string => `id-${(n += 1)}`
  const opened = openReview({ db, now: () => NOW, timeZone: TZ, enqueueChecks: () => undefined, newId, log: capturedLog().log })
  const deps: DecideDeps = {
    db,
    now: () => NOW,
    approve: (id, kind, options) => {
      approvals.push({ id, kind, addressOverride: options?.addressOverride === true })
      return approveResult
    },
    queue,
    pdfExists: () => true,
    log: capturedLog().log,
    relintOne: (_q, entity) => {
      relinted.push(entity.id)
      return ok(undefined)
    },
  }
  return { db, deps, approvals, relinted, letters, start: () => valueOf(opened.startBatch()), batch: () => valueOf(opened.batch()) }
}

const itemOf = (batch: Batch, applicationId: string): ReviewItemRef => {
  const item = batch.items.find((i) => (i.kind === 'application' && i.applicationId === applicationId) || (i.kind === 'rewritten' && i.id === applicationId))
  if (item === undefined) assert.fail(`no item for ${applicationId}`)
  return item
}

const decision = (item: ReviewItemRef, kind: Decision['kind'], extra: Partial<Decision> = {}): Decision => ({ itemId: item.itemId, kind, ...extra })

function errorOf(result: Result<unknown>, code: string, reason?: string): void {
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, code, result.error.reason)
  if (reason !== undefined) assert.equal(result.error.reason, reason)
}

describe('decide — which item', () => {
  test('without an open batch, or an itemId not in it: not-found', async () => {
    const w = await world()
    errorOf(decide(w.deps, { itemId: 'nope', kind: 'approve' }), 'not-found')
    insertApp(w.db, { id: 'a1', state: 'ready' })
    w.start()
    errorOf(decide(w.deps, { itemId: 'nope', kind: 'approve' }), 'not-found')
  })

  test('a follow-up item is R2b: conflict followups-not-ready', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'sent' })
    insertFollowup(w.db, { id: 'fu-1', applicationId: 'a1', state: 'ready' })
    const batch = w.start()
    const item = batch.items[0]
    assert.equal(item?.kind, 'followup')
    if (item !== undefined) errorOf(decide(w.deps, decision(item, 'approve')), 'conflict', 'followups-not-ready')
  })

  test('an unknown kind of decision is invalid', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'ready' })
    const item = itemOf(w.start(), 'a1')
    errorOf(decide(w.deps, { itemId: item.itemId, kind: 'explode' as Decision['kind'] }), 'invalid')
  })

  test('switch-channel is a follow-up decision: conflict on an application', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'ready' })
    errorOf(decide(w.deps, decision(itemOf(w.start(), 'a1'), 'switch-channel')), 'conflict', 'followups-not-ready')
  })
})

describe('decide approve (T-A11, T-A12 through the sender)', () => {
  test('it calls the sender, records approved and moves the cursor past the item', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'ready' })
    insertApp(w.db, { id: 'a2', state: 'ready' })
    const item = itemOf(w.start(), 'a1')
    const decided = valueOf(decide(w.deps, decision(item, 'approve', { addressOverride: true })))
    assert.deepEqual(w.approvals, [{ id: 'a1', kind: 'initial', addressOverride: true }])
    assert.deepEqual(decided, { itemId: item.itemId, result: 'approved', send: { state: 'sending', kind: 'initial' } })
    const batch = w.batch()
    assert.equal(batch?.results[item.itemId], 'approved')
    assert.equal(batch?.cursor, 1)
    errorOf(decide(w.deps, decision(item, 'approve')), 'conflict', 'already-decided')
  })

  test('a batch note that cannot be written after the send moved: logged, and the answer says it was not recorded', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'ready' })
    const item = itemOf(w.start(), 'a1')
    const log = capturedLog()
    const db: Db = { ...w.db, tx: () => fail('module-error', 'disk I/O error') }
    const decided = valueOf(decide({ ...w.deps, db, log: log.log }, decision(item, 'approve')))
    assert.deepEqual(decided, { itemId: item.itemId, result: null, send: { state: 'sending', kind: 'initial' }, unrecorded: 'disk I/O error' })
    assert.equal(w.approvals.length, 1, 'the send is not undone')
    assert.ok(log.lines.some((line) => line.startsWith('error') && line.includes('disk I/O error') && line.includes(item.itemId)))
    assert.equal(w.batch()?.results[item.itemId], undefined)
  })

  test('a batch closed while the sender ran: the send stands, the answer says it was not recorded', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'ready' })
    const item = itemOf(w.start(), 'a1')
    const log = capturedLog()
    const approve: DecideDeps['approve'] = (...args) => {
      w.db.tx((q) => {
        repo.closeBatches(q, NOW)
        return ok(undefined)
      })
      return w.deps.approve(...args)
    }
    const decided = valueOf(decide({ ...w.deps, approve, log: log.log }, decision(item, 'approve')))
    assert.equal(decided.result, null)
    assert.equal(decided.unrecorded, 'no such item in the open batch')
    assert.equal(log.lines.length, 1)
  })

  test('a refusal of the sender (check-pending) passes through and decides nothing', async () => {
    const w = await world(fail('conflict', 'check-pending'))
    insertApp(w.db, { id: 'a1', state: 'ready' })
    const item = itemOf(w.start(), 'a1')
    errorOf(decide(w.deps, decision(item, 'approve')), 'conflict', 'check-pending')
    assert.deepEqual(w.batch()?.results, {})
  })
})

describe('decide with seen (D15 «Lo que se vio es lo que se aprueba»)', () => {
  const seenNow = (w: World, item: ReviewItemRef): string => w.db.read((q) => seenOf(q, item))
  /** A rewrite that comes back between the render and the decision: a new version with another warning. */
  const rewriteReturns = (w: World, id: string): void =>
    valueOf(
      w.db.tx((q) => {
        const app = repo.getApplication(q, id)
        if (app === undefined) return fail('not-found', id)
        return repo.saveApplication(q, { ...app, version: app.version + 1, warnings: [CLAIM] }, { kind: 'note', data: {} }, NOW)
      }),
    )

  test('a rewrite that returns between render and approve: conflict stale, nothing sent, nothing recorded', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'ready' })
    const item = itemOf(w.start(), 'a1')
    const seen = seenNow(w, item)
    rewriteReturns(w, 'a1')
    errorOf(decide(w.deps, decision(item, 'approve', { seen })), 'conflict', 'stale')
    assert.deepEqual(w.approvals, [])
    assert.deepEqual(w.batch()?.results, {})
  })

  test('the same seen: decided', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'ready' })
    const item = itemOf(w.start(), 'a1')
    const decided = valueOf(decide(w.deps, decision(item, 'approve', { seen: seenNow(w, item) })))
    assert.equal(decided.result, 'approved')
  })

  test('override, skip, instruct and switch-to-form with a stale seen decide nothing', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'in-review', warnings: [CLAIM] }, { ...SEED_ARTIFACTS, pdf: 'cv.pdf' })
    const item = itemOf(w.start(), 'a1')
    const seen = seenNow(w, item)
    rewriteReturns(w, 'a1')
    const before = eventsOf(w.db, 'a1').length
    errorOf(decide(w.deps, decision(item, 'override', { seen, warningCodes: ['unsupported-claim'] })), 'conflict', 'stale')
    errorOf(decide(w.deps, decision(item, 'skip', { seen, reason: 'not-a-fit' })), 'conflict', 'stale')
    errorOf(decide(w.deps, decision(item, 'instruct', { seen, text: 'Shorter' })), 'conflict', 'stale')
    errorOf(decide(w.deps, decision(item, 'switch-to-form', { seen })), 'conflict', 'stale')
    assert.equal(eventsOf(w.db, 'a1').length, before)
    assert.equal(appOf(w.db, 'a1').state, 'in-review')
  })

  test('a seen that is not a fingerprint is invalid', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'ready' })
    const item = itemOf(w.start(), 'a1')
    errorOf(decide(w.deps, decision(item, 'approve', { seen: '' })), 'invalid')
    errorOf(decide(w.deps, decision(item, 'approve', { seen: 'x'.repeat(200) })), 'invalid')
  })
})

describe('decide skip (T-A22, S10)', () => {
  test('a skip needs a reason', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'ready' })
    errorOf(decide(w.deps, decision(itemOf(w.start(), 'a1'), 'skip', { reason: '  ' })), 'invalid')
  })

  test('«not a fit» closes it, dropped, with skipped { reason }', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'in-review' })
    const item = itemOf(w.start(), 'a1')
    valueOf(decide(w.deps, decision(item, 'skip', { reason: NOT_A_FIT })))
    const app = appOf(w.db, 'a1')
    assert.equal(app.state, 'closed')
    assert.equal(app.outcome, 'dropped')
    assert.deepEqual(eventsOf(w.db, 'a1').at(-1)?.data, { reason: NOT_A_FIT })
    assert.equal(w.batch()?.results[item.itemId], 'skipped')
  })

  test('any other reason leaves the state, writes skipped, and keeps it out of today’s next batch', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'ready' })
    insertApp(w.db, { id: 'a2', state: 'ready' })
    valueOf(decide(w.deps, decision(itemOf(w.start(), 'a1'), 'skip', { reason: 'not-now' })))
    assert.equal(appOf(w.db, 'a1').state, 'ready')
    assert.equal(eventsOf(w.db, 'a1').at(-1)?.kind, 'skipped')
    assert.deepEqual(
      w.start().items.map((i) => (i.kind === 'application' ? i.applicationId : i.kind)),
      ['a2'],
    )
  })

  test('the client’s tokens are the reasons; case and spacing do not matter, anything else is invalid', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'in-review' })
    insertApp(w.db, { id: 'a2', state: 'in-review' })
    const batch = w.start()
    errorOf(decide(w.deps, decision(itemOf(batch, 'a1'), 'skip', { reason: 'banana' })), 'invalid')
    valueOf(decide(w.deps, decision(itemOf(batch, 'a1'), 'skip', { reason: ' Not a  Fit ' })))
    assert.equal(appOf(w.db, 'a1').state, 'closed', '«Not a fit», however it is spelled, closes it')
    assert.deepEqual(eventsOf(w.db, 'a1').at(-1)?.data, { reason: 'not-a-fit' })
    valueOf(decide(w.deps, decision(itemOf(batch, 'a2'), 'skip', { reason: 'other', text: ' Recruiter agency ' })))
    assert.equal(appOf(w.db, 'a2').state, 'in-review')
    assert.deepEqual(eventsOf(w.db, 'a2').at(-1)?.data, { reason: 'other', text: 'Recruiter agency' })
  })
})

describe('decide instruct (T-A7, T-A4)', () => {
  test('an empty instruction is invalid', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'ready' })
    errorOf(decide(w.deps, decision(itemOf(w.start(), 'a1'), 'instruct', { text: '' })), 'invalid')
  })

  test('with a letter: rewriting, the instruction event, a rewrite queued interactive', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'ready' })
    const item = itemOf(w.start(), 'a1')
    const decided = valueOf(decide(w.deps, decision(item, 'instruct', { text: 'Make it shorter' })))
    assert.equal(decided.result, 'instructed')
    const app = appOf(w.db, 'a1')
    assert.equal(app.state, 'rewriting')
    assert.equal(app.rewriteFrom, 'ready')
    const last = eventsOf(w.db, 'a1').at(-1)
    assert.equal(last?.kind, 'instruction')
    assert.deepEqual(last?.data, { instruction: 'Make it shorter' })
    const requests = w.db.read((q) => repo.genRequestsOf(q, 'a1'))
    const work = w.db.read((q) => repo.getWork(q, requests[0]?.workId ?? ''))
    assert.equal(work?.kind, 'rewrite')
    assert.equal(work?.lane, 'interactive')
    assert.deepEqual(
      requests.map((r) => [r.kind, r.workId]),
      [
        ['cv', work?.id],
        ['letter', work?.id],
      ],
    )
    assert.equal(w.batch()?.results[item.itemId], 'instructed')
  })

  test('«Try again» on a rewrite that failed sends the instruction again', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'ready' })
    valueOf(decide(w.deps, decision(itemOf(w.start(), 'a1'), 'instruct', { text: 'Shorter' })))
    valueOf(
      w.db.tx((q) => {
        const app = repo.getApplication(q, 'a1')
        if (app === undefined) return fail('not-found', 'a1')
        return repo.saveApplication(q, { ...app, state: 'ready', rewriteFrom: null }, { kind: 'rewrite-failed', data: { instruction: 'Shorter', reason: 'slots' } }, NOW)
      }),
    )
    const failed = w.batch()?.items.find((i) => i.kind === 'rewritten')
    assert.equal(failed?.kind === 'rewritten' && failed.failed, true)
    if (failed !== undefined) valueOf(decide(w.deps, decision(failed, 'instruct', { text: 'Shorter' })))
    assert.equal(appOf(w.db, 'a1').state, 'rewriting')
  })

  test('without a letter (M9): generating, a NEW letter with the instruction, not a rewrite', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'in-review' }, { ...SEED_ARTIFACTS, letter: null, pdf: 'cv.pdf' })
    const item = itemOf(w.start(), 'a1')
    valueOf(decide(w.deps, decision(item, 'instruct', { text: 'Mention the hospital project' })))
    assert.equal(appOf(w.db, 'a1').state, 'generating')
    const kinds = eventsOf(w.db, 'a1').slice(-2)
    assert.deepEqual(
      kinds.map((e) => [e.kind, e.data]),
      [
        ['instruction', { instruction: 'Mention the hospital project' }],
        ['retried', { kinds: ['letter'] }],
      ],
    )
    await eventually(() => w.letters.calls.length === 1, 'the letter ran')
    const work = w.letters.calls[0]
    assert.equal(work?.kind, 'letter')
    assert.equal(work?.lane, 'interactive')
    w.letters.finish(work?.id ?? '', { ok: true, output: { type: 'application', artifacts: { letter: { subject: 'Hi', body: 'New {signature}' }, profileVersion: 2, rules: [], usage: null, origin: 'generated' } } })
    await eventually(() => appOf(w.db, 'a1').state !== 'generating', 'it came back')
    assert.equal(appOf(w.db, 'a1').state, 'ready')
  })
})

describe('decide override and switch-to-form', () => {
  test('«I checked it» marks the claim overridden and re-lints to ready (T-A5), with override { codes }', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'in-review', warnings: [CLAIM] }, { ...SEED_ARTIFACTS, pdf: 'cv.pdf' })
    const item = itemOf(w.start(), 'a1')
    const decided = valueOf(decide(w.deps, decision(item, 'override', { warningCodes: ['unsupported-claim'] })))
    assert.equal(decided.result, null)
    const app = appOf(w.db, 'a1')
    assert.equal(app.state, 'ready')
    assert.deepEqual(app.warnings[0]?.overridden, { at: NOW.toISOString() })
    assert.deepEqual(eventsOf(w.db, 'a1').at(-1)?.data, { codes: ['unsupported-claim'] })
    assert.equal(w.batch()?.results[item.itemId], undefined, 'the item stays to be approved')
  })

  test('another block stays: in-review', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'in-review', warnings: [CLAIM, STACK] })
    valueOf(decide(w.deps, decision(itemOf(w.start(), 'a1'), 'override', { warningCodes: ['unsupported-claim'] })))
    assert.equal(appOf(w.db, 'a1').state, 'in-review')
  })

  test('only the verifier and external-link take «I checked it»; none given is invalid', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'in-review', warnings: [STACK] })
    const item = itemOf(w.start(), 'a1')
    errorOf(decide(w.deps, decision(item, 'override', { warningCodes: ['forbidden-stack'] })), 'invalid')
    errorOf(decide(w.deps, decision(item, 'override', { warningCodes: [] })), 'invalid')
  })

  test('«I checked it» with no open warning of those codes is a conflict, and writes nothing', async () => {
    const w = await world()
    const checked: Warning = { ...CLAIM, overridden: { at: NOW.toISOString() } }
    insertApp(w.db, { id: 'a1', state: 'in-review', warnings: [checked, STACK] })
    const item = itemOf(w.start(), 'a1')
    const before = eventsOf(w.db, 'a1').length
    errorOf(decide(w.deps, decision(item, 'override', { warningCodes: ['unsupported-claim'] })), 'conflict', 'nothing-to-check')
    errorOf(decide(w.deps, decision(item, 'override', { warningCodes: ['external-link'] })), 'conflict', 'nothing-to-check')
    assert.equal(eventsOf(w.db, 'a1').length, before)
  })

  test('«I checked it» on a closed ad (the card offers it beside «Skip it»)', async () => {
    const w = await world()
    const closed: Warning = { code: 'ad-closed', where: 'ad', detail: 'the ad is closed (expired): skip it?', blocks: true, overridden: null }
    insertApp(w.db, { id: 'a1', state: 'in-review', warnings: [closed] }, { ...SEED_ARTIFACTS, pdf: 'cv.pdf' })
    valueOf(decide(w.deps, decision(itemOf(w.start(), 'a1'), 'override', { warningCodes: ['ad-closed'] })))
    assert.equal(appOf(w.db, 'a1').state, 'ready')
  })

  test('switch-to-form re-lints that item and a found warning survives the re-lint (D6 «Re-lint»)', async () => {
    const w = await world()
    valueOf(
      w.db.tx((q) => {
        const opp = repo.getOpportunity(q, 'opp-1')
        if (opp === undefined) return fail('not-found', 'opp')
        repo.insertOpportunity(q, { ...opp, id: 'opp-2', url: 'https://acme.example/jobs/1' }, 'acme|other', { kind: 'imported' }, NOW)
        return ok(undefined)
      }),
    )
    insertApp(w.db, { id: 'a1', state: 'in-review', opportunityId: 'opp-2', warnings: [CLAIM] }, { ...SEED_ARTIFACTS, pdf: 'cv.pdf' })
    // L4's relintOne as it will be: the linter's warnings only (here none), through the `relint` transition.
    const relintOne: DecideDeps['relintOne'] = (q, entity, now) => {
      const app = repo.getApplication(q, entity.id)
      if (app === undefined) return fail('not-found', entity.id)
      const moved = appTransition(app, { type: 'relint', pdfExists: true, warnings: [] }, now)
      return moved.ok ? repo.saveApplication(q, moved.value, { kind: 'relinted', data: {} }, now) : moved
    }
    valueOf(decide({ ...w.deps, relintOne }, decision(itemOf(w.start(), 'a1'), 'switch-to-form')))
    const app = appOf(w.db, 'a1')
    assert.deepEqual(app.warnings, [CLAIM])
    assert.equal(app.state, 'in-review', 'the unsupported claim still blocks')
  })

  test('switch-to-form (T-A10): channel form, the URL, channel-changed, and a re-lint of that item', async () => {
    const w = await world()
    valueOf(
      w.db.tx((q) => {
        const opp = repo.getOpportunity(q, 'opp-1')
        if (opp === undefined) return fail('not-found', 'opp')
        repo.insertOpportunity(q, { ...opp, id: 'opp-2', url: 'https://acme.example/jobs/1' }, 'acme|other', { kind: 'imported' }, NOW)
        return ok(undefined)
      }),
    )
    insertApp(w.db, { id: 'a1', state: 'ready', opportunityId: 'opp-2' })
    insertApp(w.db, { id: 'a2', state: 'ready' })
    const batch = w.start()
    valueOf(decide(w.deps, decision(itemOf(batch, 'a1'), 'switch-to-form')))
    const app = appOf(w.db, 'a1')
    assert.equal(app.channel, 'form')
    assert.equal(app.target.url, 'https://acme.example/jobs/1')
    assert.deepEqual(eventsOf(w.db, 'a1').at(-1)?.data, { from: 'email', to: 'form' })
    assert.deepEqual(w.relinted, ['a1'])
    errorOf(decide(w.deps, decision(itemOf(batch, 'a2'), 'switch-to-form')), 'conflict', 'no-form-url')
  })
})
