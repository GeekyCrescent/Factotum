import { test } from 'node:test'
import assert from 'node:assert/strict'
import { choiceGroupsOf, firstChoice, type ChoiceSite, type Scope } from './project-choice.ts'

const site = (id: string, name?: string): ChoiceSite => ({ id, path: `/Users/me/code/${id}`, name, color: undefined })

const SITES = [site('factotum', 'Factotum'), site('jarvis', 'Jarvis'), site('angeles', 'Ángeles'), site('vault'), site('nuevo')]

/** Work: angeles · Personal: factotum, jarvis · loose: vault. `nuevo` is not in the arrangement yet. */
const ARRANGEMENT = {
  categories: [
    { id: 'work', name: 'BWR' },
    { id: 'personal', name: 'Personal' },
    { id: 'empty', name: 'Empty' },
  ],
  projects: [
    { id: 'factotum', category: 'personal' },
    { id: 'angeles', category: 'work' },
    { id: 'jarvis', category: 'personal' },
    { id: 'vault', category: undefined },
  ],
}

const ALL: Scope = { kind: 'all' }
const ids = (groups: ReturnType<typeof choiceGroupsOf>) => groups.map((g) => [g.category?.id, g.sites.map((s) => s.id)])

test('groups the sites by the owner\'s categories, in their order, with the loose ones last', () => {
  // Act
  const groups = choiceGroupsOf(SITES, ARRANGEMENT, '', ALL)

  // Assert
  assert.deepEqual(ids(groups), [
    ['work', ['angeles']],
    ['personal', ['factotum', 'jarvis']],
    [undefined, ['vault', 'nuevo']],
  ])
})

test('a site the arrangement does not know yet is loose, at the end', () => {
  const groups = choiceGroupsOf(SITES, ARRANGEMENT, '', ALL)
  assert.equal(groups.at(-1)?.sites.at(-1)?.id, 'nuevo')
})

test('an arrangement entry with no launchable site is dropped, not shown empty', () => {
  const groups = choiceGroupsOf([site('vault')], ARRANGEMENT, '', ALL)
  assert.deepEqual(ids(groups), [[undefined, ['vault']]])
})

test('with no arrangement (GET projects failed or not here yet) it is one flat group', () => {
  const groups = choiceGroupsOf(SITES, undefined, '', ALL)
  assert.deepEqual(ids(groups), [[undefined, ['factotum', 'jarvis', 'angeles', 'vault', 'nuevo']]])
})

test('a category that names no category counts as none', () => {
  const groups = choiceGroupsOf([site('x')], { categories: [], projects: [{ id: 'x', category: 'gone' }] }, '', ALL)
  assert.deepEqual(ids(groups), [[undefined, ['x']]])
})

test('the search matches the name ignoring case and accents', () => {
  assert.deepEqual(ids(choiceGroupsOf(SITES, ARRANGEMENT, 'ANGE', ALL)), [['work', ['angeles']]])
  assert.deepEqual(ids(choiceGroupsOf(SITES, ARRANGEMENT, 'ángel', ALL)), [['work', ['angeles']]])
})

test('the search matches the id and the folder when there is no name', () => {
  assert.deepEqual(ids(choiceGroupsOf(SITES, ARRANGEMENT, 'vau', ALL)), [[undefined, ['vault']]])
  assert.deepEqual(ids(choiceGroupsOf(SITES, ARRANGEMENT, 'code/jar', ALL)), [['personal', ['jarvis']]])
})

test('searching for a category\'s name lists every project in it', () => {
  assert.deepEqual(ids(choiceGroupsOf(SITES, ARRANGEMENT, 'person', ALL)), [['personal', ['factotum', 'jarvis']]])
})

test('every word of the search has to match, in any order', () => {
  assert.deepEqual(ids(choiceGroupsOf(SITES, ARRANGEMENT, 'personal jar', ALL)), [['personal', ['jarvis']]])
  assert.deepEqual(ids(choiceGroupsOf(SITES, ARRANGEMENT, 'jar zzz', ALL)), [])
})

test('a scope keeps one category, or only the loose ones', () => {
  assert.deepEqual(ids(choiceGroupsOf(SITES, ARRANGEMENT, '', { kind: 'category', id: 'personal' })), [['personal', ['factotum', 'jarvis']]])
  assert.deepEqual(ids(choiceGroupsOf(SITES, ARRANGEMENT, '', { kind: 'loose' })), [[undefined, ['vault', 'nuevo']]])
})

test('scope and search together', () => {
  assert.deepEqual(ids(choiceGroupsOf(SITES, ARRANGEMENT, 'fac', { kind: 'category', id: 'personal' })), [['personal', ['factotum']]])
  assert.deepEqual(ids(choiceGroupsOf(SITES, ARRANGEMENT, 'fac', { kind: 'category', id: 'work' })), [])
})

test('firstChoice is the first site shown, or none', () => {
  assert.equal(firstChoice(choiceGroupsOf(SITES, ARRANGEMENT, '', ALL))?.id, 'angeles')
  assert.equal(firstChoice([]), undefined)
})
