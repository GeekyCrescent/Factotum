import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractTitle } from './extract.ts'

test('the title inside the tag, and nothing else', () => {
  assert.equal(extractTitle('<title>Plan de maratón</title>'), 'Plan de maratón')
})

test('a preamble and a suffix do not get in (criterion 5)', () => {
  assert.equal(extractTitle('Sure!\n<title>Foo bar</title>\nHope it helps'), 'Foo bar')
})

test('no tag is no title, even with plausible text (criterion 4)', () => {
  assert.equal(extractTitle('Here is the title: Foo'), null)
  assert.equal(extractTitle(''), null)
  // What Haiku wrote when asked to read a file with no tools (spec, tasks §M).
  assert.equal(extractTitle('I’ll read the file.\n<function_calls>\n<parameter name="tool">Read</parameter>'), null)
})

test('every spelling of NO TITLE is no title (criterion 4)', () => {
  for (const raw of ['NO TITLE', 'No title.', 'no title…', 'NO TITLE...', ' no  title ', 'Nó títle']) {
    assert.equal(extractTitle(`<title>${raw}</title>`), null, raw)
  }
})

test('an empty tag is no title', () => {
  assert.equal(extractTitle('<title></title>'), null)
  assert.equal(extractTitle('<title>  \n </title>'), null)
  assert.equal(extractTitle('<title>"…"</title>'), null)
})

test('wrapping quotes of every kind, a final period and extra spaces go', () => {
  assert.equal(extractTitle('<title>"Tax return"</title>'), 'Tax return')
  assert.equal(extractTitle("<title>'Tax return'</title>"), 'Tax return')
  assert.equal(extractTitle('<title>«Declaración de impuestos»</title>'), 'Declaración de impuestos')
  assert.equal(extractTitle('<title>“Tax return”</title>'), 'Tax return')
  assert.equal(extractTitle('<title>Tax   return.</title>'), 'Tax return')
  assert.equal(extractTitle('<title>\n  Tax return…\n</title>'), 'Tax return')
})

test('the first tag wins', () => {
  assert.equal(extractTitle('<title>First</title><title>Second</title>'), 'First')
})

test('cut to 80 (criterion 1)', () => {
  const title = extractTitle(`<title>${'word '.repeat(40)}</title>`)
  assert.ok(title !== null && title.length <= 80)
})
