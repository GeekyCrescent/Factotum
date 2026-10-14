import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { uuidv7 } from '../id.ts'
import { buildManifest, HANDOFF_MANIFEST_MAX_ENTRIES, validateManifest, type ManifestEntry } from './manifest.ts'
import type { LocalFile } from './files.ts'

const S1 = uuidv7(1)
const S2 = uuidv7(2)
const UP = uuidv7(3)
const SHA = 'a'.repeat(64)

function entry(over: Partial<ManifestEntry> & Pick<ManifestEntry, 'n' | 'kind' | 'rel'>): ManifestEntry {
  return { sessionId: S1, bytes: 1, sha256: SHA, ...over }
}

/** A whole, valid manifest for one session, with the bundle first. */
function valid(): ManifestEntry[] {
  return [
    { n: 0, kind: 'git-bundle', rel: 'code.bundle', bytes: 10, sha256: SHA },
    entry({ n: 1, kind: 'meta', rel: 'session/meta.json' }),
    entry({ n: 2, kind: 'events', rel: 'session/events.jsonl' }),
    entry({ n: 3, kind: 'upload', rel: `uploads/${UP}/photo.jpg` }),
    entry({ n: 4, kind: 'transcript', rel: `cli/${S1}.jsonl` }),
    entry({ n: 5, kind: 'transcript-dir-file', rel: `cli/${S1}/tool-results/r1.txt` }),
  ]
}

const check = (manifest: unknown, ids: readonly string[] = [S1, S2]) => validateManifest(manifest, ids, 256 * 1024 * 1024)

test('a whole manifest passes, and comes back typed', () => {
  const result = check(valid())
  assert.equal(result.ok, true)
  assert.equal(result.ok ? result.entries.length : 0, 6)
})

const refused: [string, (m: ManifestEntry[]) => unknown][] = [
  ['not an array', () => ({ entries: [] })],
  ['a kind outside the closed list', (m) => [...m.slice(0, 5), { ...m[5], kind: 'settings' }]],
  ['a session id that is not one', (m) => m.map((e) => (e.sessionId === S1 ? { ...e, sessionId: '../../x' } : e))],
  ['a session that prepare did not bring (v4.2)', (m) => m.map((e) => (e.sessionId === S1 ? { ...e, sessionId: uuidv7(99) } : e))],
  ['a session with no meta', (m) => m.filter((e) => e.kind !== 'meta').map((e, n) => ({ ...e, n }))],
  ['a session with two events', (m) => [...m, entry({ n: 6, kind: 'events', rel: 'session/events.jsonl' })]],
  ['a meta whose rel is not session/meta.json', (m) => m.map((e) => (e.kind === 'meta' ? { ...e, rel: 'meta.json' } : e))],
  ['an upload id that is not one', (m) => m.map((e) => (e.kind === 'upload' ? { ...e, rel: 'uploads/x/photo.jpg' } : e))],
  ['an upload name sanitizeName would change', (m) => m.map((e) => (e.kind === 'upload' ? { ...e, rel: `uploads/${UP}/../../evil` } : e))],
  ['a transcript of another session', (m) => m.map((e) => (e.kind === 'transcript' ? { ...e, rel: `cli/${S2}.jsonl` } : e))],
  ['a transcript-dir-file with a .. segment', (m) => m.map((e) => (e.kind === 'transcript-dir-file' ? { ...e, rel: `cli/${S1}/../../x` } : e))],
  ['a transcript-dir-file with an empty segment', (m) => m.map((e) => (e.kind === 'transcript-dir-file' ? { ...e, rel: `cli/${S1}//x` } : e))],
  ['a transcript-dir-file with a backslash', (m) => m.map((e) => (e.kind === 'transcript-dir-file' ? { ...e, rel: `cli/${S1}/a\\b` } : e))],
  ['a transcript-dir-file with a NUL', (m) => m.map((e) => (e.kind === 'transcript-dir-file' ? { ...e, rel: `cli/${S1}/a\u0000b` } : e))],
  ['a git-bundle with a session', (m) => m.map((e) => (e.kind === 'git-bundle' ? { ...e, sessionId: S1 } : e))],
  ['a git-bundle that is not code.bundle', (m) => m.map((e) => (e.kind === 'git-bundle' ? { ...e, rel: 'other.bundle' } : e))],
  ['two git-bundles', (m) => [...m, { n: 6, kind: 'git-bundle', rel: 'code.bundle', bytes: 1, sha256: SHA }]],
  ['a repeated n', (m) => m.map((e) => (e.n === 5 ? { ...e, n: 4 } : e))],
  ['an n out of 0…k−1', (m) => m.map((e) => (e.n === 5 ? { ...e, n: 9 } : e))],
  ['a repeated destination', (m) => [...m, entry({ n: 6, kind: 'transcript-dir-file', rel: `cli/${S1}/tool-results/r1.txt` })]],
  ['bytes over the ceiling', (m) => m.map((e) => (e.kind === 'upload' ? { ...e, bytes: 256 * 1024 * 1024 + 1 } : e))],
  ['negative bytes', (m) => m.map((e) => (e.kind === 'upload' ? { ...e, bytes: -1 } : e))],
  ['a sha256 that is not 64 hex', (m) => m.map((e) => (e.kind === 'upload' ? { ...e, sha256: 'xyz' } : e))],
]

for (const [what, spoil] of refused) {
  test(`refused, without writing anything: ${what} (criterion 30d)`, () => {
    assert.equal(check(spoil(valid())).ok, false)
  })
}

test(`more than HANDOFF_MANIFEST_MAX_ENTRIES entries is refused: the body would not fit in MAX_BODY_BYTES`, () => {
  const many: ManifestEntry[] = [entry({ n: 0, kind: 'meta', rel: 'session/meta.json' }), entry({ n: 1, kind: 'events', rel: 'session/events.jsonl' })]
  for (let n = 2; n <= HANDOFF_MANIFEST_MAX_ENTRIES; n += 1) many.push(entry({ n, kind: 'transcript-dir-file', rel: `cli/${S1}/tool-results/r${n}.txt` }))
  assert.equal(many.length, HANDOFF_MANIFEST_MAX_ENTRIES + 1)
  assert.equal(check(many).ok, false)
  assert.equal(check(many.slice(0, HANDOFF_MANIFEST_MAX_ENTRIES)).ok, true)
})

test('buildManifest hashes every file in a stream, puts the bundle first (n = 0), and keeps where each one is', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'factotum-manifest-'))
  const write = async (name: string, text: string) => (await writeFile(join(dir, name), text), join(dir, name))
  const files: LocalFile[] = [
    { sessionId: S1, kind: 'meta', rel: 'session/meta.json', abs: await write('m', '{}'), bytes: 2 },
    { sessionId: S1, kind: 'events', rel: 'session/events.jsonl', abs: await write('e', 'line\n'), bytes: 5 },
  ]
  const bundle = await write('b', 'BUNDLE')
  const built = await buildManifest(files, { abs: bundle, bytes: 6 })
  assert.deepEqual(
    built.entries.map((e) => [e.n, e.kind, e.rel]),
    [
      [0, 'git-bundle', 'code.bundle'],
      [1, 'meta', 'session/meta.json'],
      [2, 'events', 'session/events.jsonl'],
    ],
  )
  assert.equal(built.entries[0]?.sha256, createHash('sha256').update('BUNDLE').digest('hex'))
  assert.equal(built.sources.get(2), files[1]?.abs)
  assert.equal('abs' in (built.entries[1] ?? {}), false, 'a path of this host never travels')
  assert.equal(check(built.entries).ok, true)
})

test('without a bundle the sessions start at n = 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'factotum-manifest-'))
  await writeFile(join(dir, 'm'), '{}')
  const built = await buildManifest([{ sessionId: S1, kind: 'meta', rel: 'session/meta.json', abs: join(dir, 'm'), bytes: 2 }], undefined)
  assert.equal(built.entries[0]?.n, 0)
})
