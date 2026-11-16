/**
 * The raw headers a digest reads (spec 2026-11-12, M3b; R71): `parseHeaderBlock` and `addressesIn`,
 * pure, on blocks shaped like what `FETCH BODY.PEEK[HEADER.FIELDS (…)]` returns.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addressesIn, parseHeaderBlock } from './headers.ts'

test('parseHeaderBlock unfolds a continuation line into the header above it', () => {
  const headers = parseHeaderBlock('List-Unsubscribe: <mailto:u@example.com>,\r\n\t<https://example.com/u>\r\nSubject: Hi\r\n\r\n')

  assert.deepEqual(headers.get('list-unsubscribe'), ['<mailto:u@example.com>, <https://example.com/u>'])
  assert.deepEqual(headers.get('subject'), ['Hi'])
})

test('parseHeaderBlock keeps every value of a repeated header, in order', () => {
  const headers = parseHeaderBlock('Delivered-To: a@example.com\r\nDelivered-To: b@example.com\r\n')

  assert.deepEqual(headers.get('delivered-to'), ['a@example.com', 'b@example.com'])
})

test('parseHeaderBlock lower-cases names, whatever their capitals, and merges them', () => {
  const headers = parseHeaderBlock('RESENT-FROM: a@example.com\nresent-from: b@example.com\nReSent-From:  c@example.com  \n')

  assert.deepEqual([...headers.keys()], ['resent-from'])
  assert.deepEqual(headers.get('resent-from'), ['a@example.com', 'b@example.com', 'c@example.com'])
})

test('parseHeaderBlock skips lines with no name before the colon, and an empty block is empty', () => {
  assert.equal(parseHeaderBlock('').size, 0)
  assert.equal(parseHeaderBlock(': orphan\r\nno colon here\r\n\r\n').size, 0)
})

test('parseHeaderBlock keeps a colon inside the value', () => {
  assert.deepEqual(parseHeaderBlock('X-Link: https://example.com:8443/a\r\n').get('x-link'), ['https://example.com:8443/a'])
})

test('addressesIn drops the display name and lower-cases the address', () => {
  assert.deepEqual(addressesIn(['"Prof. Smith" <Prof.Smith@MQ.edu.au>']), ['prof.smith@mq.edu.au'])
})

test('addressesIn reads a bare address, without a name', () => {
  assert.deepEqual(addressesIn(['me@students.mq.edu.au']), ['me@students.mq.edu.au'])
})

test('addressesIn reads every address of a list, across values, in order', () => {
  const values = ['Ana <ana@example.com>, bob@example.com; "C, D" <cd@example.org>', 'last@example.net']

  assert.deepEqual(addressesIn(values), ['ana@example.com', 'bob@example.com', 'cd@example.org', 'last@example.net'])
})

test('addressesIn is empty for no values, an empty value, or a value with no address', () => {
  assert.deepEqual(addressesIn(undefined), [])
  assert.deepEqual(addressesIn([]), [])
  assert.deepEqual(addressesIn(['']), [])
  assert.deepEqual(addressesIn(['undisclosed-recipients:;']), [])
})
