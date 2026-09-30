import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionEvent } from '../types.ts'
import { ownerUploadIds, promptOf, refOfLine, refsOf, stripRefs } from './refs.ts'

const ROOT = '/home/me/.factotum/prod/modules/sessions/uploads'
const A = '019a0000-0000-7000-8000-000000000001'
const B = '019a0000-0000-7000-8000-000000000002'
const C = '019a0000-0000-7000-8000-000000000003'
const ref = (id: string, name: string): string => `@${ROOT}/${id}/${name}`

const at = '2026-10-01T00:00:00.000Z'
const said = (role: 'user' | 'assistant', text: string, seq = 0): SessionEvent => ({ seq, at, kind: 'message', role, text })

test('a reference is a whole line, under this root, with a UUIDv7 and a kept name', () => {
  assert.deepEqual(refOfLine(ref(A, 'foto.png'), ROOT), { uploadId: A, name: 'foto.png' })
  assert.deepEqual(refOfLine(`   ${ref(A, 'foto.png')}  `, ROOT), { uploadId: A, name: 'foto.png' })
})

test('not a reference: another root, a bad id, a name sanitizeName would change, a sub-folder, mid-sentence', () => {
  for (const line of [
    `@/tmp/uploads/${A}/x.png`,
    `@${ROOT}/not-a-uuid/x.png`,
    `@${ROOT}/019a0000-0000-4000-8000-000000000001/x.png`,
    `@${ROOT}/${A}/foto 1.png`,
    `@${ROOT}/${A}/sub/x.png`,
    `@${ROOT}/${A}`,
    `look at ${ref(A, 'x.png')}`,
    `${ROOT}/${A}/x.png`,
  ]) {
    assert.equal(refOfLine(line, ROOT), undefined, line)
  }
})

test('refsOf finds one, five and none', () => {
  assert.equal(refsOf(ref(A, 'a.png'), ROOT).length, 1)
  const five = [A, B, C, A, B].map((id, i) => ref(id, `f${i}.png`)).join('\n')
  assert.equal(refsOf(`hola\n\n${five}`, ROOT).length, 5)
  assert.equal(refsOf('nothing attached', ROOT).length, 0)
})

test('ownerUploadIds counts only what the owner sent, once each (criteria 33, 34)', () => {
  const events: SessionEvent[] = [
    said('user', `Mira esto\n\n${ref(A, 'a.png')}\n${ref(A, 'a.png')}`, 0),
    { seq: 1, at, kind: 'tool', name: 'Read', input: { file_path: `${ROOT}/${B}/b.png` } },
    { seq: 2, at, kind: 'result', name: 'Bash', ok: true, summary: `${ROOT}/${B}/b.png\n${ref(B, 'b.png')}` },
    said('assistant', `I also saw\n${ref(C, 'c.png')}`, 3),
    said('user', ref(B, 'second.pdf'), 4),
  ]
  assert.deepEqual(ownerUploadIds(events, ROOT), [A, B])
})

test('stripRefs keeps the words and drops the reference lines and the blanks they leave', () => {
  assert.equal(stripRefs(`Mira esto\n\n${ref(A, 'a.png')}\n${ref(B, 'b.png')}`, ROOT), 'Mira esto')
  assert.equal(stripRefs(ref(A, 'a.png'), ROOT), '')
  assert.equal(stripRefs('no refs\nat all', ROOT), 'no refs\nat all')
})

test('promptOf: the words when there are any, the file names when there are none (criterion 32)', () => {
  assert.equal(promptOf(`Mira esto\n\n${ref(A, 'a.png')}`, ROOT), 'Mira esto')
  assert.equal(promptOf(`${ref(A, 'captura.png')}\n${ref(B, 'informe.pdf')}`, ROOT), 'captura.png, informe.pdf')
  assert.equal(promptOf('', ROOT), '')
})
