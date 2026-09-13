import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStaticSite } from './static.ts'

async function site() {
  const root = await mkdtemp(join(tmpdir(), 'factotum-site-'))
  await writeFile(join(root, 'index.html'), '<!doctype html>', 'utf8')
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)', 'utf8')
  await writeFile(join(root, 'manifest.json'), '{}', 'utf8')
  // A file next to the root that must never be reachable through it.
  await writeFile(join(root, '..', 'secret.txt'), 'do not serve me', 'utf8')
  return { root, serve: createStaticSite(root).serve }
}

test('serves the shell at the root', async () => {
  const { serve } = await site()
  const file = await serve('/')
  assert.equal(file?.body.toString(), '<!doctype html>')
  assert.match(file?.type ?? '', /text\/html/)
})

test('serves a real asset with its own content type', async () => {
  const { serve } = await site()
  assert.match((await serve('/assets/app.js'))?.type ?? '', /javascript/)
  assert.match((await serve('/manifest.json'))?.type ?? '', /json/)
})

test('an unknown path falls back to the shell so /m/<id> survives a reload', async () => {
  const { serve } = await site()
  assert.equal((await serve('/m/example'))?.body.toString(), '<!doctype html>')
})

test('a path that climbs out of the root cannot reach a file next to it', async () => {
  // Belt and braces: the server normalises the request path first, and this is the
  // second line — a static server that can be talked out of its root is the classic
  // way to read /etc/passwd.
  const { serve } = await site()
  for (const path of ['/../secret.txt', '/assets/../../secret.txt', '/././../secret.txt']) {
    const file = await serve(path)
    assert.notEqual(file?.body.toString(), 'do not serve me', `${path} must not escape`)
  }
})
