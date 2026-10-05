import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SourceConfig } from '../config.ts'
import { addressesIn, parseHeaderBlock } from './headers.ts'
import { sourceOf, type Addressing } from './sources.ts'

const ACCOUNT = 'cuenta@gmail.com'
const TEC: SourceConfig = { id: 'tec', label: 'Tec', address: 'a01@tec.mx', read: 'all' }
const MQ: SourceConfig = { id: 'mq', label: 'Macquarie', address: 'me@students.mq.edu.au', read: 'all' }
const OTHER: SourceConfig = { id: 'otro', label: 'Gmail 2', address: 'otro@gmail.com', read: 'all' }
const SOURCES = [TEC, MQ, OTHER]

const NONE: Addressing = { resentFrom: [], forwardedFor: [], deliveredTo: [], to: [], cc: [] }

test('Resent-From wins over To and Cc (Outlook redirect, measured in A5)', () => {
  const mail = { ...NONE, resentFrom: ['me@students.mq.edu.au'], to: ['a01@tec.mx'] }
  assert.equal(sourceOf(mail, SOURCES, ACCOUNT), MQ)
})

test('only in Resent-From — reached by Bcc or a list — still has its source', () => {
  const mail = { ...NONE, resentFrom: ['a01@tec.mx'], to: ['list@tec.mx'] }
  assert.equal(sourceOf(mail, SOURCES, ACCOUNT), TEC)
})

test('a Gmail forward: the FIRST address of X-Forwarded-For, never the account behind it', () => {
  const headers = parseHeaderBlock(
    'Delivered-To: cuenta@gmail.com\r\nX-Forwarded-For: otro@gmail.com cuenta@gmail.com\r\nX-Forwarded-To: cuenta@gmail.com\r\nDelivered-To: otro@gmail.com\r\n\r\n',
  )
  const mail = {
    ...NONE,
    forwardedFor: addressesIn(headers.get('x-forwarded-for')),
    deliveredTo: addressesIn(headers.get('delivered-to')),
  }
  assert.deepEqual(mail.deliveredTo, ['cuenta@gmail.com', 'otro@gmail.com'])
  assert.equal(sourceOf(mail, SOURCES, ACCOUNT), OTHER)
  // And a source configured AS the account itself is not matched through the account's own Delivered-To.
  const self: SourceConfig = { id: 'self', label: 'Self', address: ACCOUNT, read: 'all' }
  assert.equal(sourceOf({ ...NONE, deliveredTo: [ACCOUNT], forwardedFor: [] }, [self], ACCOUNT), undefined)
})

test('a Delivered-To that is not the account is enough on its own', () => {
  assert.equal(sourceOf({ ...NONE, deliveredTo: ['cuenta@gmail.com', 'a01@tec.mx'] }, SOURCES, 'Cuenta@Gmail.com'), TEC)
})

test('To, then Cc, when nothing was forwarded', () => {
  assert.equal(sourceOf({ ...NONE, to: ['x@y.z'], cc: ['me@students.mq.edu.au'] }, SOURCES, ACCOUNT), MQ)
})

test('a mail FROM somebody at a source domain is not that source (From never counts)', () => {
  // `Addressing` has no `from` at all: the guarantee is the type.
  const mail = { ...NONE, to: [ACCOUNT] }
  assert.equal(sourceOf(mail, [{ id: 'bwr', label: 'BWR', address: 'boss@bwr.mx', read: 'all' }], ACCOUNT), undefined)
})

test('compared in lower case, and no source is undefined (criterion 7)', () => {
  const headers = parseHeaderBlock('Resent-From: "Me, Myself" <ME@Students.MQ.edu.au>\r\n')
  assert.equal(sourceOf({ ...NONE, resentFrom: addressesIn(headers.get('resent-from')) }, SOURCES, ACCOUNT), MQ)
  const upper: SourceConfig = { ...TEC, address: 'A01@TEC.MX' }
  assert.equal(sourceOf({ ...NONE, to: ['a01@tec.mx'] }, [upper], ACCOUNT), upper)
  assert.equal(sourceOf({ ...NONE, to: ['nobody@else.com'] }, SOURCES, ACCOUNT), undefined)
  assert.equal(sourceOf(NONE, [], ACCOUNT), undefined)
})

test('headers: folded lines are unfolded, names lower-cased, repeated ones kept in order', () => {
  const headers = parseHeaderBlock('List-Unsubscribe: <mailto:u@x.com>,\r\n <https://x.com/u>\r\nbroken line\r\n: empty\r\n')
  assert.deepEqual(headers.get('list-unsubscribe'), ['<mailto:u@x.com>, <https://x.com/u>'])
  assert.equal(headers.size, 1)
  assert.deepEqual(addressesIn(undefined), [])
})
