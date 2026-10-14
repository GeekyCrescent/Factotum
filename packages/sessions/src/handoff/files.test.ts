import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { world } from '../test-repos.ts'
import { addSession, fakePeer, makeHost } from '../test-handoff.ts'
import { uuidv7 } from '../id.ts'
import { sessionFiles } from './files.ts'

async function host() {
  const w = await world()
  return await makeHost({ name: 'mac', projects: [{ id: 'vault', path: w.source }], env: w.env, peers: fakePeer('omarchy', { route: undefined, reachable: false }) })
}

test('a session’s files: meta, log, the uploads its OWNER sent, the transcript and its folder — each where it lands', async () => {
  const h = await host()
  const upload = uuidv7(Date.now())
  const other = uuidv7(Date.now() + 1)
  await mkdir(join(h.host.uploadsRoot, upload), { recursive: true })
  await writeFile(join(h.host.uploadsRoot, upload, 'photo.jpg'), 'JPEG')
  await mkdir(join(h.host.uploadsRoot, other), { recursive: true })
  await writeFile(join(h.host.uploadsRoot, other, 'quoted.txt'), 'not the owner’s')
  const session = await addSession(h, {
    siteId: 'vault',
    events: [
      { kind: 'message', role: 'user', text: `look\n@${join(h.host.uploadsRoot, upload, 'photo.jpg')}` },
      { kind: 'message', role: 'assistant', text: `@${join(h.host.uploadsRoot, other, 'quoted.txt')}` },
    ],
    transcript: '{"t":1}\n',
  })
  const folder = join(h.host.claudeProjects, '-somewhere', session.id, 'tool-results')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'r1.txt'), 'result')

  const { files, transcriptFound } = await sessionFiles(h.host, session.id)
  assert.equal(transcriptFound, true)
  assert.deepEqual(
    files.map((file) => [file.kind, file.rel]),
    [
      ['meta', 'session/meta.json'],
      ['events', 'session/events.jsonl'],
      ['upload', `uploads/${upload}/photo.jpg`],
      ['transcript', `cli/${session.id}.jsonl`],
      ['transcript-dir-file', `cli/${session.id}/tool-results/r1.txt`],
    ],
  )
  assert.equal(files.find((file) => file.kind === 'upload')?.bytes, 4)
})

test('an upload folder that is a link is not followed, and no transcript is said so', async () => {
  const h = await host()
  const upload = uuidv7(Date.now())
  await mkdir(h.host.uploadsRoot, { recursive: true })
  await symlink('/etc', join(h.host.uploadsRoot, upload))
  const session = await addSession(h, { siteId: 'vault', events: [{ kind: 'message', role: 'user', text: `@${join(h.host.uploadsRoot, upload, 'hosts')}` }] })
  const { files, transcriptFound } = await sessionFiles(h.host, session.id)
  assert.equal(transcriptFound, false)
  assert.deepEqual(files.map((file) => file.kind), ['meta', 'events'])
})
