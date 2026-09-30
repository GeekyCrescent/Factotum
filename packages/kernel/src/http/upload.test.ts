import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReceivedFile } from '@factotum/core'
import { incomingDir } from '../config/paths.ts'
import { readUploadBody } from './upload.ts'

const MAX = 64 * 1024

/** A bare server whose only route is `readUploadBody`, reporting what it received. */
async function world() {
  const stateDir = await mkdtemp(join(tmpdir(), 'factotum-upload-'))
  const received: (ReceivedFile | undefined)[] = []
  let settle: () => void = () => undefined
  const settled = new Promise<void>((resolve) => (settle = resolve))
  const server: Server = createServer((req, res) => {
    void readUploadBody(req, res, stateDir, MAX).then((file) => {
      received.push(file)
      if (file !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(file))
      }
      settle()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const incoming = async (): Promise<readonly string[]> => {
    try {
      return await readdir(incomingDir(stateDir))
    } catch {
      return []
    }
  }
  return {
    port,
    stateDir,
    received,
    settled,
    incoming,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(stateDir, { recursive: true, force: true })
    },
  }
}

/** Status, or `'cut'` when the connection ended before an answer: both are acceptable refusals. */
async function post(port: number, body: Buffer, chunked: boolean): Promise<number | 'cut'> {
  return await new Promise((resolve) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/up',
        headers: chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': String(body.length) },
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on('error', () => resolve('cut'))
    req.end(body)
  })
}

const bytes = (n: number, fill = 0x61): Buffer => Buffer.alloc(n, fill)

test('a complete upload with a length lands whole in .incoming/ (criterion 5d)', async () => {
  const w = await world()
  try {
    const body = bytes(MAX - 1, 0x62)
    assert.equal(await post(w.port, body, false), 200)
    const file = w.received[0]
    assert.ok(file !== undefined)
    assert.equal(file.bytes, body.length)
    assert.ok(file.path.startsWith(incomingDir(w.stateDir)))
    assert.deepEqual(await readFile(file.path), body)
  } finally {
    await w.close()
  }
})

test('a complete chunked upload lands whole too: a length is never required (criterion 5d)', async () => {
  const w = await world()
  try {
    assert.equal(await post(w.port, bytes(MAX), true), 200)
    assert.equal(w.received[0]?.bytes, MAX)
  } finally {
    await w.close()
  }
})

test('a declared length over the ceiling is refused before anything is written (criterion 5a)', async () => {
  const w = await world()
  try {
    const status = await post(w.port, bytes(MAX + 1), false)
    assert.ok(status === 413 || status === 'cut', `got ${status}`)
    await w.settled
    assert.equal(w.received[0], undefined)
    assert.deepEqual(await w.incoming(), [], 'not even the directory gets a file')
  } finally {
    await w.close()
  }
})

test('a chunked body that passes the ceiling is refused and its temporary file removed (criterion 5b)', async () => {
  const w = await world()
  try {
    const status = await post(w.port, bytes(MAX * 4), true)
    assert.ok(status === 413 || status === 'cut', `got ${status}`)
    await w.settled
    assert.equal(w.received[0], undefined)
    assert.deepEqual(await w.incoming(), [])
  } finally {
    await w.close()
  }
})

test('an upload cut halfway leaves nothing behind, not even the temporary file (criterion 5c)', async () => {
  const w = await world()
  try {
    await new Promise<void>((resolve) => {
      const socket = connect(w.port, '127.0.0.1', () => {
        socket.write(`POST /up HTTP/1.1\r\nhost: x\r\ncontent-length: ${MAX}\r\n\r\n`)
        socket.write(bytes(MAX / 2))
        setTimeout(() => {
          socket.destroy()
          resolve()
        }, 50)
      })
    })
    await w.settled
    assert.equal(w.received[0], undefined)
    assert.deepEqual(await w.incoming(), [])
  } finally {
    await w.close()
  }
})
