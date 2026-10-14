import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliDirName, cliDirOf, findTranscript, findTranscripts, transcriptFiles } from './cli-paths.ts'

const ID = '0199e0c0-0000-7000-8000-0000000000c1'

test('cliDirName: every character outside [A-Za-z0-9] becomes a dash — the rule A4 measured on both machines', () => {
  assert.equal(cliDirName('/private/tmp/a4 prueba/carpeta_con.punto'), '-private-tmp-a4-prueba-carpeta-con-punto')
  assert.equal(cliDirName('/home/ferro/a4 prueba/carpeta_con.punto'), '-home-ferro-a4-prueba-carpeta-con-punto')
  assert.equal(cliDirName('/Users/ferro/Ferro/Personal/Factotum'), '-Users-ferro-Ferro-Personal-Factotum')
})

test('cliDirOf works on the REAL path: a symlinked folder is named after where it points', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'factotum-cli-')))
  await mkdir(join(root, 'real dir'))
  await symlink(join(root, 'real dir'), join(root, 'link'))
  assert.equal(await cliDirOf(join(root, 'link')), cliDirName(join(root, 'real dir')))
})

async function projectsRoot() {
  return await mkdtemp(join(tmpdir(), 'factotum-claude-projects-'))
}

test('the transcript is SEARCHED in every folder, as the CLI does; with two copies the most recent wins', async () => {
  const root = await projectsRoot()
  await mkdir(join(root, '-old-path'), { recursive: true })
  await mkdir(join(root, '-new-path', ID, 'tool-results'), { recursive: true })
  await writeFile(join(root, '-old-path', `${ID}.jsonl`), 'old\n')
  await writeFile(join(root, '-new-path', `${ID}.jsonl`), 'new\n')
  await writeFile(join(root, '-new-path', ID, 'tool-results', 'r1.txt'), 'result')
  const past = new Date(Date.now() - 60_000)
  await utimes(join(root, '-old-path', `${ID}.jsonl`), past, past)

  const found = await findTranscript(root, ID)
  assert.equal(found?.file, join(root, '-new-path', `${ID}.jsonl`))
  assert.equal(found?.dir, join(root, '-new-path', ID))
  assert.equal((await findTranscripts(root, ID)).length, 2)
})

test('no transcript anywhere is undefined; a missing projects folder too', async () => {
  assert.equal(await findTranscript(await projectsRoot(), ID), undefined)
  assert.equal(await findTranscript(join(tmpdir(), 'factotum-no-such-dir-x'), ID), undefined)
})

test('transcriptFiles lists the jsonl and every file of its folder, with sizes and relative names, and follows no link', async () => {
  const root = await projectsRoot()
  const dir = join(root, '-p', ID)
  await mkdir(join(dir, 'subagents'), { recursive: true })
  await writeFile(join(root, '-p', `${ID}.jsonl`), '12345')
  await writeFile(join(dir, 'subagents', 'agent-1.jsonl'), 'ab')
  await symlink('/etc/hosts', join(dir, 'subagents', 'escape'))
  const found = await findTranscript(root, ID)
  const files = await transcriptFiles(found!)
  assert.deepEqual(
    files.map(({ rel, bytes }) => ({ rel, bytes })).sort((a, b) => a.rel.localeCompare(b.rel)),
    [
      { rel: `${ID}.jsonl`, bytes: 5 },
      { rel: `${ID}/subagents/agent-1.jsonl`, bytes: 2 },
    ],
  )
})
