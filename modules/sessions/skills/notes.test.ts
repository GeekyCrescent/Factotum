import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNotes, MAX_NOTES_BYTES, parseNotes, type NoteRow } from './notes.ts'

const HEAD = '| Name | Para qué | Cuándo la llamo |\n|---|---|---|\n'

const names = (text: string): readonly string[] => parseNotes(text).groups.flatMap((group) => group.rows.map((row) => row.name))

test('rule 1: a fenced block is skipped whole, and a quoted line is never a table', () => {
  const text = [
    '## Group',
    '```',
    '## Not a group',
    '| `fenced` | a | b |',
    '```',
    '> | Name | Para qué | Cuándo |',
    '> |---|---|---|',
    '> | `quoted` | a | b |',
    HEAD + '| `real` | a | b |',
  ].join('\n')
  const parsed = parseNotes(text)
  assert.deepEqual(parsed.groups.map((group) => group.label), ['Group'])
  assert.deepEqual(names(text), ['real'])
})

test('rule 2: ## and ### open groups, labels lose their Markdown, and a table before the first one is ignored with a warning', () => {
  const text = [
    '# Title',
    HEAD + '| `early` | a | b |',
    '',
    '## **Meta** and `code`',
    HEAD + '| `one` | a | b |',
    '### [[page|Linked]] group',
    HEAD + '| `two` | a | b |',
    '#### Not a group',
    HEAD + '| `three` | a | b |',
  ].join('\n')
  const parsed = parseNotes(text)
  assert.deepEqual(parsed.groups.map((group) => group.label), ['Meta and code', 'Linked group'])
  assert.deepEqual(names(text), ['one', 'two', 'three'])
  assert.equal(parsed.warnings.length, 1)
  assert.match(parsed.warnings[0]!, /before the first/)
})

test('rule 3: a table needs both the why and the when column, found by name, in any order', () => {
  const text = [
    '## G',
    '| Tool | Para qué | Verificado con |',
    '|---|---|---|',
    '| `nowhen` | a | b |',
    '',
    '| Necesito | Uso |',
    '|---|---|',
    '| `nowhy` | a |',
    '',
    '| Name | CUÁNDO la lo llamo | Para que sirve |',
    '|:--|:-:|--:|',
    '| `swapped` | when text | why text |',
  ].join('\n')
  const parsed = parseNotes(text)
  assert.deepEqual(names(text), ['swapped'])
  assert.deepEqual(parsed.groups[0]!.rows[0], { name: 'swapped', agent: false, why: 'why text', when: 'when text' })
  assert.deepEqual(parsed.warnings, [])
})

test('rule 4: cells split on a bare pipe, an escaped one is literal, and missing cells are undefined', () => {
  const text = ['## G', HEAD + '| `a` | one \\| two | b |', '| `b` | only why |', '| `c` |'].join('\n')
  const rows = parseNotes(text).groups[0]!.rows
  assert.deepEqual(rows[0], { name: 'a', agent: false, why: 'one | two', when: 'b' })
  assert.deepEqual(rows[1], { name: 'b', agent: false, why: 'only why', when: undefined })
  assert.deepEqual(rows[2], { name: 'c', agent: false, why: undefined, when: undefined })
})

test('rule 5: the name is the first backtick span, minus the slash, cut at the first space; a bad one skips the row with a warning', () => {
  const text = [
    '## G',
    HEAD + '| `/nuevo-proyecto <nombre>` | a | b |',
    '| see `plain` and `other` | a | b |',
    '| `superpowers:brainstorming` | a | b |',
    '| `bad!name` | a | b |',
    '| no backticks | a | b |',
    '| `ok-after` | a | b |',
  ].join('\n')
  const parsed = parseNotes(text)
  assert.deepEqual(names(text), ['nuevo-proyecto', 'plain', 'superpowers:brainstorming', 'ok-after'])
  assert.equal(parsed.warnings.length, 2)
})

test('rule 6: (agente) and (agent) in the first cell mark an agent; (command) does not', () => {
  const text = ['## G', HEAD + '| `a` *(agente)* | x | y |', '| `b` *(agent)* | x | y |', '| `c` *(command)* | x | y |'].join('\n')
  const rows: readonly NoteRow[] = parseNotes(text).groups[0]!.rows
  assert.deepEqual(rows.map((row) => row.agent), [true, true, false])
})

test('rule 7: why and when lose their Markdown, sit on one line and stop at 200 characters', () => {
  const long = 'x'.repeat(300)
  const text = ['## G', HEAD + `| \`a\` | **bold** and \`code\` and [[a\\|b]] <br> next | ${long} |`].join('\n')
  const row = parseNotes(text).groups[0]!.rows[0]!
  assert.equal(row.why, 'bold and code and b <br> next')
  assert.equal(row.when?.length, 200)
})

test('rule 8: a repeated name with the same agent flag counts once and warns; with another flag it is a different row', () => {
  const text = ['## A', HEAD + '| `dup` | first | b |', '## B', HEAD + '| `dup` | second | b |', '| `dup` *(agente)* | agent | b |'].join('\n')
  const parsed = parseNotes(text)
  assert.deepEqual(parsed.groups.map((group) => group.rows.map((row) => [row.name, row.agent, row.why])), [
    [['dup', false, 'first']],
    [['dup', true, 'agent']],
  ])
  assert.equal(parsed.warnings.length, 1)
  assert.match(parsed.warnings[0]!, /dup/)
})

test('rule 9: a group with no rows is not emitted', () => {
  const text = ['## Empty', 'prose', '## Only a foreign table', '| Tool | Verificado con |', '|---|---|', '| `x` | y |', '## Full', HEAD + '| `a` | b | c |'].join('\n')
  assert.deepEqual(parseNotes(text).groups.map((group) => group.label), ['Full'])
})

// A synthetic note with the SHAPE of the owner's real one (requirements §0.9). The real one names clients,
// and this repo is public.
const FIXTURE = [
  '# Tools — inventory',
  '',
  '> Index of everything I can launch with `/`.',
  '> [!important] Contract',
  '> - **Each `##` is a group.** A table before the first one does not count.',
  '> | Name | Para qué | Cuándo la llamo |',
  '',
  '| Tool | Para qué | Cuándo la llamo |',
  '|---|---|---|',
  '| `/before-title` | ignored | ignored |',
  '',
  '```',
  '/inside-fence',
  '`also-inside`',
  '```',
  '',
  '## Spec cycle',
  '',
  '| Name | Para qué | Cuándo la llamo |',
  '|---|---|---|',
  '| `/clarify-idea` *(command)* | Fuzzy idea → brief | I have an idea with no shape |',
  '| `/nuevo-proyecto <nombre>` | **Creates** a [[hub\\|project]] | When `starting` one |',
  '| `spec-validator` *(agente)* | The auditor | Almost never direct |',
  '',
  '### Implement — Superpowers',
  '',
  '| Name | Para qué | Cuándo lo llamo |',
  '|---|---|---|',
  '| `superpowers:brainstorming` | Explore before building | Something new |',
  '| `clarify-idea` | A duplicate of the first row | never |',
  '| `short` |',
  '',
  '## Installed tools',
  '',
  '| Herramienta | Para qué | Verificado con |',
  '|---|---|---|',
  '| `gh` | GitHub CLI | `gh --version` |',
  '',
  '## Review',
  '',
  '| Necesito | Uso |',
  '|---|---|',
  '| a review | `code-review` |',
  '',
  '## Empty on purpose',
  '',
  'just prose',
  '',
].join('\n')

test('a synthetic note shaped like the real one: groups in heading order, rows in row order, one warning per defect', () => {
  const parsed = parseNotes(FIXTURE)
  assert.deepEqual(
    parsed.groups.map((group) => [group.label, group.rows.map((row) => row.name)]),
    [
      ['Spec cycle', ['clarify-idea', 'nuevo-proyecto', 'spec-validator']],
      ['Implement — Superpowers', ['superpowers:brainstorming', 'short']],
    ],
  )
  assert.deepEqual(parsed.groups[0]!.rows[1], { name: 'nuevo-proyecto', agent: false, why: 'Creates a project', when: 'When starting one' })
  assert.equal(parsed.groups[0]!.rows[2]!.agent, true)
  assert.equal(parsed.warnings.length, 2)
  assert.ok(parsed.warnings.some((warning) => /before the first/.test(warning)))
  assert.ok(parsed.warnings.some((warning) => /clarify-idea/.test(warning)))
})

// ---------------------------------------------------------------------------
// createNotes
// ---------------------------------------------------------------------------

const NOTE = (name: string): string => `## G\n\n${HEAD}| \`${name}\` | why | when |\n`

async function inTmp(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'skills-notes-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('off and invalid never touch the disk and keep their reason', async () => {
  assert.deepEqual(await createNotes({ kind: 'off' }).read(), { state: 'off' })
  assert.deepEqual(await createNotes({ kind: 'invalid', reason: 'skills.notes: nope' }).read(), { state: 'invalid', reason: 'skills.notes: nope' })
})

test('a file that is there is read and parsed', async () => {
  await inTmp(async (dir) => {
    const file = join(dir, 'note.md')
    await writeFile(file, NOTE('alpha'))
    const result = await createNotes({ kind: 'on', notes: file }).read()
    assert.equal(result.state, 'ok')
    if (result.state === 'ok') assert.deepEqual(result.parsed.groups[0]!.rows.map((row) => row.name), ['alpha'])
  })
})

test('criterion 12: rewriting the file changes the next read, with no restart', async () => {
  await inTmp(async (dir) => {
    const file = join(dir, 'note.md')
    await writeFile(file, NOTE('alpha'))
    await utimes(file, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))
    const notes = createNotes({ kind: 'on', notes: file })
    const first = await notes.read()
    await writeFile(file, NOTE('bravo'))
    await utimes(file, new Date('2026-10-01T00:00:05Z'), new Date('2026-10-01T00:00:05Z'))
    const second = await notes.read()
    assert.equal(first.state === 'ok' && first.parsed.groups[0]!.rows[0]!.name, 'alpha')
    assert.equal(second.state === 'ok' && second.parsed.groups[0]!.rows[0]!.name, 'bravo')
  })
})

test('the same mtime and size is a cache hit: the file is not read again', async () => {
  await inTmp(async (dir) => {
    const file = join(dir, 'note.md')
    const when = new Date('2026-10-01T00:00:00Z')
    await writeFile(file, NOTE('alpha'))
    await utimes(file, when, when)
    const notes = createNotes({ kind: 'on', notes: file })
    const first = await notes.read()
    await writeFile(file, NOTE('bravo')) // same size
    await utimes(file, when, when)
    assert.equal(await notes.read(), first)
  })
})

test('missing, too-large and unreadable are states, never throws', async () => {
  await inTmp(async (dir) => {
    assert.deepEqual(await createNotes({ kind: 'on', notes: join(dir, 'nope.md') }).read(), { state: 'missing' })

    const big = join(dir, 'big.md')
    await writeFile(big, 'x'.repeat(MAX_NOTES_BYTES + 1))
    assert.equal((await createNotes({ kind: 'on', notes: big }).read()).state, 'too-large')

    // A directory stats fine and fails to read with EISDIR.
    const asDir = await createNotes({ kind: 'on', notes: dir }).read()
    assert.equal(asDir.state, 'unreadable')
    assert.equal(asDir.state === 'unreadable' && asDir.reason, 'EISDIR')
  })
})
