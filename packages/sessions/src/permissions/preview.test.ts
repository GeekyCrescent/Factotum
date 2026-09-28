import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HEAD_CHARS, TAIL_CHARS, previewOf } from './preview.ts'

test('Write previews its content', () => {
  assert.deepEqual(previewOf('Write', { file_path: '/x', content: 'hello' }), { head: 'hello', tail: '', total: 5, edits: null })
})

test('Edit previews its new_string, not the old one', () => {
  assert.deepEqual(previewOf('Edit', { file_path: '/x', old_string: 'OLD', new_string: 'new' }), { head: 'new', tail: '', total: 3, edits: null })
})

test('MultiEdit joins every new_string with a blank line and says how many edits there were', () => {
  const preview = previewOf('MultiEdit', { file_path: '/x', edits: [{ old_string: 'a', new_string: 'one' }, { old_string: 'b', new_string: 'two' }] })
  assert.deepEqual(preview, { head: 'one\n\ntwo', tail: '', total: 8, edits: 2 })
})

test('NotebookEdit previews its new_source', () => {
  assert.deepEqual(previewOf('NotebookEdit', { notebook_path: '/x.ipynb', new_source: 'print(1)' }), { head: 'print(1)', tail: '', total: 8, edits: null })
})

test('a tool that never reaches an ask has no preview: Bash is the declared hole, not a writer here', () => {
  assert.equal(previewOf('Bash', { command: 'rm -rf /' }), null)
  assert.equal(previewOf('Read', { file_path: '/x' }), null)
})

test('an input that is not an object, or a field that is not text, has no preview', () => {
  assert.equal(previewOf('Write', null), null)
  assert.equal(previewOf('Write', 'content'), null)
  assert.equal(previewOf('Write', { content: 42 }), null)
  assert.equal(previewOf('MultiEdit', { edits: 'nope' }), null)
  assert.equal(previewOf('MultiEdit', { edits: [{ new_string: 7 }] }), null)
})

test('content that fits in the head is not cut, and the tail stays empty', () => {
  const exactly = 'x'.repeat(HEAD_CHARS + TAIL_CHARS)
  const preview = previewOf('Write', { content: exactly })
  assert.equal(preview?.head, exactly)
  assert.equal(preview?.tail, '')
  assert.equal(preview?.total, exactly.length)
})

test('long content keeps its BEGINNING AND ITS END, so padding cannot hide what is written last', () => {
  const content = 'A'.repeat(HEAD_CHARS) + 'm'.repeat(10_000) + 'Z'.repeat(TAIL_CHARS)
  const preview = previewOf('Write', { content })
  assert.equal(preview?.head, 'A'.repeat(HEAD_CHARS))
  assert.equal(preview?.tail, 'Z'.repeat(TAIL_CHARS))
  assert.equal(preview?.total, content.length)
  assert.equal(preview?.edits, null)
})

test('the preview is never undefined in any field: it crosses JSON (criterion 23)', () => {
  const preview = previewOf('Write', { content: 'x' })
  assert.deepEqual(JSON.parse(JSON.stringify(preview)), { head: 'x', tail: '', total: 1, edits: null })
})
