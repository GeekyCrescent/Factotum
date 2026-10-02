import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@factotum/core'
import { MAX_LINE_CHARS } from './shape.ts'
import { MAX_OUTPUT_BYTES, openOutput, tail } from './output.ts'

function recorder(): { log: Logger; warnings: string[] } {
  const warnings: string[] = []
  const log = { info: () => undefined, warn: (message: string) => void warnings.push(message), error: () => undefined } as unknown as Logger
  return { log, warnings }
}

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'factotum-output-'))
}

test('the ceiling is one MiB per file', () => {
  assert.equal(MAX_OUTPUT_BYTES, 1_048_576)
})

test('writes land in order, in a file created 0600 inside a directory made for it (criterion 28)', async () => {
  const root = await scratch()
  const path = join(root, 'services', 's1.log')
  const { log } = recorder()
  const out = openOutput(path, log)
  out.write(Buffer.from('one\n'))
  out.write(Buffer.from('two\n'))
  await out.close()
  assert.equal(await readFile(path, 'utf8'), 'one\ntwo\n')
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  await rm(root, { recursive: true })
})

test('flush resolves once everything written so far is on disk', async () => {
  const root = await scratch()
  const path = join(root, 's1.log')
  const out = openOutput(path, recorder().log)
  for (let i = 0; i < 50; i += 1) out.write(Buffer.from(`line ${i}\n`))
  await out.flush()
  assert.equal((await tail(path, 1))[0], 'line 49')
  await out.close()
  await rm(root, { recursive: true })
})

test('past the ceiling it rotates to .1, overwriting the previous one: two files at most (criterion 29)', async () => {
  const root = await scratch()
  const path = join(root, 's1.log')
  const out = openOutput(path, recorder().log, 20)
  out.write(Buffer.from('aaaaaaaaa\n')) // 10
  out.write(Buffer.from('bbbbbbbbb\n')) // 20: still fits
  out.write(Buffer.from('ccccccccc\n')) // over: rotate
  out.write(Buffer.from('ddddddddd\n'))
  out.write(Buffer.from('eeeeeeeee\n')) // over again: .1 is overwritten
  await out.close()
  assert.equal(await readFile(`${path}.1`, 'utf8'), 'ccccccccc\nddddddddd\n')
  assert.equal(await readFile(path, 'utf8'), 'eeeeeeeee\n')
  await assert.rejects(stat(`${path}.2`))
  await rm(root, { recursive: true })
})

test('tail crosses the rotation when the current file has too few lines', async () => {
  const root = await scratch()
  const path = join(root, 's1.log')
  await writeFile(`${path}.1`, 'one\ntwo\nthree\n')
  await writeFile(path, 'four\nfive')
  assert.deepEqual(await tail(path, 4), ['two', 'three', 'four', 'five'])
  assert.deepEqual(await tail(path, 1), ['five'])
  assert.deepEqual(await tail(path, 50), ['one', 'two', 'three', 'four', 'five'])
  await rm(root, { recursive: true })
})

test('tail strips ANSI and clips every line to MAX_LINE_CHARS', async () => {
  const root = await scratch()
  const path = join(root, 's1.log')
  await writeFile(path, `\u001b[31mERROR\u001b[39m: boom\r\n${'x'.repeat(MAX_LINE_CHARS + 10)}\n\u001b]0;title\u0007ok\n`)
  const lines = await tail(path, 10)
  assert.equal(lines[0], 'ERROR: boom')
  assert.equal(lines[1]?.length, MAX_LINE_CHARS)
  assert.equal(lines[2], 'ok')
  await rm(root, { recursive: true })
})

test('tail of a file that does not exist is an empty list, not an error (criterion 41)', async () => {
  assert.deepEqual(await tail('/nonexistent/factotum/s9.log', 50), [])
})

test('a write error is warned ONCE, without the content, and nothing throws; later writes are dropped (criterion 41)', async () => {
  const root = await scratch()
  const dir = join(root, 'services')
  const path = join(dir, 's7.log')
  const { log, warnings } = recorder()
  const out = openOutput(path, log, 16)
  out.write(Buffer.from('SECRET-OUTPUT-1\n'))
  await out.flush()
  // The directory goes while the service is alive: the next rotation cannot rename.
  await rm(dir, { recursive: true })
  out.write(Buffer.from('SECRET-OUTPUT-2\n'))
  out.write(Buffer.from('SECRET-OUTPUT-3\n'))
  out.write(Buffer.from('SECRET-OUTPUT-4\n'))
  await out.flush()
  await out.close()
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /s7/)
  assert.doesNotMatch(warnings[0] ?? '', /SECRET/)
  await rm(root, { recursive: true, force: true })
})

test('a file that cannot even be opened warns once and drops everything', async () => {
  const root = await scratch()
  // A FILE where the directory should be: mkdir fails.
  await writeFile(join(root, 'services'), 'not a directory')
  const { log, warnings } = recorder()
  const out = openOutput(join(root, 'services', 's2.log'), log)
  out.write(Buffer.from('a\n'))
  out.write(Buffer.from('b\n'))
  await out.close()
  assert.equal(warnings.length, 1)
  await rm(root, { recursive: true })
})
