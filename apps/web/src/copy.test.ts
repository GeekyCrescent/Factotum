import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * No «—» in what anyone reads (spec 2026-09-18, criterion 41).
 *
 * The comments are taken out first: they are for the next person to edit the file, and they use
 * the dash freely. What is left of a `.tsx` is code, strings, templates and JSX text, and since
 * the code itself never uses «—», any that remains is on screen.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const DIRS = [join(ROOT, 'apps', 'web', 'src'), join(ROOT, 'modules', 'sessions', 'client')]

async function tsxUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries.filter((e) => e.isFile() && e.name.endsWith('.tsx')).map((e) => join(e.parentPath, e.name))
}

/** Block comments, and line comments that start a line or follow whitespace (not `https://`). */
export function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
}

test('the comment stripper keeps what is read and drops what is not', () => {
  const source = "/** a — b */\nconst x = 'shown — here' // not — shown\n<a href=\"https://x\">text</a>"
  const left = withoutComments(source)
  assert.equal(left.includes('shown — here'), true)
  assert.equal(left.includes('not — shown'), false)
  assert.equal(left.includes('a — b'), false)
  assert.equal(left.includes('https://x'), true)
})

test('no «—» is left in any .tsx of the client or of sessions once the comments are gone (criterion 41)', async () => {
  const files = (await Promise.all(DIRS.map(tsxUnder))).flat()
  assert.ok(files.length >= 10, `found only ${files.length} .tsx files: the walk is wrong`)
  const hits: string[] = []
  for (const file of files) {
    const lines = withoutComments(await readFile(file, 'utf8')).split('\n')
    lines.forEach((line, index) => {
      if (line.includes('—')) hits.push(`${relative(ROOT, file)}: ${line.trim()}`)
    })
  }
  assert.deepEqual(hits, [])
})
