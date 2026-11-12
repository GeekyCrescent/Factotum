import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { expandHome, inside, real, underHome } from './paths.ts'

let dir: string
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'mockups-paths-')))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('~ and ~/ are the home folder; ~user is refused; anything else is left alone', () => {
  assert.equal(expandHome('~', '/Users/me'), '/Users/me')
  assert.equal(expandHome('~/Ferro/BWR/X', '/Users/me'), '/Users/me/Ferro/BWR/X')
  assert.equal(expandHome('~other/x', '/Users/me'), null)
  assert.equal(expandHome('/abs/x', '/Users/me'), '/abs/x')
})

test('real follows links, and for what does not exist yet it is the real parent plus the name', async () => {
  await mkdir(join(dir, 'target'))
  await symlink(join(dir, 'target'), join(dir, 'link'))
  assert.equal(await real(join(dir, 'link')), join(dir, 'target'))
  assert.equal(await real(join(dir, 'link', 'new', 'deeper')), join(dir, 'target', 'new', 'deeper'))
})

test('inside: the same path, or below it — never a sibling that shares a prefix', () => {
  assert.equal(inside('/a/b', '/a/b', false), true)
  assert.equal(inside('/a/b', '/a/b/c', false), true)
  assert.equal(inside('/a/b', '/a/bc', false), false)
  assert.equal(inside('/a/b', '/a', false), false)
})

test('inside compares without case where sessions does (macOS), and with it elsewhere', () => {
  assert.equal(inside('/Users/Me/Work', '/users/me/work/x', true), true)
  assert.equal(inside('/Users/Me/Work', '/users/me/work/x', false), false)
})

test('underHome writes a path below the home folder back with ~/', () => {
  assert.equal(underHome('/Users/me/Ferro/X', '/Users/me'), '~/Ferro/X')
  assert.equal(underHome('/opt/x', '/Users/me'), '/opt/x')
})
