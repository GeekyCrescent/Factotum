import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPassword } from './secrets.ts'

const SECRET = 'abcd efgh ijkl mnop\n'

async function file(content: string, mode = 0o600): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'factotum-inbox-secret-'))
  const path = join(dir, 'gmail-personal')
  await writeFile(path, content)
  await chmod(path, mode)
  return path
}

function assertRefused(result: Awaited<ReturnType<typeof readPassword>>, pattern: RegExp): void {
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.reason, pattern)
  // Criterion 2: never the content, not even a piece of it.
  for (const piece of ['abcd', 'efgh', 'ijkl', 'mnop']) assert.equal(result.reason.includes(piece), false)
}

test('the four groups and the trailing newline become one sixteen-letter password', async () => {
  assert.deepEqual(await readPassword(await file(SECRET)), { ok: true, password: 'abcdefghijklmnop' })
  assert.deepEqual(await readPassword(await file(SECRET, 0o400)), { ok: true, password: 'abcdefghijklmnop' })
})

test('a file readable by the group or others is refused, without its content', async () => {
  assertRefused(await readPassword(await file(SECRET, 0o644)), /readable by others \(mode 644\)/)
  assertRefused(await readPassword(await file(SECRET, 0o640)), /readable by others/)
})

test('a symbolic link is refused even when its target is 0600', async () => {
  const target = await file(SECRET)
  const link = `${target}-link`
  await symlink(target, link)
  assertRefused(await readPassword(link), /symbolic link/)
})

test('an empty file, or one with only blanks, is refused', async () => {
  assertRefused(await readPassword(await file('')), /empty/)
  assertRefused(await readPassword(await file('  \n')), /empty/)
})

test('a missing file, a directory and an oversized file are refused with what is wrong', async () => {
  assertRefused(await readPassword('/nonexistent/factotum/secret'), /unreadable \(ENOENT\)/)
  const dir = await mkdtemp(join(tmpdir(), 'factotum-inbox-secret-dir-'))
  await mkdir(join(dir, 'd'), { mode: 0o700 })
  assertRefused(await readPassword(join(dir, 'd')), /not a regular file/)
  assertRefused(await readPassword(await file(`abcd${'x'.repeat(2000)}`)), /larger than 1 KiB/)
})
