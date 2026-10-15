import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Task } from '../types.ts'
import { agoOf, anyReading, originSessionOf, readingOf, sourceOf, wroteOf } from './triage-model.ts'
import type { Where } from './where.ts'

function card(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Comprar pan',
    notes: '',
    status: 'triage',
    order: 'V',
    cycle: null,
    area: null,
    project: null,
    priority: 0,
    labels: [],
    estimate: null,
    due: null,
    remindAt: null,
    remindedAt: null,
    reminderMissed: false,
    subtasks: [],
    source: { kind: 'capture', raw: 'comprar pan mañana', parse: 'ok' },
    sessions: [],
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z',
    completedAt: null,
    ...over,
  }
}

const capture = (parse: 'pending' | 'ok' | 'failed' | 'skipped', raw = 'x') => ({ kind: 'capture' as const, raw, parse })

test('readingOf: pending is reading, failed is failed; ok, skipped and every other source show nothing (crit. 23, 23b)', () => {
  assert.equal(readingOf(card({ source: capture('pending') })), 'reading')
  assert.equal(readingOf(card({ source: capture('failed') })), 'failed')
  assert.equal(readingOf(card({ source: capture('ok') })), undefined)
  assert.equal(readingOf(card({ source: capture('skipped') })), undefined)
  assert.equal(readingOf(card({ source: { kind: 'owner' } })), undefined)
})

test('anyReading: the screen polls while one card is still being read, and stops after (crit. 23c)', () => {
  assert.equal(anyReading([card({ source: capture('ok') }), card({ source: capture('pending') })]), true)
  assert.equal(anyReading([card({ source: capture('ok') }), card({ source: capture('failed') })]), false)
  assert.equal(anyReading([]), false)
})

test('sourceOf: «Captured», or «Agent» with its project and host (crit. 20)', () => {
  assert.deepEqual(sourceOf(card()), { kind: 'captured', label: 'Captured' })
  assert.deepEqual(sourceOf(card({ source: { kind: 'agent', host: 'omarchy', sessionId: 's', siteId: 'bwr' } })), {
    kind: 'agent',
    label: 'Agent · bwr on omarchy',
  })
  assert.deepEqual(sourceOf(card({ source: { kind: 'agent', host: null, sessionId: 's', siteId: 'bwr' } })), { kind: 'agent', label: 'Agent · bwr' })
  assert.deepEqual(sourceOf(card({ source: { kind: 'owner' } })), { kind: 'owner', label: 'Added by hand' })
})

test('originSessionOf: the session an agent card came from, on its host as the client names it, from both apps (crit. 20, 30b)', () => {
  const OMARCHY_APP: Where = { boardHost: undefined, selfName: 'omarchy' }
  const MAC_APP: Where = { boardHost: 'omarchy', selfName: 'mac' }
  const onBoard = card({ source: { kind: 'agent', host: null, sessionId: 'abc', siteId: 'bwr' } })
  const onMac = card({ source: { kind: 'agent', host: 'mac', sessionId: 'def', siteId: 'site' } })

  assert.deepEqual(originSessionOf(onBoard, OMARCHY_APP), { sessionId: 'abc', host: undefined })
  assert.deepEqual(originSessionOf(onBoard, MAC_APP), { sessionId: 'abc', host: 'omarchy' })
  assert.deepEqual(originSessionOf(onMac, OMARCHY_APP), { sessionId: 'def', host: 'mac' })
  assert.deepEqual(originSessionOf(onMac, MAC_APP), { sessionId: 'def', host: undefined })
})

test('originSessionOf: nothing for a capture or a card by hand, nor before the hosts are known', () => {
  const where: Where = { boardHost: undefined, selfName: 'omarchy' }
  assert.equal(originSessionOf(card(), where), undefined)
  assert.equal(originSessionOf(card({ source: { kind: 'owner' } }), where), undefined)
  assert.equal(originSessionOf(card({ source: { kind: 'agent', host: null, sessionId: 'abc', siteId: 'bwr' } }), undefined), undefined)
})

test('wroteOf: what the owner typed, once claude rewrote it; nothing while reading, or when the title is the text', () => {
  assert.equal(wroteOf(card()), 'comprar pan mañana')
  assert.equal(wroteOf(card({ source: capture('pending', 'comprar pan mañana') })), undefined)
  assert.equal(wroteOf(card({ title: 'same', source: capture('ok', 'same') })), undefined)
  // A capital or a full stop is not a rewrite: nothing worth repeating.
  assert.equal(wroteOf(card({ title: 'Prueba enter a triage', source: capture('ok', 'prueba enter a triage.') })), undefined)
  // A failed read keeps the text as the title: nothing to repeat.
  assert.equal(wroteOf(card({ title: 'comprar pan mañana', source: capture('failed', 'comprar pan mañana') })), undefined)
  assert.equal(wroteOf(card({ source: { kind: 'owner' } })), undefined)
})

test('agoOf: just now, minutes, hours, days', () => {
  const now = new Date('2026-10-14T12:00:00.000Z')
  assert.equal(agoOf('2026-10-14T11:59:30.000Z', now), 'just now')
  assert.equal(agoOf('2026-10-14T11:58:00.000Z', now), '2 min ago')
  assert.equal(agoOf('2026-10-14T09:00:00.000Z', now), '3 h ago')
  assert.equal(agoOf('2026-10-12T12:00:00.000Z', now), '2 d ago')
  assert.equal(agoOf('not a date', now), '')
})
