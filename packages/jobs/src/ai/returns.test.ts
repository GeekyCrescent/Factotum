import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appTransition, followupTransition } from '../state.ts'
import * as repo from '../store/repo.ts'
import { NOW, valueOf } from '../test-state.ts'
import { tempBase } from '../test-support.ts'
import { instructionEvent, type InstructionEventData } from './queue.ts'
import { insertApp, insertFollowup, queueStore, rig } from './test-queue.ts'

const MINUTE = 60_000

test('the instruction event has ONE shape, pinned: { kind: instruction, data: { instruction } }', () => {
  const data: InstructionEventData = { instruction: 'Shorter, and mention Kubernetes' }
  assert.deepEqual(instructionEvent('Shorter, and mention Kubernetes'), { kind: 'instruction', data })
})

test('what instructionEvent writes is what a failed rewrite reads back, for an application and a follow-up', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  insertApp(db, { state: 'ready' })
  insertFollowup(db, { state: 'draft' })
  const { queue, clock } = rig(db, { handlers: { rewrite: async () => ({ ok: false, kind: 'failed', reason: 'x' }) } })
  valueOf(
    db.tx((q) => {
      const app = valueOf(appTransition(repo.getApplication(q, 'app-1')!, { type: 'instruction', hasLetter: true }, NOW))
      const saved = repo.saveApplication(q, app, instructionEvent('For the app'), NOW)
      return saved.ok ? queue.enqueue(q, { kind: 'rewrite', ref: 'app-1' }) : saved
    }),
  )
  const followupId = 'fu-1'
  valueOf(
    db.tx((q) => {
      const row = valueOf(followupTransition(repo.getFollowup(q, followupId)!, { type: 'instruction' }, NOW))
      const saved = repo.saveFollowup(q, row, instructionEvent('For the follow-up'), NOW)
      return saved.ok ? queue.enqueue(q, { kind: 'rewrite', ref: followupId }) : saved
    }),
  )
  for (let i = 0; i < 3; i += 1) {
    queue.pump()
    await queue.settled()
    clock.advance(10 * MINUTE)
  }
  const failed = db.read((q) => repo.eventsOf(q, 'app-1')).filter((e) => e.kind === 'rewrite-failed')
  assert.deepEqual(
    failed.map((e) => e.data.instruction).sort(),
    ['For the app', 'For the follow-up'],
  )
})
