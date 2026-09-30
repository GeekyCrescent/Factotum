import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  admit,
  ATTACHMENTS_PER_MESSAGE,
  canSend,
  errorText,
  formatBytes,
  splitRefs,
  unavailableText,
  uploadsOf,
  uploadUrl,
  withRefs,
  type Attachment,
} from './attachments.ts'

const MB = 1024 * 1024
const ID = '019a0000-0000-7000-8000-000000000001'
const ROOT = '/Users/me/.factotum/prod/modules/sessions/uploads'

const ready = (name: string, path = `${ROOT}/${ID}/${name}`): Attachment => ({ key: name, state: 'ready', name, bytes: 10, preview: undefined, path, image: true })
const uploading = (name: string): Attachment => ({ key: name, state: 'uploading', name, bytes: 10, preview: undefined })
const failed = (name: string): Attachment => ({ key: name, state: 'failed', name, bytes: 10, reason: 'x' })

test('admit: everything fits under the ceiling and the count', () => {
  const files = [{ name: 'a.png', size: MB }, { name: 'b.pdf', size: 2 * MB }]
  assert.deepEqual(admit([], files, 20 * MB), { accepted: files, refused: undefined })
})

test('admit: the sixth is refused without being uploaded (criterion 22)', () => {
  const current = [ready('1'), ready('2'), ready('3'), ready('4')]
  const result = admit(current, [{ name: 'e.png', size: 1 }, { name: 'f.png', size: 1 }], 20 * MB)
  assert.equal(result.accepted.length, ATTACHMENTS_PER_MESSAGE - current.length)
  assert.match(result.refused ?? '', /At most 5/)
})

test('admit: a file over the ceiling it is handed is refused, saying the limit (criterion 23)', () => {
  const result = admit([], [{ name: 'huge.mov', size: 21 * MB }, { name: 'ok.png', size: MB }], 20 * MB)
  assert.deepEqual(result.accepted, [{ name: 'ok.png', size: MB }])
  assert.equal(result.refused, 'huge.mov is over the 20 MB limit.')
})

test('withRefs: no attachments leaves the text; text and files go in two blocks; files alone are just lines', () => {
  assert.equal(withRefs('hola', []), 'hola')
  assert.equal(withRefs('Mira esto  \n', [ready('a.png')]), `Mira esto\n\n@${ROOT}/${ID}/a.png`)
  assert.equal(withRefs('   ', [ready('a.png'), ready('b.png')]), `@${ROOT}/${ID}/a.png\n@${ROOT}/${ID}/b.png`)
  assert.equal(withRefs('hola', [uploading('a.png'), failed('b.png')]), 'hola', 'only ready ones travel')
})

test('canSend: text or a ready file; never while one uploads; a failed chip does not block (criterion 21)', () => {
  const base = { busy: false, text: '', attachments: [] as Attachment[], ready: true }
  assert.equal(canSend(base), false)
  assert.equal(canSend({ ...base, text: 'hola' }), true)
  assert.equal(canSend({ ...base, attachments: [ready('a.png')] }), true)
  assert.equal(canSend({ ...base, text: 'hola', attachments: [uploading('a.png')] }), false)
  assert.equal(canSend({ ...base, text: 'hola', attachments: [failed('a.png')] }), true)
  assert.equal(canSend({ ...base, attachments: [failed('a.png')] }), false)
  assert.equal(canSend({ ...base, text: 'hola', busy: true }), false)
  assert.equal(canSend({ ...base, text: 'hola', ready: false }), false)
})

test('uploadsOf reads the view as data: absent is an old daemon, off says why, on has its ceiling (criterion 27)', () => {
  assert.deepEqual(uploadsOf({ sites: [], catalog: [] }), { kind: 'old' })
  assert.deepEqual(uploadsOf(undefined), { kind: 'old' })
  assert.deepEqual(uploadsOf({ uploads: { maxBytes: 'lots' } }), { kind: 'old' })
  assert.deepEqual(uploadsOf({ uploads: { off: 'spaces' } }), { kind: 'off', reason: 'spaces' })
  assert.deepEqual(uploadsOf({ uploads: { maxBytes: 20 * MB } }), { kind: 'on', maxBytes: 20 * MB })
  assert.equal(unavailableText({ kind: 'old' }), 'Update Factotum to attach files.')
  assert.match(unavailableText({ kind: 'off', reason: 'spaces' }) ?? '', /spaces/)
  assert.equal(unavailableText({ kind: 'on', maxBytes: 1 }), undefined)
})

test('errorText: no answer never claims to know why; 413, 409 off and a message each say theirs (criterion 26)', () => {
  const unreachable = 'Upload failed: could not reach Factotum.'
  assert.equal(errorText(Object.assign(new Error('Failed to fetch'), { status: 0 })), unreachable)
  assert.equal(errorText(Object.assign(new Error('502'), { status: 502 })), unreachable)
  assert.equal(errorText(new TypeError('boom')), unreachable)
  assert.equal(errorText(Object.assign(new Error('x'), { status: 413 })), 'That file is over the size limit.')
  assert.match(errorText(Object.assign(new Error('off'), { status: 409, body: { uploads: { off: 'spaces' } } })), /spaces/)
  assert.equal(errorText(Object.assign(new Error('a file name cannot contain a slash'), { status: 400 })), 'a file name cannot contain a slash')
})

test('splitRefs: reference lines become pieces, the rest stays text around them (criterion 29)', () => {
  const pieces = splitRefs(`Mira esto\ny esto\n\n@${ROOT}/${ID}/captura.png\n@${ROOT}/${ID}/informe.pdf`)
  assert.deepEqual(pieces, [
    { kind: 'text', text: 'Mira esto\ny esto' },
    { kind: 'ref', uploadId: ID, name: 'captura.png', image: true },
    { kind: 'ref', uploadId: ID, name: 'informe.pdf', image: false },
  ])
})

test('splitRefs: a path that is not an upload, or not a whole line, stays text', () => {
  for (const text of [`look at @${ROOT}/${ID}/a.png`, `@${ROOT}/not-a-uuid/a.png`, `@${ROOT}/${ID}/a b.png`, '@/etc/passwd']) {
    assert.deepEqual(splitRefs(text), [{ kind: 'text', text }], text)
  }
  assert.deepEqual(splitRefs(''), [])
})

test('formatBytes and uploadUrl', () => {
  assert.equal(formatBytes(12), '12 B')
  assert.equal(formatBytes(640 * 1024), '640 KB')
  assert.equal(formatBytes(1.25 * MB), '1.3 MB')
  assert.equal(formatBytes(20 * MB), '20 MB')
  assert.equal(uploadUrl(ID, 'a.png'), `/modules/sessions/uploads/${ID}/a.png`)
})
