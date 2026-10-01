import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  completion,
  filesOf,
  hasPlainExtension,
  inlineRefs,
  latest,
  pickerErrorText,
  refText,
  requestOf,
  tabOf,
  tokenAt,
  tokenText,
  type InlinePiece,
} from './refs.ts'
import type { Listing, ListingEntry } from '../types.ts'

const SITE = '/Users/me/work'
const SHARED = '/Users/me/notes vault'
const atRoot: Pick<Listing, 'root' | 'dir'> = { root: { kind: 'site', path: SITE }, dir: SITE }
const inDocs: Pick<Listing, 'root' | 'dir'> = { root: { kind: 'site', path: SITE }, dir: `${SITE}/docs` }
const inShared: Pick<Listing, 'root' | 'dir'> = { root: { kind: 'shared', path: SHARED }, dir: `${SHARED}/inbox` }
const file = (name: string): ListingEntry => ({ name, kind: 'file' })
const dir = (name: string): ListingEntry => ({ name, kind: 'dir' })

/** The text with `|` where the caret is. */
function at(marked: string) {
  const caret = marked.indexOf('|')
  return tokenAt(marked.replace('|', ''), caret)
}

// ---------------------------------------------------------------------------
// filesOf (criterion 17)
// ---------------------------------------------------------------------------

test('a setup without files is a host from before references', () => {
  assert.deepEqual(filesOf({ sites: [] }), { kind: 'old' })
  assert.deepEqual(filesOf(undefined), { kind: 'old' })
  assert.deepEqual(filesOf({ files: { maxEntries: 0 } }), { kind: 'old' })
  assert.deepEqual(filesOf({ files: { maxEntries: 200 } }), { kind: 'on', maxEntries: 200 })
})

// ---------------------------------------------------------------------------
// tokenAt (criteria 18, 20)
// ---------------------------------------------------------------------------

test('an @ at the start, after a space or after a new line opens a token', () => {
  assert.deepEqual(at('@|'), { start: 0, end: 1, quoted: false, query: '' })
  assert.deepEqual(at('look at @src/ap|'), { start: 8, end: 15, quoted: false, query: 'src/ap' })
  assert.deepEqual(at('one\n@do|'), { start: 4, end: 7, quoted: false, query: 'do' })
  assert.deepEqual(at('tab\t@x|'), { start: 4, end: 6, quoted: false, query: 'x' })
})

test('an @ inside a word, or no @ at all, opens nothing', () => {
  assert.equal(at('mail a@b.co|'), undefined)
  assert.equal(at('plain text|'), undefined)
  assert.equal(at('@src done|'), undefined)
})

test('unquoted, the token ends where its run ends, so a replace takes it whole', () => {
  assert.deepEqual(at('see @sr|c/app.ts now'), { start: 4, end: 15, quoted: false, query: 'sr' })
})

test('quoted, the token takes spaces and ends AT THE CARET, never beyond', () => {
  assert.deepEqual(at('@"00 inbox/Po|'), { start: 0, end: 13, quoted: true, query: '00 inbox/Po' })
  // Scenario B of the v2 audit: what follows the caret is never the token's.
  assert.deepEqual(at('Fix @"Por| the bug'), { start: 4, end: 9, quoted: true, query: 'Por' })
})

test('a closed quote is a finished reference, not a token', () => {
  assert.equal(at('@"mi nota.md" and |'), undefined)
  assert.equal(at('@"mi nota.md"|'), undefined)
  // The caret moving THROUGH a finished reference does not reopen it.
  assert.equal(at('@"mi nota|.md" más'), undefined)
  // Between the `@` and its quote, there is no token to replace.
  assert.equal(at('@|"x y"'), undefined)
})

// ---------------------------------------------------------------------------
// requestOf
// ---------------------------------------------------------------------------

test('a query becomes the folder to list and the prefix', () => {
  assert.deepEqual(requestOf('', SITE), { dir: undefined, prefix: '' })
  assert.deepEqual(requestOf('RE', SITE), { dir: undefined, prefix: 'RE' })
  assert.deepEqual(requestOf('src/co', SITE), { dir: `${SITE}/src`, prefix: 'co' })
  assert.deepEqual(requestOf('src/components/', SITE), { dir: `${SITE}/src/components`, prefix: '' })
  assert.deepEqual(requestOf(`${SHARED}/inbox/x`, SITE), { dir: `${SHARED}/inbox`, prefix: 'x' })
})

test('a query the module would refuse asks for nothing', () => {
  for (const query of ['../etc/x', 'src/../x', './x', 'src//x', '/x', '/']) {
    assert.equal(requestOf(query, SITE), undefined, query)
  }
})

// ---------------------------------------------------------------------------
// hasPlainExtension, refText (criterion 23)
// ---------------------------------------------------------------------------

test('a plain extension is a dot and one to eight letters or digits, after a name', () => {
  for (const name of ['app.ts', 'README.md', 'a.b.c', 'photo.JPEG', 'x.tar.gz']) assert.equal(hasPlainExtension(name), true, name)
  for (const name of ['Makefile', '.gitignore', '.env', 'x.code-workspace', 'site.webmanifest', 'a.']) {
    assert.equal(hasPlainExtension(name), false, name)
  }
})

test('what is inserted: relative in the site, absolute in a shared folder, folders with a slash', () => {
  assert.equal(refText(atRoot, file('README.md')), '@README.md')
  assert.equal(refText(inDocs, file('a.md')), '@docs/a.md')
  assert.equal(refText(inDocs, dir('sub')), '@docs/sub/')
  assert.equal(refText(inDocs, { kind: 'this-dir' }), '@docs/')
  assert.equal(refText(atRoot, { kind: 'this-dir' }), undefined)
  assert.equal(refText(atRoot, { kind: 'shared', path: '/Users/me/shared' }), '@/Users/me/shared/')
})

test('spaces, and files without a plain extension, go in quotes', () => {
  assert.equal(refText(inDocs, file('mi nota.md')), '@"docs/mi nota.md"')
  assert.equal(refText(inShared, file('c.md')), `@"${SHARED}/inbox/c.md"`)
  assert.equal(refText(atRoot, file('Makefile')), '@"Makefile"')
  assert.equal(refText(atRoot, file('.gitignore')), '@".gitignore"')
  assert.equal(refText(atRoot, file('.env')), '@".env"')
})

test('a name with a quote or a line break cannot be referenced', () => {
  assert.equal(refText(atRoot, file('di "hola".md')), undefined)
  assert.equal(refText(atRoot, file('two\nlines.md')), undefined)
  assert.equal(refText(atRoot, file('cr\r.md')), undefined)
})

// ---------------------------------------------------------------------------
// completion, tokenText (criterion 20)
// ---------------------------------------------------------------------------

test('Tab on one file inserts it; on one folder enters it', () => {
  assert.deepEqual(completion('Por', [file('Por hacer.md')]), { kind: 'insert', entry: file('Por hacer.md') })
  assert.deepEqual(completion('sr', [dir('src')]), { kind: 'enter', name: 'src' })
})

test('Tab on several extends to the longer common prefix, ignoring case, or does nothing', () => {
  assert.equal(completion('co', [dir('components'), file('Config.ts'), file('constants.ts')]), undefined)
  assert.deepEqual(completion('c', [dir('components'), file('compose.ts')]), { kind: 'extend', text: 'compo' })
  assert.deepEqual(completion('', [file('Mi nota.md'), file('mi otra.md')]), { kind: 'extend', text: 'Mi ' })
  assert.equal(completion('x', []), undefined)
  assert.equal(completion('zz', [file('app.ts')]), undefined)
})

test('a token rewritten while navigating opens a quote when it needs one, and keeps it', () => {
  assert.equal(tokenText('00-inbox/', false), '@00-inbox/')
  assert.equal(tokenText('00 inbox/', false), '@"00 inbox/')
  assert.equal(tokenText('00 inbox/sub/', true), '@"00 inbox/sub/')
  assert.equal(tokenText('Mi ', false), '@"Mi ')
  // What it writes, tokenAt reads back as one token with the caret at its end.
  const text = tokenText('00 inbox/sub/', true)
  assert.deepEqual(tokenAt(text, text.length), { start: 0, end: text.length, quoted: true, query: '00 inbox/sub/' })
})

// ---------------------------------------------------------------------------
// inlineRefs (criterion 29)
// ---------------------------------------------------------------------------

const refs = (text: string) => inlineRefs(text).filter((piece): piece is Extract<InlinePiece, { kind: 'ref' }> => piece.kind === 'ref')

test('the references the list writes are read back as references', () => {
  assert.deepEqual(refs('Look at @src/app.ts please'), [{ kind: 'ref', raw: '@src/app.ts', name: 'app.ts', dir: false }])
  assert.deepEqual(refs('@README.md'), [{ kind: 'ref', raw: '@README.md', name: 'README.md', dir: false }])
  assert.deepEqual(refs('in @docs/ there'), [{ kind: 'ref', raw: '@docs/', name: 'docs', dir: true }])
  assert.deepEqual(refs('read @"docs/mi nota.md" now'), [{ kind: 'ref', raw: '@"docs/mi nota.md"', name: 'mi nota.md', dir: false }])
  assert.deepEqual(refs('and @"Makefile"'), [{ kind: 'ref', raw: '@"Makefile"', name: 'Makefile', dir: false }])
  assert.deepEqual(refs('@/Users/me/x.md'), [{ kind: 'ref', raw: '@/Users/me/x.md', name: 'x.md', dir: false }])
  assert.deepEqual(refs('one\n@src/b.ts'), [{ kind: 'ref', raw: '@src/b.ts', name: 'b.ts', dir: false }])
})

test('punctuation after a reference stays text', () => {
  const pieces = inlineRefs('Read @src/app.ts, then @docs/.')
  assert.deepEqual(pieces, [
    { kind: 'text', text: 'Read ' },
    { kind: 'ref', raw: '@src/app.ts', name: 'app.ts', dir: false },
    { kind: 'text', text: ', then ' },
    { kind: 'ref', raw: '@docs/', name: 'docs', dir: true },
    { kind: 'text', text: '.' },
  ])
})

test('what is not a reference stays text', () => {
  for (const text of ['a@b.com', '@usuario', '@', '@@x', 'use @factotum/core', '@types/node', '@usuario/repo', '@"open quote']) {
    assert.deepEqual(inlineRefs(text), [{ kind: 'text', text }], text)
  }
  assert.deepEqual(inlineRefs(''), [])
})

test('everything refText writes is read back as a reference', () => {
  const written = [
    refText(atRoot, file('README.md')),
    refText(inDocs, file('a.md')),
    refText(inDocs, dir('sub')),
    refText(inDocs, { kind: 'this-dir' }),
    refText(atRoot, { kind: 'shared', path: '/Users/me/shared' }),
    refText(inDocs, file('mi nota.md')),
    refText(inShared, file('c.md')),
    refText(atRoot, file('Makefile')),
    refText(atRoot, file('.gitignore')),
    refText(atRoot, file('.env')),
  ]
  for (const ref of written) {
    assert.notEqual(ref, undefined)
    assert.deepEqual(refs(`see ${ref as string} please`).map((piece) => piece.raw), [ref], ref)
  }
})

// ---------------------------------------------------------------------------
// latest, pickerErrorText (criteria 25, 26)
// ---------------------------------------------------------------------------

test('only the latest request counts', () => {
  const order = latest()
  const first = order.next()
  const second = order.next()
  assert.equal(order.isLatest(first), false)
  assert.equal(order.isLatest(second), true)
})

test('a failed listing says what happened in one line', () => {
  assert.equal(pickerErrorText({ status: 409, body: { missing: { siteId: 'w' } } }), 'The project folder is missing.')
  assert.equal(pickerErrorText({ status: 409, body: { files: { unreadable: true } } }), 'Factotum cannot read that folder.')
  assert.equal(pickerErrorText({ status: 409, body: { files: { timeout: true } } }), 'That folder is taking too long to read.')
  assert.equal(pickerErrorText({ status: 404 }), 'That folder is no longer there.')
  for (const status of [0, 502, 503, 504]) assert.equal(pickerErrorText({ status }), 'Could not reach Factotum.')
  assert.equal(pickerErrorText(new TypeError('fetch failed')), 'Could not reach Factotum.')
  assert.equal(pickerErrorText({ status: 400 }), 'That path cannot be listed.')
  assert.equal(pickerErrorText({ status: 418 }), 'Could not list that folder (418).')
})

// ---------------------------------------------------------------------------
// tabOf: Tab over a whole listing, shared folders included (criterion 20)
// ---------------------------------------------------------------------------

const rootListing: Listing = {
  root: { kind: 'site', path: SITE },
  dir: SITE,
  entries: [dir('docs'), dir('src'), file('Makefile')],
  shared: [{ path: '/Users/me/factotum-shared', name: 'factotum-shared' }],
  more: 0,
  partial: false,
}

test('Tab enters a shared folder by its absolute path', () => {
  assert.deepEqual(tabOf(rootListing, 'fac'), { kind: 'rewrite', query: '/Users/me/factotum-shared/' })
})

test('Tab enters a folder, inserts a file closed, and extends a shared prefix', () => {
  assert.deepEqual(tabOf(rootListing, 'sr'), { kind: 'rewrite', query: 'src/' })
  assert.deepEqual(tabOf(rootListing, 'Ma'), { kind: 'insert', text: '@"Makefile"' })
  const docs: Listing = { ...rootListing, dir: `${SITE}/docs`, entries: [file('mi nota.md'), file('mi otra.md')], shared: [] }
  assert.deepEqual(tabOf(docs, 'docs/m'), { kind: 'rewrite', query: 'docs/mi ' })
  assert.equal(tabOf(docs, 'docs/zz'), undefined)
  const quoted: Listing = { ...docs, entries: [file('di "hola".md')] }
  assert.equal(tabOf(quoted, 'docs/di'), undefined)
})
