import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isInvokableName } from './catalog.ts'
import { announcedOf, createAnnounced, MAX_ANNOUNCED } from './announced.ts'

/** The `init` line of the real CLI 2.1.288, trimmed to the keys this reads (spec 2026-10-03, §0.1). */
const REAL_INIT: unknown = JSON.parse(await readFile(new URL('../test/fixtures/init-2.1.288.json', import.meta.url), 'utf8'))

const AT = '2026-10-04T10:00:00.000Z'
const LATER = '2026-10-04T11:00:00.000Z'

const names = (count: number): string[] => Array.from({ length: count }, (_, index) => `skill-${index}`)

// ---------------------------------------------------------------------------
// announcedOf — pure
// ---------------------------------------------------------------------------

test('the real init line gives its skills, agents and version', () => {
  const result = announcedOf(REAL_INIT, AT)
  const line = REAL_INIT as { skills: string[]; agents: string[]; claude_code_version: string }

  assert.ok(result)
  assert.deepEqual(result.announced.skills, line.skills)
  assert.deepEqual(result.announced.agents, line.agents)
  assert.equal(result.announced.version, line.claude_code_version)
  assert.equal(result.announced.since, AT)
  // The real list holds one CLI internal, `__remote-workflow`: skipped silently, not a drop.
  assert.equal(result.dropped, 0)
})

test('commands are slash_commands minus skills minus terminal_slash_commands', () => {
  const result = announcedOf(
    { skills: ['s1'], agents: [], slash_commands: ['s1', 'subir', 'clear', 'doctor'], terminal_slash_commands: ['doctor'] },
    AT,
  )
  assert.deepEqual(result?.announced.commands, ['subir', 'clear'])
})

test('the real init has commands that are neither skills nor terminal ones', () => {
  const result = announcedOf(REAL_INIT, AT)
  const line = REAL_INIT as { skills: string[]; slash_commands: string[]; terminal_slash_commands: string[] }
  const expected = line.slash_commands.filter(
    (name) => !line.skills.includes(name) && !line.terminal_slash_commands.includes(name) && isInvokableName(name),
  )

  assert.deepEqual(result?.announced.commands, expected)
  assert.ok(expected.length > 0)
})

test('skills absent gives undefined, so a good list is never overwritten by an empty one', () => {
  assert.equal(announcedOf({ agents: ['a'] }, AT), undefined)
})

test('agents that is not an array gives undefined', () => {
  assert.equal(announcedOf({ skills: ['s'], agents: 'a' }, AT), undefined)
})

test('a line that is not an object gives undefined', () => {
  assert.equal(announcedOf(null, AT), undefined)
  assert.equal(announcedOf('init', AT), undefined)
})

test('a name with a space is dropped and counted; the rest of the list stands', () => {
  const result = announcedOf({ skills: ['good', 'two words'], agents: [] }, AT)
  assert.deepEqual(result?.announced.skills, ['good'])
  assert.equal(result?.dropped, 1)
})

test('a name that is not a string is dropped and counted', () => {
  const result = announcedOf({ skills: ['good', 7, null], agents: [] }, AT)
  assert.deepEqual(result?.announced.skills, ['good'])
  assert.equal(result?.dropped, 2)
})

test('a name starting with __ is skipped silently while a genuinely bad one still counts', () => {
  const result = announcedOf({ skills: ['good', '__x', 'a b'], agents: ['__y'], slash_commands: ['good', '__z', 'clear'] }, AT)
  assert.deepEqual(result?.announced.skills, ['good'])
  assert.deepEqual(result?.announced.agents, [])
  assert.deepEqual(result?.announced.commands, ['clear'])
  assert.equal(result?.dropped, 1)
})

test('a bad name that is in skills and in slash_commands is counted once', () => {
  const result = announcedOf({ skills: ['a b'], agents: [], slash_commands: ['a b'] }, AT)
  assert.equal(result?.dropped, 1)
})

test('1200 names are cut at 1000 and the cut ones count as dropped', () => {
  const result = announcedOf({ skills: names(1_200), agents: [] }, AT)
  assert.equal(result?.announced.skills.length, MAX_ANNOUNCED)
  assert.equal(result?.announced.skills[0], 'skill-0')
  assert.equal(result?.dropped, 200)
})

test('duplicates are removed keeping the order, and they are not dropped', () => {
  const result = announcedOf({ skills: ['b', 'a', 'b'], agents: [] }, AT)
  assert.deepEqual(result?.announced.skills, ['b', 'a'])
  assert.equal(result?.dropped, 0)
})

test('a version that is not a string is undefined', () => {
  assert.equal(announcedOf({ skills: [], agents: [], claude_code_version: 3 }, AT)?.announced.version, undefined)
})

test('absent slash_commands give no commands', () => {
  assert.deepEqual(announcedOf({ skills: ['s'], agents: [] }, AT)?.announced.commands, [])
})

// ---------------------------------------------------------------------------
// createAnnounced — the store
// ---------------------------------------------------------------------------

async function setup(clock: { at: string } = { at: AT }) {
  const dir = await mkdtemp(join(tmpdir(), 'factotum-announced-'))
  const file = join(dir, 'announced.json')
  const warnings: string[] = []
  const log = { info: () => undefined, warn: (message: string) => void warnings.push(message), error: () => undefined }
  const store = createAnnounced({ file, log, now: () => new Date(clock.at) })
  return { dir, file, warnings, log, clock, store }
}

/** The writes are chained and never awaited by the turn, so a test waits until what it expects is there. */
async function settle(done?: () => Promise<boolean>): Promise<void> {
  // With no condition (a stubbed write that touches no disk) a few ticks are all the chain needs.
  for (let tick = 0; tick < (done === undefined ? 5 : 100); tick += 1) {
    if (done !== undefined && (await done())) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const savedSkills = async (file: string): Promise<string[] | undefined> => {
  try {
    return (JSON.parse(await readFile(file, 'utf8')) as { skills: string[] }).skills
  } catch {
    return undefined
  }
}

const LINE = { skills: ['s1'], agents: ['a1'], slash_commands: ['s1', 'clear'], terminal_slash_commands: [], claude_code_version: '2.1.288' }

test('a first init is kept in memory and written to the file', async () => {
  const { store, file } = await setup()
  store.take(LINE)

  assert.deepEqual(store.get()?.skills, ['s1'])
  await settle(async () => (await savedSkills(file)) !== undefined)
  const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  assert.deepEqual(saved, { skills: ['s1'], agents: ['a1'], commands: ['clear'], version: '2.1.288', since: AT })
})

test('two takes of the same list write once and keep the first since (criterion 1)', async () => {
  const clock = { at: AT }
  const writes: string[] = []
  const dir = await mkdtemp(join(tmpdir(), 'factotum-announced-'))
  const store = createAnnounced({
    file: join(dir, 'announced.json'),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date(clock.at),
    write: async (_file, text) => void writes.push(text),
  })

  store.take(LINE)
  clock.at = LATER
  store.take(LINE)
  await settle()

  assert.equal(writes.length, 1)
  assert.equal(store.get()?.since, AT)
})

test('a changed list is written again, with a new since', async () => {
  const { store, file, clock } = await setup()
  store.take(LINE)
  clock.at = LATER
  store.take({ ...LINE, skills: ['s1', 's2'] })
  await settle(async () => (await savedSkills(file))?.length === 2)

  assert.equal(store.get()?.since, LATER)
  assert.deepEqual((JSON.parse(await readFile(file, 'utf8')) as { skills: string[] }).skills, ['s1', 's2'])
})

test('a changed version alone is written again', async () => {
  const { store, clock } = await setup()
  store.take(LINE)
  clock.at = LATER
  store.take({ ...LINE, claude_code_version: '2.1.999' })

  assert.equal(store.get()?.version, '2.1.999')
  assert.equal(store.get()?.since, LATER)
})

test('an init without the lists changes nothing', async () => {
  const { store } = await setup()
  store.take(LINE)
  store.take({ type: 'system', subtype: 'init' })

  assert.deepEqual(store.get()?.skills, ['s1'])
})

test('load restores what a previous process wrote', async () => {
  const first = await setup()
  first.store.take(LINE)
  await settle(async () => (await savedSkills(first.file)) !== undefined)

  const second = createAnnounced({ file: first.file, log: first.log, now: () => new Date(LATER) })
  await second.load()

  assert.deepEqual(second.get(), first.store.get())
})

test('load with no file is undefined and silent', async () => {
  const { store, warnings } = await setup()
  await store.load()

  assert.equal(store.get(), undefined)
  assert.deepEqual(warnings, [])
})

test('a broken file at load is undefined and one warning, never a throw', async () => {
  const { store, file, warnings } = await setup()
  await writeFile(file, '{ not json', 'utf8')
  await store.load()

  assert.equal(store.get(), undefined)
  assert.equal(warnings.length, 1)
})

test('a file of the wrong shape at load is undefined and one warning', async () => {
  const { store, file, warnings } = await setup()
  await writeFile(file, JSON.stringify({ skills: 'nope' }), 'utf8')
  await store.load()

  assert.equal(store.get(), undefined)
  assert.equal(warnings.length, 1)
})

test('a dropped name warns once per process, however many sessions report it', async () => {
  const { store, warnings } = await setup()
  store.take({ ...LINE, skills: ['s1', 'bad name'] })
  store.take({ ...LINE, skills: ['s1', 'bad name', 's2'] })

  assert.equal(warnings.length, 1)
})

test('a list with nothing dropped does not warn', async () => {
  const { store, warnings } = await setup()
  store.take(LINE)
  assert.deepEqual(warnings, [])
})

test('a write that fails is a warning, and the list stays in memory', async () => {
  const warnings: string[] = []
  const store = createAnnounced({
    file: '/nowhere/announced.json',
    log: { info: () => undefined, warn: (message: string) => void warnings.push(message), error: () => undefined },
    now: () => new Date(AT),
    write: async () => {
      throw new Error('disk full')
    },
  })
  store.take(LINE)
  await settle()

  assert.equal(warnings.length, 1)
  assert.deepEqual(store.get()?.skills, ['s1'])
})
