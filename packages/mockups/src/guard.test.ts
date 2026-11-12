import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { guard, tokenFileCheck } from './guard.ts'

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

test('review: the time cap covers the hashing, not only the walk (a clock that ticks once per call)', async () => {
  await writeFile(join(workDir, 'directions', 'same-size.csv'), 'x'.repeat('nombre,curp\nAna,XXXX010101\n'.length))
  let t = 0
  const result = await guard(workDir, { ...LIMITS, maxMs: 3, clock: () => ++t })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.reason, /^cannot verify: it took more than 3 ms/)
})

test('review: a link to a FOLDER inside directions/ fails closed — it may be published through', async () => {
  await symlink(join(workDir, 'inputs', 'private'), join(workDir, 'directions', 'data'))
  const result = await guard(workDir, LIMITS)
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.reason, /^cannot verify: directions\/data is a link to a folder/)
})

test('review: node_modules, .next and .vercel are skipped only at the top of a guarded folder', async () => {
  await mkdir(join(workDir, 'directions', 'assets', '.next'), { recursive: true })
  await writeFile(join(workDir, 'directions', 'assets', '.next', 'x.csv'), 'nombre,curp\nAna,XXXX010101\n')
  const result = await guard(workDir, LIMITS)
  assert.match(result.ok ? '' : result.reason, /directions\/assets\/\.next\/x\.csv is a copy/)
})

test('review (security H1): a .env* file in an uploaded folder that its .vercelignore does not cover is refused', async () => {
  await mkdir(join(workDir, 'mockup-app'), { recursive: true })
  await writeFile(join(workDir, 'mockup-app', '.env.local'), 'VERCEL_OIDC_TOKEN=x\n')
  const bare = await tokenFileCheck(workDir)
  assert.equal(bare.ok, false)
  assert.match(bare.ok ? '' : bare.reason, /mockup-app\/\.env\.local .*\.vercelignore/)
  assert.doesNotMatch(bare.ok ? '' : bare.reason, /VERCEL_OIDC_TOKEN|=x/, 'never the content')
  await writeFile(join(workDir, 'mockup-app', '.vercelignore'), '.vercel\nnode_modules\n')
  assert.equal((await tokenFileCheck(workDir)).ok, false, 'a .vercelignore without .env* does not cover it')
  await writeFile(join(workDir, 'mockup-app', '.vercelignore'), '.vercel\n.env*\n')
  assert.equal((await tokenFileCheck(workDir)).ok, true)
  await writeFile(join(workDir, 'mockup-app', '.vercelignore'), '.env.local\n')
  assert.equal((await tokenFileCheck(workDir)).ok, true, 'the exact name covers it too')
})

test('review (security H1): no .env* file, or no guarded folder, is clear', async () => {
  assert.equal((await tokenFileCheck(workDir)).ok, true)
  await rm(join(workDir, 'directions'), { recursive: true })
  assert.equal((await tokenFileCheck(workDir)).ok, true)
})

test('review (security H1): a negation that brings a .env* file back into the upload is refused', async () => {
  await mkdir(join(workDir, 'mockup-app'), { recursive: true })
  await writeFile(join(workDir, 'mockup-app', '.env.local'), 'T=x\n')
  for (const negation of ['!.env.local', '!*.local', '!.e*']) {
    await writeFile(join(workDir, 'mockup-app', '.vercelignore'), `.env*\n${negation}\n`)
    const result = await tokenFileCheck(workDir)
    assert.equal(result.ok, false, negation)
    assert.match(result.ok ? '' : result.reason, /mockup-app\/\.vercelignore has a «!» line/, negation)
  }
})
