import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Group } from './history.ts'
import {
  addCategory,
  arrange,
  categoryIndexAt,
  dropAt,
  layoutOf,
  moveCategory,
  moveProject,
  newCategoryId,
  placeOf,
  reconcile,
  removeCategory,
  renameCategory,
  sameLayout,
  sectionsOf,
  stepCategory,
  stepProject,
  type Layout,
  type Target,
} from './layout.ts'

const WORK = { id: 'work', name: 'Work' }
const HOME = { id: 'home', name: 'Home' }

/** Work: a, b · Home: c · loose: d, e */
const LAYOUT: Layout = {
  categories: [WORK, HOME],
  order: [
    { id: 'a', category: 'work' },
    { id: 'b', category: 'work' },
    { id: 'c', category: 'home' },
    { id: 'd', category: undefined },
    { id: 'e', category: undefined },
  ],
}

/** The layout as the drawer reads it: `work:a,b home:c -:d,e`. */
function shape(layout: Layout): string {
  return sectionsOf(layout)
    .map((section) => `${section.category ?? '-'}:${section.ids.join(',')}`)
    .join(' ')
}

test('layoutOf keeps the daemon’s order, and a category that names none counts as none', () => {
  const layout = layoutOf(
    [
      { id: 'a', category: 'work' },
      { id: 'b', category: 'ghost' },
      { id: 'c', category: undefined },
    ],
    [WORK],
  )
  assert.equal(shape(layout), 'work:a -:b,c')
})

test('sections: every category in order, empty ones too, and the loose projects LAST', () => {
  assert.equal(shape(LAYOUT), 'work:a,b home:c -:d,e')
  assert.equal(shape({ categories: [WORK], order: [{ id: 'x', category: undefined }] }), 'work: -:x')
})

test('moving a project: within its section, into another, out to loose — and the array follows the screen', () => {
  assert.equal(shape(moveProject(LAYOUT, 'b', { category: 'work', index: 0 })), 'work:b,a home:c -:d,e')
  assert.equal(shape(moveProject(LAYOUT, 'd', { category: 'home', index: 0 })), 'work:a,b home:d,c -:e')
  assert.equal(shape(moveProject(LAYOUT, 'a', { category: undefined, index: 1 })), 'work:b home:c -:d,a,e')
  // An index past the end is the end.
  assert.equal(shape(moveProject(LAYOUT, 'a', { category: 'home', index: 99 })), 'work:b home:c,a -:d,e')
  // The order sent is the order shown: categories first, loose last.
  const moved = moveProject(LAYOUT, 'e', { category: 'work', index: 1 })
  assert.deepEqual(moved.order.map((p) => p.id), ['a', 'e', 'b', 'c', 'd'])
  // Nothing to move, or nowhere to put it: unchanged.
  assert.equal(moveProject(LAYOUT, 'zz', { category: 'work', index: 0 }), LAYOUT)
  assert.equal(moveProject(LAYOUT, 'a', { category: 'ghost', index: 0 }), LAYOUT)
})

test('a step up or down stays in its section, and past its edge crosses to the next one', () => {
  assert.equal(shape(stepProject(LAYOUT, 'b', -1)), 'work:b,a home:c -:d,e')
  assert.equal(shape(stepProject(LAYOUT, 'b', 1)), 'work:a home:b,c -:d,e')
  assert.equal(shape(stepProject(LAYOUT, 'c', 1)), 'work:a,b home: -:c,d,e')
  assert.equal(shape(stepProject(LAYOUT, 'd', -1)), 'work:a,b home:c,d -:e')
  // The very top and the very bottom go nowhere.
  assert.equal(stepProject(LAYOUT, 'a', -1), LAYOUT)
  assert.equal(stepProject(LAYOUT, 'e', 1), LAYOUT)
  assert.equal(stepProject(LAYOUT, 'zz', 1), LAYOUT)
})

test('categories move whole, with their projects, and the array follows', () => {
  const moved = moveCategory(LAYOUT, 'home', 0)
  assert.equal(shape(moved), 'home:c work:a,b -:d,e')
  assert.deepEqual(moved.order.map((p) => p.id), ['c', 'a', 'b', 'd', 'e'])
  assert.equal(shape(stepCategory(LAYOUT, 'work', 1)), 'home:c work:a,b -:d,e')
  assert.equal(shape(stepCategory(LAYOUT, 'work', -1)), 'work:a,b home:c -:d,e')
  assert.equal(moveCategory(LAYOUT, 'ghost', 0), LAYOUT)
  assert.equal(stepCategory(LAYOUT, 'ghost', 1), LAYOUT)
})

test('creating, renaming and deleting a category; deleting one NEVER deletes its projects', () => {
  const added = addCategory(LAYOUT, { id: 'new', name: 'New' })
  assert.equal(shape(added), 'work:a,b home:c new: -:d,e')
  assert.equal(shape(addCategory(LAYOUT, { id: 'new', name: 'New' }, 'd')), 'work:a,b home:c new:d -:e')
  assert.deepEqual(renameCategory(LAYOUT, 'home', 'House').categories, [WORK, { id: 'home', name: 'House' }])

  const removed = removeCategory(LAYOUT, 'work')
  assert.equal(shape(removed), 'home:c -:a,b,d,e')
  assert.deepEqual(removed.categories, [HOME])
  assert.deepEqual([...removed.order.map((p) => p.id)].sort(), ['a', 'b', 'c', 'd', 'e'])
})

test('a layout still being sent is brought in line with the projects there are now', () => {
  const now = reconcile(LAYOUT, ['e', 'a', 'c', 'f'])
  assert.equal(shape(now), 'work:a home:c -:e,f')
})

test('a new category id is in the daemon’s shape and never one already taken', () => {
  const fixed = () => 0.5
  const first = newCategoryId([], fixed)
  assert.match(first, /^[a-z0-9][a-z0-9-]{0,39}$/)
  const second = newCategoryId([{ id: first, name: 'x' }], fixed)
  assert.notEqual(second, first)
  const third = newCategoryId([{ id: first, name: 'x' }, { id: second, name: 'y' }], fixed)
  assert.equal(new Set([first, second, third]).size, 3)
})

// ---------------------------------------------------------------------------
// what the drawer draws
// ---------------------------------------------------------------------------

const group = (key: string, project: string | undefined = undefined): Group => ({
  key,
  label: key,
  entries: [],
  ...(project === undefined ? {} : { project: { id: project, color: undefined, status: 'ok', reason: undefined, hasMore: false } }),
})

test('arrange: Needs you and Running first, then each category with its projects, then the loose ones', () => {
  const groups = [group('needs'), group('running'), ...['e', 'd', 'c', 'b', 'a'].map((id) => group(`project:${id}`, id))]
  const blocks = arrange(groups, LAYOUT, false)
  const read = blocks.map((block) => (block.kind === 'group' ? block.group.key : `[${block.category.name}: ${block.groups.map((g) => g.key).join(' ')}]`))
  assert.deepEqual(read, ['needs', 'running', '[Work: project:a project:b]', '[Home: project:c]', 'project:d', 'project:e'])
})

test('arrange: an empty category stays, to be dropped into — unless searching, when it has no match', () => {
  const groups = [group('project:a', 'a'), group('project:d', 'd')]
  const blocks = (searching: boolean) =>
    arrange(groups, LAYOUT, searching).map((block) => (block.kind === 'group' ? block.group.key : `[${block.category.name}]`))
  assert.deepEqual(blocks(false), ['[Work]', '[Home]', 'project:d'])
  assert.deepEqual(blocks(true), ['[Work]', 'project:d'])
})

// ---------------------------------------------------------------------------
// where a drag lands
// ---------------------------------------------------------------------------

const TARGETS: readonly Target[] = [
  { kind: 'category', id: 'work', top: 0, bottom: 20 },
  { kind: 'project', id: 'a', top: 20, bottom: 60 },
  { kind: 'project', id: 'b', top: 60, bottom: 100 },
  { kind: 'category', id: 'home', top: 110, bottom: 130 },
  { kind: 'loose', top: 200, bottom: 240 },
]

test('dropAt: a project splits at its middle; a header is into its category; the strip is loose', () => {
  assert.deepEqual(dropAt(TARGETS, 30, 'x'), { kind: 'before', id: 'a' })
  assert.deepEqual(dropAt(TARGETS, 50, 'x'), { kind: 'after', id: 'a' })
  assert.deepEqual(dropAt(TARGETS, 10, 'x'), { kind: 'into', category: 'work' })
  assert.deepEqual(dropAt(TARGETS, 220, 'x'), { kind: 'into', category: undefined })
  // In a gap, the nearest; past everything, the last.
  assert.deepEqual(dropAt(TARGETS, 107, 'x'), { kind: 'into', category: 'home' })
  assert.deepEqual(dropAt(TARGETS, 900, 'x'), { kind: 'into', category: undefined })
  // The dragged project is not a target of itself.
  assert.deepEqual(dropAt(TARGETS, 30, 'a'), { kind: 'into', category: 'work' })
  assert.equal(dropAt([], 30, 'a'), undefined)
})

test('placeOf counts the index once the dragged project has left', () => {
  assert.deepEqual(placeOf(LAYOUT, 'a', { kind: 'after', id: 'b' }), { category: 'work', index: 1 })
  assert.deepEqual(placeOf(LAYOUT, 'e', { kind: 'before', id: 'a' }), { category: 'work', index: 0 })
  assert.deepEqual(placeOf(LAYOUT, 'a', { kind: 'into', category: 'home' }), { category: 'home', index: 1 })
  assert.deepEqual(placeOf(LAYOUT, 'a', { kind: 'into', category: undefined }), { category: undefined, index: 2 })
  assert.equal(placeOf(LAYOUT, 'a', { kind: 'into', category: 'ghost' }), undefined)
  assert.equal(placeOf(LAYOUT, 'a', { kind: 'before', id: 'ghost' }), undefined)
})

test('categoryIndexAt: before the first middle below the pointer, else last', () => {
  assert.equal(categoryIndexAt([50, 150], 10), 0)
  assert.equal(categoryIndexAt([50, 150], 100), 1)
  assert.equal(categoryIndexAt([50, 150], 400), 2)
})

test('sameLayout tells a drop where it started from a real move', () => {
  assert.equal(sameLayout(LAYOUT, { ...LAYOUT }), true)
  assert.equal(sameLayout(LAYOUT, moveProject(LAYOUT, 'a', { category: 'work', index: 0 })), true)
  assert.equal(sameLayout(LAYOUT, moveProject(LAYOUT, 'b', { category: 'work', index: 0 })), false)
  assert.equal(sameLayout(LAYOUT, renameCategory(LAYOUT, 'work', 'Job')), false)
  assert.equal(sameLayout(LAYOUT, addCategory(LAYOUT, { id: 'n', name: 'N' })), false)
})
