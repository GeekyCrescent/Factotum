import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { commitAll, put, sh, world } from '../test-repos.ts'
import { addSession, fakePeer, makeHost } from '../test-handoff.ts'
import { ancestryOf, projectGit, sourceSnapshot, targetProjects } from './snapshot.ts'

test('projectGit: not a repo is undefined; no origin has no key and no local commits; a detached HEAD has no branch', async () => {
  const w = await world()
  const plain = join(w.home, 'plain')
  await mkdir(plain)
  assert.equal(await projectGit(plain, w.env), undefined)

  await sh(w.env, w.source, 'remote', 'remove', 'origin')
  const noOrigin = await projectGit(w.source, w.env)
  assert.deepEqual([noOrigin?.key, noOrigin?.localCommits, noOrigin?.branch], [undefined, 0, 'main'])

  await sh(w.env, w.target, 'checkout', '--quiet', '--detach', 'HEAD')
  assert.equal((await projectGit(w.target, w.env))?.branch, undefined)
})

test('projectGit reads a rename in status as one change, and lists the branches’ tips', async () => {
  const w = await world()
  await put(w.source, 'b.txt', 'b\n')
  await commitAll(w.env, w.source, 'b')
  await sh(w.env, w.source, 'mv', 'b.txt', 'c.txt')
  await sh(w.env, w.source, 'branch', 'other')
  const git = await projectGit(w.source, w.env)
  assert.equal(git?.changedFiles, 1)
  assert.deepEqual(Object.keys(git?.heads ?? {}).sort(), ['main', 'other'])
  assert.equal(git?.clean, false)
})

test('the target lists only what is portable; the source lists every project with sessions, the running ones without their files', async () => {
  const w = await world()
  const plain = join(w.home, 'plain')
  await mkdir(plain)
  const h = await makeHost({ name: 'mac', projects: [{ id: 'vault', path: w.source }, { id: 'plain', path: plain }], env: w.env, peers: fakePeer('omarchy', { route: undefined, reachable: false }) })
  assert.deepEqual((await targetProjects(h.host)).map((p) => p.siteId), ['vault'])
  await addSession(h, { siteId: 'plain' })
  await addSession(h, { siteId: 'vault', meta: { state: 'running' } })
  const snapshot = await sourceSnapshot(h.host, new Date())
  const plainProject = snapshot.projects.find((p) => p.siteId === 'plain')
  assert.deepEqual([plainProject?.key, plainProject?.head], [undefined, undefined])
  const vault = snapshot.projects.find((p) => p.siteId === 'vault')
  assert.equal(vault?.busy, true)
  assert.deepEqual(vault?.sessions[0]?.fileBytes, [])
})

test('ancestryOf skips a tip that is not a hash, and a project that does not pair', async () => {
  const w = await world()
  const h = await makeHost({ name: 'mac', projects: [{ id: 'vault', path: w.source }], env: w.env, peers: fakePeer('omarchy', { route: undefined, reachable: false }) })
  const project = { siteId: 'vault', key: 'k', branch: 'main', head: 'a'.repeat(40), busy: false, localCommits: 0, changedFiles: 0, newUntracked: [], ignoreDigest: undefined, sessions: [] }
  const target = { key: 'k', siteId: 't', clean: true, busy: false, branch: 'main', head: 'x', heads: { main: 'not-a-hash' }, entries: [], ignoreDigest: { global: 'none', info: 'none' } }
  assert.equal((await ancestryOf(h.host, [project], [target])).size, 0)
  assert.equal((await ancestryOf(h.host, [project], [{ ...target, key: 'other' }])).size, 0)
})
