import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  expandHome,
  isSiteId,
  parseArchived,
  parseIds,
  parseProjectPatch,
  parseProjectRequest,
  parseQuery,
  parseSharedRequest,
  parseTitle,
} from './requests.ts'

const HOME = '/Users/me'

test('~ and ~/ are the daemon’s home; anything else is left for the schema to judge', () => {
  assert.equal(expandHome('~', HOME), HOME)
  assert.equal(expandHome('~/code/web', HOME), '/Users/me/code/web')
  assert.equal(expandHome('~other/x', HOME), '~other/x')
  assert.equal(expandHome('/abs', HOME), '/abs')
})

test('A PROJECT REQUEST: absolute, no `..`, an id a lock file can carry, a name of 40 at most, one of six colours (criterion 11)', () => {
  assert.deepEqual(parseProjectRequest({ path: '~/web', id: 'web', name: '  Web app  ', color: 3 }, HOME), {
    ok: true,
    value: { path: '/Users/me/web', id: 'web', name: 'Web app', color: 3 },
  })
  assert.deepEqual(parseProjectRequest({ path: '/x', name: '   ' }, HOME), {
    ok: true,
    value: { path: '/x', id: undefined, name: undefined, color: undefined },
  })
  for (const body of [
    { path: 'relative/x' },
    { path: '/a/../b' },
    { path: '/x', id: 'Bad Id' },
    { path: '/x', name: 'n'.repeat(41) },
    { path: '/x', color: 7 },
    {},
    null,
  ]) {
    assert.equal(parseProjectRequest(body, HOME).ok, false, JSON.stringify(body))
  }
  const relative = parseProjectRequest({ path: 'x' }, HOME)
  assert.match(relative.ok ? '' : relative.message, /absolute/)
})

test('a shared request is a path and only a path', () => {
  assert.deepEqual(parseSharedRequest({ path: '~/notes' }, HOME), { ok: true, value: '/Users/me/notes' })
  assert.equal(parseSharedRequest({ path: '../notes' }, HOME).ok, false)
})

test('a patch sets a name and a colour, and empty clears the name', () => {
  assert.deepEqual(parseProjectPatch({ name: ' A ', color: 1 }), { ok: true, value: { name: 'A', color: 1 } })
  assert.deepEqual(parseProjectPatch({ name: '' }), { ok: true, value: { name: undefined, color: undefined } })
  assert.equal(parseProjectPatch({ color: 0 }).ok, false)
})

test('title, archived, ids and the search query', () => {
  assert.deepEqual(parseTitle({ title: 'x' }), { ok: true, value: 'x' })
  assert.equal(parseTitle({ title: 3 }).ok, false)
  assert.deepEqual(parseArchived({ archived: false }), { ok: true, value: false })
  assert.equal(parseIds({ ids: ['a'] }).ok, true)
  assert.equal(parseIds({ ids: [1] }).ok, false)
  assert.deepEqual(parseQuery('  parser '), { ok: true, value: 'parser' })
  assert.equal(parseQuery(' a ').ok, false, 'fewer than two characters (criterion 38)')
  assert.equal(parseQuery(undefined).ok, false)
})

test('a site id in a route passes the site rule or it is not one (criterion 11)', () => {
  assert.equal(isSiteId('proyecto-a'), true)
  for (const bad of [undefined, '', '..', 'A', 'a/b', '-a']) assert.equal(isSiteId(bad), false, String(bad))
})
