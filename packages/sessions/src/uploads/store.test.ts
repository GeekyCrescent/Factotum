import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@factotum/core'
import { createUploadStore } from './store.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1])

function quietLog(): Logger & { readonly warnings: string[] } {
  const warnings: string[] = []
  return { warnings, info: () => undefined, warn: (message) => void warnings.push(message), error: () => undefined }
}

/** A module state directory with `.incoming/` and `uploads/` side by side, as the kernel lays it out. */
async function world(rootName = 'uploads') {
  const stateDir = await mkdtemp(join(tmpdir(), 'factotum-uploads-'))
  const incoming = join(stateDir, '.incoming')
  await mkdir(incoming, { recursive: true })
  const log = quietLog()
  const make = () => createUploadStore({ root: join(stateDir, rootName), maxBytes: 20 * 1024 * 1024, now: () => new Date(), log })
  let n = 0
  const received = async (body: Buffer) => {
    const path = join(incoming, `${(n += 1)}.part`)
    await writeFile(path, body)
    return { path, bytes: body.length }
  }
  return { stateDir, incoming, log, make, received, close: () => rm(stateDir, { recursive: true, force: true }) }
}

test('adopt moves the received file under uploads/<uuidv7>/<sanitised name>, and says if it is a picture', async () => {
  const w = await world()
  try {
    const uploads = w.make()
    const result = await uploads.adopt(await w.received(PNG), 'Captura de pantalla.png')
    assert.equal(result.outcome, 'ok')
    if (result.outcome !== 'ok') return
    assert.match(result.uploadId, /^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    assert.equal(result.name, 'Captura-de-pantalla.png')
    assert.equal(result.path, join(uploads.root, result.uploadId, result.name))
    assert.equal(result.image, true)
    assert.equal(result.bytes, PNG.length)
    assert.deepEqual(await readFile(result.path), PNG)
    assert.deepEqual(await readdir(w.incoming), [], 'the received file was moved, not copied')

    const doc = await uploads.adopt(await w.received(Buffer.from('%PDF-1.7 ...')), 'informe.pdf')
    assert.equal(doc.outcome === 'ok' && doc.image, false)
  } finally {
    await w.close()
  }
})

test('a name that cannot be kept is refused and nothing is made under uploads/ (criterion 12)', async () => {
  const w = await world()
  try {
    const uploads = w.make()
    const result = await uploads.adopt(await w.received(PNG), '../../fuera.png')
    assert.equal(result.outcome, 'invalid')
    await assert.rejects(stat(uploads.root), { code: 'ENOENT' })
  } finally {
    await w.close()
  }
})

test('an upload is still found after the daemon restarts: a second store over the same folder (criterion 11)', async () => {
  const w = await world()
  try {
    const first = await w.make().adopt(await w.received(PNG), 'foto.png')
    assert.equal(first.outcome, 'ok')
    if (first.outcome !== 'ok') return
    const again = w.make()
    const found = again.locate(first.uploadId, first.name)
    assert.deepEqual(found, { kind: 'ok', path: first.path })
    assert.deepEqual(await readFile(first.path), PNG)
  } finally {
    await w.close()
  }
})

test('locate checks the form only: a bad id or a name sanitizeName would change is invalid (criterion 13)', async () => {
  const w = await world()
  try {
    const uploads = w.make()
    const id = '019a0000-0000-7000-8000-000000000001'
    assert.equal(uploads.locate(id, 'foto.png').kind, 'ok')
    for (const [uploadId, name] of [
      ['..', 'foto.png'],
      ['019a0000-0000-4000-8000-000000000001', 'foto.png'],
      [id, 'foto 1.png'],
      [id, '..'],
      [id, '.env'],
    ] as const) {
      assert.deepEqual(uploads.locate(uploadId, name), { kind: 'invalid' }, `${uploadId}/${name}`)
    }
  } finally {
    await w.close()
  }
})

test('forget deletes the named uploads and nothing else, and never throws', async () => {
  const w = await world()
  try {
    const uploads = w.make()
    const a = await uploads.adopt(await w.received(PNG), 'a.png')
    const b = await uploads.adopt(await w.received(PNG), 'b.png')
    assert.ok(a.outcome === 'ok' && b.outcome === 'ok')
    if (a.outcome !== 'ok' || b.outcome !== 'ok') return

    await uploads.forget([a.uploadId, 'not-an-id', '019a0000-0000-7000-8000-00000000dead'])
    await assert.rejects(stat(join(uploads.root, a.uploadId)), { code: 'ENOENT' })
    assert.deepEqual(await readFile(b.path), PNG)
    assert.deepEqual(w.log.warnings, [])
  } finally {
    await w.close()
  }
})

test('forget unlinks a symlink in an upload’s place without following it', async () => {
  const w = await world()
  try {
    const uploads = w.make()
    await mkdir(uploads.root, { recursive: true })
    const precious = join(w.stateDir, 'precious')
    await mkdir(precious)
    await writeFile(join(precious, 'keep.txt'), 'keep')
    const id = '019a0000-0000-7000-8000-000000000009'
    await symlink(precious, join(uploads.root, id))

    await uploads.forget([id])
    await assert.rejects(stat(join(uploads.root, id)), { code: 'ENOENT' })
    assert.equal(await readFile(join(precious, 'keep.txt'), 'utf8'), 'keep')
  } finally {
    await w.close()
  }
})

test('a root a reference cannot carry turns uploads off, with the reason, and adopt says so (D8)', async () => {
  const w = await world('up loads')
  try {
    const uploads = w.make()
    assert.ok('off' in uploads.view)
    assert.match(w.log.warnings[0] ?? '', /uploads are off/)
    const result = await uploads.adopt(await w.received(PNG), 'a.png')
    assert.equal(result.outcome, 'off')
  } finally {
    await w.close()
  }
})

test('a normal root reports its ceiling', async () => {
  const w = await world()
  try {
    assert.deepEqual(w.make().view, { maxBytes: 20 * 1024 * 1024 })
  } finally {
    await w.close()
  }
})
