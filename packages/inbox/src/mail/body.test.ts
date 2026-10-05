import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countAttachments, decodePart, MAX_BODY_CHARS, pickPart, plainText, type PickedPart } from './body.ts'

test('multipart/alternative: the text/plain part is picked over the html one', () => {
  const structure = {
    type: 'multipart/alternative',
    childNodes: [
      { part: '1', type: 'text/plain' },
      { part: '2', type: 'text/html' },
    ],
  }
  assert.deepEqual(pickPart(structure), { part: '1', kind: 'text', encoding: '7bit', charset: 'utf-8' })
})

test('html only: the html part, and its text comes out without tags, styles or scripts', () => {
  const structure = { type: 'multipart/mixed', childNodes: [{ part: '1', type: 'TEXT/HTML' }] }
  assert.equal(pickPart(structure)?.kind, 'html')
  const html =
    '<html><head><title>T</title></head><style>.a{color:red}</style><script>alert(1)</script>' +
    '<!-- hidden --><p>Hola&nbsp;Juan,</p><div>Please send the <b>form</b> &amp; sign it&#33;</div>' +
    'line<br/>break &#x263A; &bogus;'
  const text = plainText(html, 'html')
  assert.equal(text, 'Hola Juan,\nPlease send the form & sign it!\nline\nbreak ☺ &bogus;')
  for (const leak of ['color:red', 'alert', 'hidden', '<', 'T\n']) assert.equal(text.includes(leak), false, leak)
})

test('a text/plain attachment is never picked, and attachments are counted', () => {
  const structure = {
    type: 'multipart/mixed',
    childNodes: [
      { part: '1', type: 'text/plain', disposition: 'attachment' },
      { part: '2', type: 'text/html' },
      { part: '3', type: 'application/pdf', disposition: 'ATTACHMENT' },
    ],
  }
  assert.deepEqual([pickPart(structure)?.part, pickPart(structure)?.kind], ['2', 'html'])
  assert.equal(countAttachments(structure), 2)
})

test('a single-part mail is section 1; no text at all is undefined', () => {
  assert.equal(pickPart({ type: 'text/plain' })?.part, '1')
  assert.equal(pickPart({ type: 'multipart/mixed', childNodes: [{ part: '1', type: 'image/png' }] }), undefined)
  assert.equal(pickPart(undefined), undefined)
  assert.equal(countAttachments(undefined), 0)
})

test('nested parts are walked depth first', () => {
  const structure = {
    type: 'multipart/mixed',
    childNodes: [
      { type: 'multipart/alternative', part: '1', childNodes: [{ part: '1.1', type: 'text/plain' }, { part: '1.2', type: 'text/html' }] },
      { part: '2', type: 'image/jpeg', disposition: 'attachment' },
    ],
  }
  assert.equal(pickPart(structure)?.part, '1.1')
  assert.equal(countAttachments(structure), 1)
})

test('the text is cut at MAX_BODY_CHARS with an ellipsis', () => {
  const text = plainText('x'.repeat(MAX_BODY_CHARS * 2), 'text')
  assert.equal(text.length, MAX_BODY_CHARS)
  assert.equal(text.endsWith('…'), true)
  assert.equal(plainText('short', 'text'), 'short')
})

test('quoted lines go, blanks collapse (criterion 8)', () => {
  const raw = 'Thanks, see below.\r\n\r\n\r\n\r\nOn Mon, Ana wrote:\r\n> the old text\r\n  >> older still\r\nBye   now\t\t!'
  assert.equal(plainText(raw, 'text'), 'Thanks, see below.\n\nOn Mon, Ana wrote:\nBye now !')
})

const part = (encoding: string, charset: string): PickedPart => ({ part: '1', kind: 'text', encoding, charset })

test('the encoding and the charset come from the structure', () => {
  const structure = { type: 'text/plain', encoding: 'QUOTED-PRINTABLE', parameters: { charset: 'iso-8859-1' } }
  assert.deepEqual(pickPart(structure), { part: '1', kind: 'text', encoding: 'quoted-printable', charset: 'iso-8859-1' })
})

test('quoted-printable: soft breaks joined, bytes decoded in their charset, a cut escape dropped', () => {
  assert.equal(decodePart(Buffer.from('Ma=C3=B1ana a la=\r\ns 9 =3D ok'), part('quoted-printable', 'utf-8')), 'Mañana a las 9 = ok')
  assert.equal(decodePart(Buffer.from('Se=F1or'), part('quoted-printable', 'iso-8859-1')), 'Señor')
  assert.equal(decodePart(Buffer.from('cut here =C'), part('quoted-printable', 'utf-8')), 'cut here ')
  assert.equal(decodePart(Buffer.from('ends with =3D'), part('quoted-printable', 'utf-8')), 'ends with =')
})

test('base64, also cut mid-way and wrapped, and 8bit as is', () => {
  const encoded = Buffer.from('Hola, ¿cómo estás?').toString('base64')
  assert.equal(decodePart(Buffer.from(`${encoded.slice(0, 12)}\r\n${encoded.slice(12)}`), part('base64', 'UTF-8')), 'Hola, ¿cómo estás?')
  assert.equal(decodePart(Buffer.from(encoded.slice(0, 10)), part('base64', 'utf-8')).startsWith('Hola'), true)
  assert.equal(decodePart(Buffer.from('plain ñ'), part('8bit', 'utf-8')), 'plain ñ')
})

test('an unknown charset reads as UTF-8 rather than failing', () => {
  assert.equal(decodePart(Buffer.from('café'), part('8bit', 'x-made-up')), 'café')
  assert.equal(decodePart(Buffer.from('plain'), part('7bit', 'us-ascii')), 'plain')
})
