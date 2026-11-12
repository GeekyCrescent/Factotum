import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { kindOf, saveNote, saveUpload } from './inputs.ts'

let root: string
let workDir: string
let incoming: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mockups-inputs-')))
  workDir = join(root, 'Work', 'Acme')
  incoming = join(root, 'state', '.incoming')
  await mkdir(workDir, { recursive: true })
  await mkdir(incoming, { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function part(content: string): Promise<{ path: string; bytes: number }> {
  const path = join(incoming, `${Math.random().toString(16).slice(2)}.part`)
  await writeFile(path, content)
  return { path, bytes: Buffer.byteLength(content) }
}

test('crit. 9: an upload lands in <workDir>/inputs/ with its name, and leaves nothing in .incoming', async () => {
  const saved = await saveUpload({ workDir, file: await part('pdf bytes'), name: 'MTC APP.pdf', isPrivate: false })
  assert.deepEqual(saved, { name: 'MTC APP.pdf', kind: 'pdf', bytes: 9 })
  assert.equal(await readFile(join(workDir, 'inputs', 'MTC APP.pdf'), 'utf8'), 'pdf bytes')
  assert.deepEqual(await readdir(incoming), [])
})

test('crit. 9: a second file with the same name becomes -2, then -3', async () => {
  await saveUpload({ workDir, file: await part('1'), name: 'notas.docx', isPrivate: false })
  const second = await saveUpload({ workDir, file: await part('2'), name: 'notas.docx', isPrivate: false })
  const third = await saveUpload({ workDir, file: await part('3'), name: 'notas.docx', isPrivate: false })
  assert.equal(second.name, 'notas-2.docx')
  assert.equal(third.name, 'notas-3.docx')
  assert.equal(await readFile(join(workDir, 'inputs', 'notas-3.docx'), 'utf8'), '3')
})

test('crit. 10: real client data lands in inputs/private/', async () => {
  const saved = await saveUpload({ workDir, file: await part('rows'), name: 'pacientes.xlsx', isPrivate: true })
  assert.equal(saved.name, 'pacientes.xlsx')
  assert.equal(await readFile(join(workDir, 'inputs', 'private', 'pacientes.xlsx'), 'utf8'), 'rows')
})

test('another disk (EXDEV): copied, then the part removed', async () => {
  const exdev = async () => {
    throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
  }
  const saved = await saveUpload({ workDir, file: await part('far'), name: 'a.zip', isPrivate: false }, { link: exdev })
  assert.equal(saved.name, 'a.zip')
  assert.equal(await readFile(join(workDir, 'inputs', 'a.zip'), 'utf8'), 'far')
  assert.deepEqual(await readdir(incoming), [])
})

test('a failure that is not EEXIST nor EXDEV is thrown, and nothing is half written', async () => {
  const denied = async () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' })
  }
  await assert.rejects(saveUpload({ workDir, file: await part('x'), name: 'a.pdf', isPrivate: false }, { link: denied }), /denied/)
  assert.deepEqual(await readdir(join(workDir, 'inputs')), [])
})

test('crit. 11: a note is inputs/notes-<n>.md, numbered from 1', async () => {
  assert.deepEqual(await saveNote({ workDir, text: 'met them on Monday' }), { name: 'notes-1.md', kind: 'note', bytes: 18 })
  assert.equal((await saveNote({ workDir, text: 'second' })).name, 'notes-2.md')
  assert.equal(await readFile(join(workDir, 'inputs', 'notes-1.md'), 'utf8'), 'met them on Monday\n')
})

test('the kind is the extension in lower case, or file', () => {
  assert.equal(kindOf('A.PDF'), 'pdf')
  assert.equal(kindOf('README'), 'file')
})
