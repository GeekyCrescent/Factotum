import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendFile, type ServeFileDeps } from './serve-file.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 9])
const GIF = Buffer.from('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000')
const WEBP = Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')
const HTML = Buffer.from('<!doctype html><script>alert(document.cookie)</script>')
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')

/** A server that serves whatever path the test names, from a module directory it owns. */
async function world(deps?: ServeFileDeps) {
  const base = await mkdtemp(join(tmpdir(), 'factotum-serve-'))
  const stateDir = join(base, 'modules', 'probe')
  await mkdir(stateDir, { recursive: true })
  let target = ''
  const server = createServer((_req, res) => void sendFile(res, target, stateDir, deps))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  return {
    base,
    stateDir,
    get: async (path: string) => {
      target = path
      return await fetch(url)
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(base, { recursive: true, force: true })
    },
  }
}

function assertAlways(response: Response): void {
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox")
  assert.equal(response.headers.get('cache-control'), 'no-store')
}

test('the four raster formats are served inline with their type, recognised by their bytes (criterion 8b)', async () => {
  const w = await world()
  try {
    for (const [name, body, type] of [
      ['a.png', PNG, 'image/png'],
      ['b.jpg', JPEG, 'image/jpeg'],
      ['c.gif', GIF, 'image/gif'],
      ['d.webp', WEBP, 'image/webp'],
    ] as const) {
      const path = join(w.stateDir, name)
      await writeFile(path, body)
      const response = await w.get(path)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), type)
      assert.equal(response.headers.get('content-disposition'), null)
      assert.equal(response.headers.get('content-length'), String(body.length))
      assertAlways(response)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), body)
    }
  } finally {
    await w.close()
  }
})

test('HTML, SVG and a PNG that is really HTML are downloads, never painted (criterion 8c, 8d)', async () => {
  const w = await world()
  try {
    for (const [name, body] of [
      ['page.html', HTML],
      ['icon.svg', SVG],
      ['liar.png', HTML],
    ] as const) {
      const path = join(w.stateDir, name)
      await writeFile(path, body)
      const response = await w.get(path)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'application/octet-stream')
      assert.equal(response.headers.get('content-disposition'), 'attachment')
      assertAlways(response)
      await response.arrayBuffer()
    }
  } finally {
    await w.close()
  }
})

test('a relative path, a path outside the module, a folder and a missing file are 404 with no bytes (criterion 8a)', async () => {
  const w = await world()
  try {
    const outside = join(w.base, 'secret.txt')
    await writeFile(outside, 'the config of another module')
    await mkdir(join(w.stateDir, 'folder'))
    for (const path of ['relative.png', outside, join(w.stateDir, '..', 'secret.txt'), join(w.stateDir, 'folder'), join(w.stateDir, 'ghost.png')]) {
      const response = await w.get(path)
      assert.equal(response.status, 404, path)
      assert.match(response.headers.get('content-type') ?? '', /json/)
      assert.doesNotMatch(await response.text(), /another module/)
    }
  } finally {
    await w.close()
  }
})

test('a symlink inside the module that points outside is 404, and so is one to a file inside (criterion 8a)', async () => {
  const w = await world()
  try {
    const outside = join(w.base, 'secret.txt')
    await writeFile(outside, 'secret')
    await symlink(outside, join(w.stateDir, 'out.png'))
    await writeFile(join(w.stateDir, 'real.png'), PNG)
    await symlink(join(w.stateDir, 'real.png'), join(w.stateDir, 'in.png'))
    assert.equal((await w.get(join(w.stateDir, 'out.png'))).status, 404)
    assert.equal((await w.get(join(w.stateDir, 'in.png'))).status, 404)
  } finally {
    await w.close()
  }
})

test('the check is on the OPEN file: one swapped between the open and the check is 404 (criterion 8a)', async () => {
  // `realpath` answers with another file inside the module — as if the name had been swapped after
  // the descriptor was opened. Contained, but not the same inode, so nothing is served.
  let decoy = ''
  const w = await world({ realpath: async (path) => (path.endsWith('opened.png') ? decoy : path) })
  try {
    await writeFile(join(w.stateDir, 'opened.png'), PNG)
    decoy = join(w.stateDir, 'decoy.png')
    await writeFile(decoy, PNG)
    assert.equal((await w.get(join(w.stateDir, 'opened.png'))).status, 404)
  } finally {
    await w.close()
  }
})
