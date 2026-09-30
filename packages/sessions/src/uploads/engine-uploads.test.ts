/**
 * Uploads through the real engine (spec 2026-10-01, block C): keeping and finding a file, deleting a
 * conversation's uploads by the three doors, the name a conversation of files alone gets, the search,
 * the titler, and the gate on a `Read` of an upload.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Timers } from '@factotum/core'
import { createEngine } from '../engine.ts'
import { uuidv7 } from '../id.ts'
import { SiteLocks } from '../locks.ts'
import { sessionPaths } from '../paths.ts'
import { SessionStore } from '../store.ts'
import { memoryRegistry } from '../test-registry.ts'
import type { EventInput, SessionEngine, TitlesConfig } from '../types.ts'

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'fake-claude.mjs')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1])
const TITLES_OFF: TitlesConfig = { enabled: false, model: 'haiku', effort: 'low' }
const TITLES_ON: TitlesConfig = { enabled: true, model: 'haiku', effort: 'low' }

const timers: Timers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms)
    handle.unref()
    return { [Symbol.dispose]: () => clearInterval(handle) }
  },
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref()
    return { [Symbol.dispose]: () => clearTimeout(handle) }
  },
}

interface World {
  readonly engine: SessionEngine
  readonly stateDir: string
  readonly siteDir: string
  readonly uploadsRoot: string
  readonly store: SessionStore
}

/** `seed` runs against the store BEFORE the engine exists, like conversations from an earlier run. */
async function world(options: { titles?: TitlesConfig; seed?: (store: SessionStore, uploadsRoot: string) => Promise<void> } = {}): Promise<World> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'factotum-up-engine-')))
  const stateDir = join(home, 'state')
  const siteDir = join(home, 'site')
  await mkdir(stateDir, { recursive: true })
  await mkdir(siteDir, { recursive: true })
  const paths = sessionPaths(stateDir)
  const store = new SessionStore(paths, () => new Date())
  await store.ensureRoots()
  await options.seed?.(store, paths.uploads)
  const engine = await createEngine(
    {
      titles: options.titles ?? TITLES_OFF,
      uploadMaxBytes: 20 * 1024 * 1024,
      stateDir,
      registry: memoryRegistry({ sites: [{ id: 'work', path: siteDir }] }),
      home: '/nonexistent-home-for-tests',
      factotumRoot: '/nonexistent-home-for-tests/.factotum',
      installRoot: undefined,
      catalog: [{ id: 'free', label: 'Free prompt', invoke: { kind: 'none' } }],
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => new Date(),
      timers,
      hookUrl: () => 'http://127.0.0.1:7778',
      notify: { canReach: () => false, send: async () => undefined },
    },
    { bin: FAKE, caseInsensitive: false },
  )
  await engine.reconcile()
  return { engine, stateDir, siteDir, uploadsRoot: paths.uploads, store }
}

/** An upload on disk, as the engine would have kept it. */
async function uploadOnDisk(uploadsRoot: string, name = 'a.png'): Promise<{ id: string; path: string; ref: string }> {
  const id = uuidv7()
  const path = join(uploadsRoot, id, name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, PNG)
  return { id, path, ref: `@${path}` }
}

/** A finished conversation in `siteId` whose log holds these events. */
async function conversation(store: SessionStore, siteId: string, events: readonly EventInput[]): Promise<string> {
  const id = uuidv7()
  await store.create({ id, siteId, entryId: 'free', startedAt: new Date().toISOString(), sitePath: undefined, prompt: 'x' })
  for (const event of events) await store.append(id, event)
  await store.patchMeta(id, (meta) => ({ ...meta, state: 'finished' }))
  return id
}

const exists = async (path: string): Promise<boolean> => await stat(path).then(() => true, () => false)

async function settle(engine: SessionEngine, id: string, stateDir: string, siteId = 'work'): Promise<void> {
  const deadline = Date.now() + 15_000
  const locks = new SiteLocks(sessionPaths(stateDir))
  for (;;) {
    const page = await engine.read(id, 0)
    const over = !('kind' in page) && page.state !== 'running' && (await locks.heldBy(siteId)) === undefined
    if (over) return
    if (Date.now() > deadline) throw new Error(`session ${id} never settled`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function launched(w: World, text: string): Promise<string> {
  const result = await w.engine.launch({ siteId: 'work', entryId: 'free', text, force: false })
  assert.equal(result.outcome, 'started', JSON.stringify(result))
  const id = result.outcome === 'started' ? result.sessionId : ''
  await settle(w.engine, id, w.stateDir)
  return id
}

// ---------------------------------------------------------------------------
// Keeping and finding
// ---------------------------------------------------------------------------

test('the engine keeps a received file, finds it again, and reports its ceiling in the view', async () => {
  const w = await world()
  const incoming = join(w.stateDir, '.incoming')
  await mkdir(incoming, { recursive: true })
  await writeFile(join(incoming, 'x.part'), PNG)

  const result = await w.engine.upload({ path: join(incoming, 'x.part'), bytes: PNG.length }, 'Captura 1.png')
  assert.equal(result.outcome, 'ok')
  if (result.outcome !== 'ok') return
  assert.equal(result.image, true)
  assert.ok(result.path.startsWith(w.uploadsRoot))
  assert.deepEqual(w.engine.openUpload(result.uploadId, result.name), { kind: 'ok', path: result.path })
  assert.deepEqual(w.engine.openUpload('..', result.name), { kind: 'invalid' })
  assert.deepEqual(w.engine.view().uploads, { maxBytes: 20 * 1024 * 1024 })
})

// ---------------------------------------------------------------------------
// Deleting: the three doors, and only what the owner sent (criteria 33, 34)
// ---------------------------------------------------------------------------

test('DELETING FROM THE HISTORY deletes what the owner sent, and nothing the agent only read or quoted', async () => {
  let sent = { id: '', path: '', ref: '' }
  let read = { id: '', path: '', ref: '' }
  let elsewhere = { id: '', path: '', ref: '' }
  let target = ''
  const w = await world({
    seed: async (store, root) => {
      sent = await uploadOnDisk(root, 'sent.png')
      read = await uploadOnDisk(root, 'read.png')
      elsewhere = await uploadOnDisk(root, 'other.png')
      target = await conversation(store, 'work', [
        { kind: 'message', role: 'user', text: `Mira esto\n\n${sent.ref}` },
        { kind: 'tool', name: 'Read', input: { file_path: read.path } },
        { kind: 'result', name: 'Bash', ok: true, summary: read.ref },
        { kind: 'message', role: 'assistant', text: `I compared it with\n${elsewhere.ref}` },
        // A path that looks like an upload under ANOTHER root deletes nothing.
        { kind: 'message', role: 'user', text: `@/tmp/uploads/${read.id}/read.png` },
      ])
    },
  })

  const [result] = await w.engine.remove([target])
  assert.equal(result?.outcome, 'removed')
  assert.equal(await exists(dirname(sent.path)), false, 'what the owner sent is gone')
  assert.equal(await exists(read.path), true, 'what the agent read stays')
  assert.equal(await exists(elsewhere.path), true, 'what the agent quoted stays')
})

test('ARCHIVING deletes nothing, and neither does unarchiving', async () => {
  let sent = { id: '', path: '', ref: '' }
  let target = ''
  const w = await world({
    seed: async (store, root) => {
      sent = await uploadOnDisk(root)
      target = await conversation(store, 'work', [{ kind: 'message', role: 'user', text: sent.ref }])
    },
  })
  assert.equal((await w.engine.archive(target, true)).outcome, 'ok')
  assert.equal((await w.engine.archive(target, false)).outcome, 'ok')
  assert.deepEqual(await readFile(sent.path), PNG)
})

test('DELETING A PROJECT deletes the uploads its conversations sent', async () => {
  let sent = { id: '', path: '', ref: '' }
  const w = await world({
    seed: async (store, root) => {
      sent = await uploadOnDisk(root)
      await conversation(store, 'work', [{ kind: 'message', role: 'user', text: sent.ref }])
    },
  })
  assert.deepEqual(await w.engine.removeProject('work'), { outcome: 'ok', removedSessions: 1 })
  assert.equal(await exists(dirname(sent.path)), false)
})

test('DELETING A REMOVED PROJECT’S HISTORY deletes the uploads its conversations sent', async () => {
  let sent = { id: '', path: '', ref: '' }
  const w = await world({
    seed: async (store, root) => {
      sent = await uploadOnDisk(root)
      await conversation(store, 'gone', [{ kind: 'message', role: 'user', text: sent.ref }])
    },
  })
  assert.deepEqual(await w.engine.removeHistory('gone'), { outcome: 'ok', removedSessions: 1 })
  assert.equal(await exists(dirname(sent.path)), false)
})

test('a conversation whose directory is a symlink is not read through: its uploads stay', async () => {
  let sent = { id: '', path: '', ref: '' }
  let target = ''
  const w = await world({
    seed: async (store, root) => {
      sent = await uploadOnDisk(root)
      // A real conversation elsewhere, and a link to it where the engine looks.
      const real = await conversation(store, 'work', [{ kind: 'message', role: 'user', text: sent.ref }])
      const paths = sessionPaths(dirname(dirname(store.sessionDir(real))))
      const outside = join(dirname(paths.root), 'outside')
      await mkdir(outside, { recursive: true })
      await rename(store.sessionDir(real), join(outside, real))
      await symlink(join(outside, real), store.sessionDir(real))
      target = real
    },
  })
  await w.engine.remove([target])
  assert.deepEqual(await readFile(sent.path), PNG)
})

// ---------------------------------------------------------------------------
// The name, the search and the titler never see a path (criteria 32, 35)
// ---------------------------------------------------------------------------

test('a conversation of files alone is named by the files, one with words by the words (criterion 32)', async () => {
  const w = await world()
  const one = await uploadOnDisk(w.uploadsRoot, 'captura.png')
  const two = await uploadOnDisk(w.uploadsRoot, 'informe.pdf')

  const files = await launched(w, `${one.ref}\n${two.ref}`)
  const summary = await w.engine.summary(files)
  assert.equal(summary.kind === 'ok' ? summary.summary.prompt : '', 'captura.png, informe.pdf')

  const words = await launched(w, `Mira esto\n\n${one.ref}`)
  const second = await w.engine.summary(words)
  assert.equal(second.kind === 'ok' ? second.summary.prompt : '', 'Mira esto')

  // The log keeps the whole text: it is what the agent was sent.
  const page = await w.engine.read(words, 0)
  const said = 'kind' in page ? [] : page.events.filter((e) => e.kind === 'message' && e.role === 'user')
  assert.ok(said.some((e) => e.kind === 'message' && e.text.includes(one.ref)))
})

test('the search neither finds a conversation by its references nor shows them in a snippet (criterion 32)', async () => {
  const w = await world()
  const one = await uploadOnDisk(w.uploadsRoot, 'captura.png')
  await launched(w, `quick marathon plan\n\n${one.ref}`)

  assert.deepEqual(await w.engine.search('uploads'), [])
  const hits = await w.engine.search('marathon')
  assert.equal(hits.length, 1)
  assert.doesNotMatch(hits[0]?.snippet ?? '', /uploads|@\//)
})

test('the titler gets the words without the paths, and is not started for files alone (criterion 35)', async () => {
  const w = await world({ titles: TITLES_ON })
  const one = await uploadOnDisk(w.uploadsRoot, 'captura.png')
  const calls = async () => {
    try {
      return (await readFile(join(sessionPaths(w.stateDir).titler, 'titler-calls.log'), 'utf8'))
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => (JSON.parse(line) as { owner: string }).owner)
    } catch {
      return []
    }
  }

  await launched(w, one.ref)
  // A NEGATIVE: there is nothing to poll for, so this waits a margin well past what the titler takes
  // to write its log line (under 20 ms with the fake) — the one fixed delay here, on purpose.
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.deepEqual(await calls(), [], 'files alone: no titler')

  await launched(w, `title:ok Mira esto\n\n${one.ref}`)
  const deadline = Date.now() + 10_000
  while ((await calls()).length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  const [owner] = await calls()
  assert.ok(owner !== undefined && owner.startsWith('title:ok Mira esto'), owner)
  assert.doesNotMatch(owner, /uploads/)
})

// ---------------------------------------------------------------------------
// The gate (criterion 19)
// ---------------------------------------------------------------------------

test('a Read of an upload, outside the project, is allowed by the gate', async () => {
  const w = await world()
  const one = await uploadOnDisk(w.uploadsRoot)
  const result = await w.engine.launch({ siteId: 'work', entryId: 'free', text: 'linger', force: false })
  const id = result.outcome === 'started' ? result.sessionId : ''
  try {
    const decision = await w.engine.decide({
      hook_event_name: 'PreToolUse',
      session_id: id,
      tool_name: 'Read',
      tool_input: { file_path: one.path },
      tool_use_id: 'toolu_1',
      cwd: w.siteDir,
    })
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'allow')
  } finally {
    await w.engine.cancel(id)
  }
})

test('keeping an upload touches no session and no lock (criterion 3)', async () => {
  const w = await world({ seed: async (store) => void (await conversation(store, 'work', [{ kind: 'message', role: 'user', text: 'x' }])) })
  const paths = sessionPaths(w.stateDir)
  const snapshot = async () => {
    const out: string[] = []
    for (const dir of [paths.sessions, paths.locks]) {
      for (const name of await readdir(dir)) out.push(`${name}:${(await stat(join(dir, name))).mtimeMs}`)
      out.push(`${dir}:${(await stat(dir)).mtimeMs}`)
    }
    return out.sort()
  }
  const before = await snapshot()
  const incoming = join(w.stateDir, '.incoming')
  await mkdir(incoming, { recursive: true })
  await writeFile(join(incoming, 'y.part'), PNG)
  const result = await w.engine.upload({ path: join(incoming, 'y.part'), bytes: PNG.length }, 'y.png')
  assert.equal(result.outcome, 'ok')
  assert.deepEqual(await snapshot(), before)
})
