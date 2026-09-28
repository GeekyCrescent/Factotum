import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { measure, modesOf, PAIRS, ratio } from './contrast.ts'

/**
 * The tokens, read from THE file the client ships — not from a copy — so the test that measures a
 * colour is the one that would see it change (spec criteria 1, 2, 4).
 */

const STYLES = join(dirname(fileURLToPath(import.meta.url)), 'styles')
const tokensCss = () => readFile(join(STYLES, 'tokens.css'), 'utf8')

/** design/direccion-visual.md §Tokens, the seventeen colour tokens. */
const COLOUR_TOKENS = [
  'bg', 'surface', 'surface-2', 'line', 'line-strong', 'text', 'text-2', 'text-3', 'accent',
  'on-accent', 'accent-text', 'ask', 'ask-bg', 'ok', 'err', 'err-bg', 'scrim',
]

test('all seventeen colour tokens are declared in BOTH blocks, in the one form contrast.ts reads (criterion 1)', async () => {
  const css = await tokensCss()
  const at = css.indexOf('@media (prefers-color-scheme: dark)')
  for (const [mode, block] of [['light', css.slice(0, at)], ['dark', css.slice(at)]] as const) {
    for (const name of COLOUR_TOKENS) {
      const form = name === 'scrim' ? /oklch\([\d.]+ [\d.]+ [\d.]+ \/ [\d.]+\)/ : /oklch\([\d.]+ [\d.]+ [\d.]+\)/
      const line = new RegExp(`--${name}:\\s*(oklch\\([^)]*\\))`).exec(block)
      assert.ok(line, `${mode}: --${name} is not declared`)
      assert.match(line[1] ?? '', form, `${mode}: --${name} is not in oklch(L C H) form`)
    }
  }
})

test('--dur-press is fixed at 140ms, the middle of the range the direction gives (criterion 1)', async () => {
  assert.match(await tokensCss(), /--dur-press:\s*140ms;/)
})

test('contrast: ZERO failing pairs, and EXACTLY 32 evaluated — a skipped pair cannot pass (criterion 2)', async () => {
  const results = measure(await tokensCss())
  const failing = results.filter((r) => !r.ok).map((r) => `${r.mode} --${r.pair.fg} on --${r.pair.bg}: ${r.ratio.toFixed(2)}`)
  assert.equal(results.length, 32)
  assert.equal(results.length, PAIRS.length * 2)
  assert.deepEqual(failing, [])
})

test('contrast FAILS on a colour that is too light (criterion 2, in red)', async () => {
  const css = (await tokensCss()).replace('--text-3: oklch(0.50 0.012 265);', '--text-3: oklch(0.70 0.012 265);')
  const failing = measure(css).filter((r) => !r.ok)
  assert.ok(failing.some((r) => r.mode === 'light' && r.pair.fg === 'text-3'))
})

test('contrast THROWS on a token it cannot read, instead of skipping the pair (criterion 2, in red)', async () => {
  const css = (await tokensCss()).replace('--accent: oklch(0.52 0.17 268);', '--accent: oklch(52% 0.17 268);')
  assert.throws(() => measure(css), /cannot read --accent/)
})

test('the ratio itself is right at the ends: black on white is 21, a colour on itself is 1', () => {
  assert.equal(ratio([0, 0, 0], [1, 0, 0]).toFixed(2), '21.00')
  assert.equal(ratio([0.5, 0.1, 200], [0.5, 0.1, 200]), 1)
})

test('both modes parse to the same set of names', async () => {
  const { light, dark } = modesOf(await tokensCss())
  assert.deepEqual([...light.keys()].sort(), [...dark.keys()].sort())
})

test('reduced motion takes every transform away (criterion 4)', async () => {
  const base = await readFile(join(STYLES, 'base.css'), 'utf8')
  const block = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(base)
  assert.ok(block, 'base.css has no reduced-motion block')
  assert.match(block[1] ?? '', /transform:\s*none\s*!important/)
  assert.match(block[1] ?? '', /transition-property:\s*opacity\s*!important/)
})
