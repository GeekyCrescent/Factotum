import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { world } from '../test-repos.ts'
import { fakePeer, makeHost, type TestHost } from '../test-handoff.ts'
import { uuidv7 } from '../id.ts'
import { cliDirOf } from './cli-paths.ts'
import { installSession, undoInstall, type InstallJournal } from './install.ts'
import type { JournalEntry } from './journal.ts'

const there = async (path: string) => (await lstat(path).catch(() => undefined)) !== undefined

/** A staged session as the files leave it: an upload, the transcript with its folder, the session. */
async function staged(h: TestHost, project: string) {
  const id = uuidv7(Date.now())
  const upload = uuidv7(Date.now() + 1)
  const work = { staging: join(h.home, 'w', 'staging'), replaced: join(h.home, 'w', 'replaced') }
  const dir = join(work.staging, id)
  await mkdir(join(dir, 'uploads', upload), { recursive: true })
  await writeFile(join(dir, 'uploads', upload, 'f.txt'), 'file')
  await mkdir(join(dir, 'cli', id, 'subagents'), { recursive: true })
  await writeFile(join(dir, 'cli', `${id}.jsonl`), 'transcript\n')
  await writeFile(join(dir, 'cli', id, 'subagents', 'a.jsonl'), 'sub\n')
  await mkdir(join(dir, 'session'), { recursive: true })
  const meta = { id, siteId: 'personal', entryId: 'free', state: 'finished', startedAt: 'x', turns: 1, sitePath: '/Users/ferro/vault', touchedAt: 't', movedTo: 'nowhere' }
  await writeFile(join(dir, 'session', 'meta.json'), JSON.stringify(meta))
  await writeFile(join(dir, 'session', 'events.jsonl'), `${JSON.stringify({ seq: 0, at: 'x', kind: 'message', role: 'user', text: 'hi' })}\n`)
  return { id, upload, work, input: { sessionId: id, siteId: 'obsidian', projectPath: project, event: { from: 'mac', to: 'omarchy', hid: uuidv7(1) } } }
}

async function host() {
  const w = await world()
  return { w, h: await makeHost({ name: 'omarchy', projects: [{ id: 'obsidian', path: w.target }], env: w.env, peers: fakePeer('mac', { route: undefined, reachable: true }) }) }
}

function journal(failAt = Number.POSITIVE_INFINITY) {
  const installed: JournalEntry[] = []
  const replaced: JournalEntry[] = []
  let calls = 0
  const record: InstallJournal = {
    intend: async (change) => {
      calls += 1
      if (change.installed !== undefined) installed.push(change.installed)
      if (change.replaced !== undefined) replaced.push(change.replaced)
      if (calls === failAt) throw new Error('crash right after this write')
    },
    warn: async () => undefined,
  }
  return { record, installed, replaced }
}

test('the install, in order: upload, transcript at cliDir(project), then the session with THIS host’s meta and its handoff event', async () => {
  const { w, h } = await host()
  const s = await staged(h, w.target)
  const j = journal()
  await installSession(h.host, s.work, j.record, s.input)
  assert.deepEqual(j.installed.map((e) => e.kind), ['upload', 'transcript', 'session'])
  assert.equal(await readFile(join(h.host.uploadsRoot, s.upload, 'f.txt'), 'utf8'), 'file')
  const folder = join(h.host.claudeProjects, await cliDirOf(w.target))
  assert.equal(await there(join(folder, s.id, 'subagents', 'a.jsonl')), true)
  const meta = await h.host.store.readMeta(s.id)
  assert.deepEqual([meta?.siteId, meta?.sitePath, meta?.movedTo, meta?.touchedAt], ['obsidian', w.target, undefined, 't'])
  const events = (await h.host.store.read(s.id, 0)).events
  assert.equal(events.at(-1)?.kind, 'handoff')
})

for (const failAt of [1, 2, 3]) {
  test(`a crash right after journal write #${failAt}: the journal holds that intention, and nothing after it moved; the undo leaves no trace`, async () => {
    const { w, h } = await host()
    const s = await staged(h, w.target)
    const j = journal(failAt)
    await assert.rejects(installSession(h.host, s.work, j.record, s.input))
    assert.equal(j.installed.length, failAt)
    // The step whose intention crashed never ran.
    const kinds = j.installed.map((e) => e.kind)
    assert.equal(await there(join(h.host.uploadsRoot, s.upload)), kinds.includes('upload') && failAt > 1)
    assert.equal(await h.host.store.readMeta(s.id), undefined)
    assert.deepEqual(await undoInstall(h.host, s.work, j.installed, j.replaced), [])
    assert.equal(await there(join(h.host.uploadsRoot, s.upload)), false)
    assert.deepEqual(await readdir(h.host.claudeProjects).catch(() => []), [])
  })
}
