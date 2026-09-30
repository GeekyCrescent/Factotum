import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSanitizedName, sanitizeName, UPLOAD_NAME_MAX } from './name.ts'

const kept = (raw: string): string => {
  const result = sanitizeName(raw)
  assert.ok(result.ok, `${raw} should be kept`)
  return result.name
}

test('a macOS screenshot name loses its spaces and keeps its dots (criterion 12)', () => {
  assert.equal(kept('Captura de pantalla 2026-10-01 a las 9.41.png'), 'Captura-de-pantalla-2026-10-01-a-las-9.41.png')
})

test('accents and emoji are replaced, runs of dashes collapse, and nothing dangles', () => {
  assert.equal(kept('canción.pdf'), 'cancion.pdf')
  assert.equal(kept('Él.png'), 'El.png')
  assert.equal(kept('📸 foto.jpg'), 'foto.jpg')
  assert.equal(kept('foto;rm -rf.png'), 'foto-rm-rf.png')
  assert.equal(kept('informe final .docx'), 'informe-final.docx')
  assert.equal(kept('sin extension'), 'sin-extension')
})

test('a base with no ASCII keeps its extension: the log recognises an image by its name', () => {
  assert.equal(kept('写真.jpg'), 'file.jpg')
  assert.equal(kept('📸.png'), 'file.png')
})

test('sanitising is idempotent: what it keeps, it keeps as it is', () => {
  for (const raw of ['Captura de pantalla 2026-10-01 a las 9.41.png', '写真.jpg', 'canción.pdf', '...secret.txt', `${'a'.repeat(300)}.png`]) {
    const once = kept(raw)
    assert.equal(kept(once), once, raw)
  }
})

test('leading dots go, so an upload is never a hidden file', () => {
  assert.equal(kept('.env'), 'env')
  assert.equal(kept('...secret.txt'), 'secret.txt')
})

test('a long name is cut to 120 keeping its extension; a huge extension is not kept as one', () => {
  const long = kept(`${'a'.repeat(300)}.png`)
  assert.equal(long.length, UPLOAD_NAME_MAX)
  assert.ok(long.endsWith('.png'))
  const weird = kept(`x.${'b'.repeat(200)}`)
  assert.equal(weird.length, UPLOAD_NAME_MAX)
})

test('a separator, dot names, the empty name and nothing-left names are refused (criterion 12)', () => {
  for (const raw of ['../../fuera.png', 'a/b.png', 'a\\b.png', '.', '..', '', '🙂', '....', '---']) {
    assert.equal(sanitizeName(raw).ok, false, JSON.stringify(raw))
  }
})

test('isSanitizedName is true only for what sanitizeName keeps as it is', () => {
  assert.equal(isSanitizedName('foto.jpg'), true)
  assert.equal(isSanitizedName('foto 1.jpg'), false)
  assert.equal(isSanitizedName('..'), false)
  assert.equal(isSanitizedName('.env'), false)
})
