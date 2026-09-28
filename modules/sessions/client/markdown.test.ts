import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blocks, inlines, safeHref, type Block, type Inline } from './markdown.ts'

const text = (value: string): Inline => ({ kind: 'text', value })
const para = (...children: Inline[]): Block => ({ kind: 'para', children })

test('plain text is one paragraph, and a blank line starts another', () => {
  assert.deepEqual(blocks('one\n\ntwo'), [para(text('one')), para(text('two'))])
})

test('a single newline stays inside the paragraph, for the renderer to break on', () => {
  assert.deepEqual(blocks('one\ntwo'), [para(text('one\ntwo'))])
})

test('headings keep their level and drop the closing hashes', () => {
  assert.deepEqual(blocks('# Title\n### Sub ##'), [
    { kind: 'heading', level: 1, children: [text('Title')] },
    { kind: 'heading', level: 3, children: [text('Sub')] },
  ])
})

test('a hash with no space after it is text, not a heading', () => {
  assert.deepEqual(blocks('#hashtag'), [para(text('#hashtag'))])
})

test('a fenced block keeps its text as it is, markup and all, and its language', () => {
  assert.deepEqual(blocks('```ts\nconst a = **1**\n\n  indented\n```\nafter'), [
    { kind: 'code', lang: 'ts', value: 'const a = **1**\n\n  indented' },
    para(text('after')),
  ])
})

test('a fence nobody closed runs to the end instead of losing the text', () => {
  assert.deepEqual(blocks('~~~\nhalf'), [{ kind: 'code', lang: '', value: 'half' }])
})

test('a rule is three dashes, stars or underscores', () => {
  assert.deepEqual(blocks('---\n* * *\n___'), [{ kind: 'rule' }, { kind: 'rule' }, { kind: 'rule' }])
})

test('a quote holds blocks of its own', () => {
  assert.deepEqual(blocks('> # Hi\n> there'), [
    { kind: 'quote', children: [{ kind: 'heading', level: 1, children: [text('Hi')] }, para(text('there'))] },
  ])
})

test('a bullet list, with a continuation line joined to its item', () => {
  assert.deepEqual(blocks('- one\n  still one\n* two'), [
    {
      kind: 'list',
      ordered: false,
      start: 1,
      items: [
        { children: [text('one\nstill one')], sub: undefined },
        { children: [text('two')], sub: undefined },
      ],
    },
  ])
})

test('an ordered list keeps the number it starts at', () => {
  const [list] = blocks('3. three\n4) four')
  assert.equal(list?.kind === 'list' ? list.start : 0, 3)
  assert.equal(list?.kind === 'list' ? list.ordered : false, true)
})

test('an indented item nests under the one before it, and the outer list carries on after', () => {
  const [list] = blocks('1. top\n   - inner a\n   - inner b\n2. next')
  assert.equal(list?.kind, 'list')
  if (list?.kind !== 'list') return
  assert.equal(list.items.length, 2)
  const sub = list.items[0]?.sub
  assert.equal(sub?.ordered, false)
  assert.deepEqual(sub?.items.map((item) => item.children), [[text('inner a')], [text('inner b')]])
})

test('a blank line between items keeps one list; a paragraph after it ends the list', () => {
  const result = blocks('- a\n\n- b\n\nafter')
  assert.deepEqual(result.map((b) => b.kind), ['list', 'para'])
  assert.equal(result[0]?.kind === 'list' ? result[0].items.length : 0, 2)
})

test('bullets then numbers at the same level are two lists, not one', () => {
  const result = blocks('- a\n- b\n\n1. one\n2. two')
  assert.deepEqual(result.map((b) => (b.kind === 'list' ? [b.ordered, b.items.length] : b.kind)), [
    [false, 2],
    [true, 2],
  ])
})

test('a list interrupts a paragraph, and so does a heading', () => {
  assert.deepEqual(blocks('intro\n- a\n# H').map((b) => b.kind), ['para', 'list', 'heading'])
})

test('a table: header, rows, and cells trimmed without their outer pipes', () => {
  assert.deepEqual(blocks('| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 |'), [
    {
      kind: 'table',
      head: [[text('a')], [text('b')]],
      rows: [
        [[text('1')], [text('2')]],
        [[text('3')]],
      ],
    },
  ])
})

test('pipes without a divider under them are just text', () => {
  assert.deepEqual(blocks('a | b'), [para(text('a | b'))])
})

test('Windows line ends parse like the others', () => {
  assert.deepEqual(blocks('one\r\n\r\ntwo'), [para(text('one')), para(text('two'))])
})

test('inline: code, bold, italic, and bold with italic inside', () => {
  assert.deepEqual(inlines('`x` **b** *i* _j_ **a *b***'), [
    { kind: 'code', value: 'x' },
    text(' '),
    { kind: 'strong', children: [text('b')] },
    text(' '),
    { kind: 'em', children: [text('i')] },
    text(' '),
    { kind: 'em', children: [text('j')] },
    text(' '),
    { kind: 'strong', children: [text('a '), { kind: 'em', children: [text('b')] }] },
  ])
})

test('markup inside inline code is not markup', () => {
  assert.deepEqual(inlines('`**no**`'), [{ kind: 'code', value: '**no**' }])
})

test('an underscore inside a word is not italic', () => {
  assert.deepEqual(inlines('snake_case_name'), [text('snake_case_name')])
})

test('a link, and a bare URL, become links; the sentence dot stays outside', () => {
  assert.deepEqual(inlines('[docs](https://a.b/c) and https://x.y/z.'), [
    { kind: 'link', href: 'https://a.b/c', children: [text('docs')] },
    text(' and '),
    { kind: 'link', href: 'https://x.y/z', children: [text('https://x.y/z')] },
    text('.'),
  ])
})

test('a link to anything but http, https or mailto stays as its text', () => {
  assert.deepEqual(inlines('[x](javascript:alert(1))'), [text('x'), text(')')])
  assert.equal(safeHref('javascript:alert(1)'), undefined)
  assert.equal(safeHref('data:text/html,hi'), undefined)
  assert.equal(safeHref('/relative'), undefined)
  assert.equal(safeHref('mailto:a@b.c'), 'mailto:a@b.c')
  assert.equal(safeHref('HTTPS://A.B'), 'HTTPS://A.B')
})

test('an unmatched star is kept as text', () => {
  assert.deepEqual(inlines('2 * 3'), [text('2 * 3')])
})

test('empty input is no blocks', () => {
  assert.deepEqual(blocks(''), [])
  assert.deepEqual(blocks('\n\n'), [])
})
