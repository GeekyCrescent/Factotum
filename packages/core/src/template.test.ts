import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rootConfigSchema } from './config.ts'

/**
 * `config.template.json` is the file people copy, and nothing else in the suite looks
 * at it.
 *
 * It validated before this spec and stopped the moment `publicOrigin` became
 * required — silently, because a template is documentation and documentation does not
 * run. The consequence would have been that the first thing a new user copies is a
 * config the daemon refuses to start on.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const TEMPLATE = join(REPO_ROOT, 'config.template.json')

async function template(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(TEMPLATE, 'utf8')) as Record<string, unknown>
}

test('config.template.json validates against the real root schema', async () => {
  const parsed = rootConfigSchema.safeParse(await template())
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues, null, 2))
})

test('the template `_comment` survives, because z.object drops unknown keys', async () => {
  // Worth pinning: the template carries its documentation in `_comment`, and the root
  // schema has no such field. It validates because zod IGNORES unknown keys at the
  // root rather than rejecting them — if that ever became `.strict()`, the template
  // would fail and the reason would not be obvious.
  const raw = await template()
  assert.ok(Array.isArray(raw['_comment']))
  const parsed = rootConfigSchema.parse(raw)
  assert.equal('_comment' in parsed, false)
})

test('the template binds to LOOPBACK, which is what the spec changed', async () => {
  const parsed = rootConfigSchema.parse(await template())
  assert.equal(parsed.listen.address, '127.0.0.1')
})

test('the template does NOT ship an extraOrigins escape hatch switched on', async () => {
  // `localhost:5173` is literally "another service on this machine", which is what
  // the origin policy exists to refuse. It is the right answer in a dev config and
  // never in the file everyone copies.
  const parsed = rootConfigSchema.parse(await template())
  assert.deepEqual(parsed.listen.extraOrigins, [])
})
