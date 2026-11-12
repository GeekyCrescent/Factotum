import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { guard } from './guard.ts'

let workDir: string

beforeEach(async () => {
  workDir = await realpath(await mkdtemp(join(tmpdir(), 'mockups-guard-')))
  await mkdir(join(workDir, 'inputs', 'private'), { recursive: true })
  await mkdir(join(workDir, 'directions'), { recursive: true })
  await writeFile(join(workDir, 'inputs', 'private', 'pacientes.csv'), 'nombre,curp\nAna,XXXX010101\n')
})
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

const LIMITS = { maxFiles: 20_000, maxMs: 60_000 }

test('crit. 35: a file of directions/ with the same bytes as a private input is refused, by its path and never its content', async () => {
  await writeFile(join(workDir, 'directions', 'index.html'), '<h1>A</h1>')
  await mkdir(join(workDir, 'directions', 'data'))
  await writeFile(join(workDir, 'directions', 'data', 'seed.csv'), 'nombre,curp\nAna,XXXX010101\n')
  const result = await guard(workDir, LIMITS)
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.reason, /directions\/data\/seed\.csv is a copy of a real-data input/)
  assert.ok(!(result.ok ? '' : result.reason).includes('Ana'))
  assert.ok(!(result.ok ? '' : result.reason).includes('pacientes'), 'the private name is not repeated')
})

test('crit. 35: mockup-app/ is checked too; node_modules, .next and .vercel are not', async () => {
  for (const skipped of ['node_modules', '.next', '.vercel']) {
    await mkdir(join(workDir, 'mockup-app', skipped), { recursive: true })
    await writeFile(join(workDir, 'mockup-app', skipped, 'copy.csv'), 'nombre,curp\nAna,XXXX010101\n')
  }
  assert.deepEqual(await guard(workDir, LIMITS), { ok: true })
  await writeFile(join(workDir, 'mockup-app', 'seed.csv'), 'nombre,curp\nAna,XXXX010101\n')
  const result = await guard(workDir, LIMITS)
  assert.match(result.ok ? '' : result.reason, /mockup-app\/seed\.csv/)
})

test('different bytes pass; an empty private file never matches an empty file', async () => {
  await writeFile(join(workDir, 'inputs', 'private', 'empty.txt'), '')
  await writeFile(join(workDir, 'directions', '.keep'), '')
  await writeFile(join(workDir, 'directions', 'seed.csv'), 'nombre,curp\nLuis,YYYY020202\n')
  assert.deepEqual(await guard(workDir, LIMITS), { ok: true })
})

test('without inputs/private/, the guard does not run', async () => {
  await rm(join(workDir, 'inputs', 'private'), { recursive: true })
  await writeFile(join(workDir, 'directions', 'index.html'), 'x')
  assert.deepEqual(await guard(workDir, LIMITS), { ok: true })
})

test('crit. 35: over the file cap, it REFUSES: cannot verify (the cap lowered for the test)', async () => {
  for (const n of [1, 2, 3]) await writeFile(join(workDir, 'directions', `${n}.html`), `${n}`)
  const result = await guard(workDir, { ...LIMITS, maxFiles: 2 })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.reason, /^cannot verify: more than 2 files/)
})

test('crit. 35: over the time cap, it REFUSES: cannot verify (a clock that jumps)', async () => {
  await writeFile(join(workDir, 'directions', 'a.html'), 'a')
  let t = 0
  const result = await guard(workDir, { ...LIMITS, maxMs: 10, clock: () => (t += 20) })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.reason, /^cannot verify: it took more than 10 ms/)
})

test('a link inside directions/ is not followed out of it, and a link to a private file is a copy', async () => {
  await symlink(join(workDir, 'inputs', 'private', 'pacientes.csv'), join(workDir, 'directions', 'linked.csv'))
  const result = await guard(workDir, LIMITS)
  assert.match(result.ok ? '' : result.reason, /directions\/linked\.csv/)
})

test('an unreadable folder fails closed: cannot verify', async () => {
  const result = await guard(join(workDir, 'missing'), LIMITS)
  assert.deepEqual(result, { ok: true }, 'no private folder at all is nothing to guard')
  await rm(join(workDir, 'directions'), { recursive: true })
  await writeFile(join(workDir, 'directions'), 'not a folder')
  const odd = await guard(workDir, LIMITS)
  assert.equal(odd.ok, false)
  assert.match(odd.ok ? '' : odd.reason, /^cannot verify/)
})
