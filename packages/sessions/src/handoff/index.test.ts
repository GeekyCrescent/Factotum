import { test } from 'node:test'
import assert from 'node:assert/strict'
import { world } from '../test-repos.ts'
import { addSession, fakePeer, makeHost } from '../test-handoff.ts'
import { uuidv7 } from '../id.ts'
import { createHandoff, peerOf } from './index.ts'

async function setup() {
  const w = await world()
  const h = await makeHost({ name: 'mac', projects: [{ id: 'vault', path: w.source }], env: w.env, peers: fakePeer('omarchy', { route: undefined, reachable: false }) })
  return { h, api: createHandoff(h.host) }
}

test('projects answers this host’s portable projects; sessions-check needs a list and digests what it has', async () => {
  const { h, api } = await setup()
  const projects = await api.projects()
  assert.equal(projects.kind, 'ok')
  assert.deepEqual((projects.kind === 'ok' ? (projects.body as { siteId: string }[]) : []).map((p) => p.siteId), ['vault'])
  assert.equal((await api.sessionsCheck({ ids: 'x' })).kind, 'invalid')
  const session = await addSession(h, { siteId: 'vault' })
  const checked = await api.sessionsCheck({ ids: [session.id, uuidv7(1), '../x', 3] })
  assert.deepEqual(checked.kind === 'ok' ? (checked.body as { id: string }[]).map((c) => c.id) : [], [session.id])
})

test('a preview needs { to } naming a peer; the id is checked before anything else', async () => {
  const { api } = await setup()
  for (const body of [undefined, {}, { to: 'nobody' }, { to: '../x' }]) assert.equal(api.startPreview(body).kind, 'invalid')
  const started = api.startPreview({ to: 'omarchy' })
  assert.equal(started.kind === 'ok' ? started.status : undefined, 202)
  const id = started.kind === 'ok' ? (started.body as { previewId: string }).previewId : ''
  assert.equal(api.preview(id).kind, 'ok')
  assert.equal(api.preview('not-an-id').kind, 'invalid')
  assert.equal(api.preview(uuidv7(1)).kind, 'not-found')
})

test('peerOf: a string a path can carry, and a peer of this host', () => {
  const peers = fakePeer('omarchy', { route: undefined, reachable: true })
  assert.equal(peerOf({ peers }, { to: 'omarchy' }), 'omarchy')
  assert.equal(peerOf({ peers }, { to: 'OMARCHY' }), undefined)
  assert.equal(peerOf({ peers }, null), undefined)
})
