import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sectionsOf, splitSections } from './markdown.ts'

test('a "## " heading that is not "## N. Title" is reported with how many non-blank lines it took', () => {
  const markdown = ['# Title', '', '## 1. One', 'a', '', '## Appendix', 'b', '', 'c', '## 2. Two', 'd'].join('\n')
  const { sections, unparsed } = splitSections(markdown)
  assert.deepEqual(
    sections.map((s) => [s.n, s.title]),
    [
      [1, 'One'],
      [2, 'Two'],
    ],
  )
  assert.deepEqual(unparsed, [{ heading: 'Appendix', lines: 2 }])
  assert.deepEqual(sectionsOf(markdown), sections)
})

test('a document with only numbered sections has nothing unparsed', () => {
  assert.deepEqual(splitSections('## 1. One\na\n## 2. Two\nb').unparsed, [])
})
