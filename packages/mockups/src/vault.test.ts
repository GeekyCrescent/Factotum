import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { DOC_MAX_BYTES } from './shape.ts'
import { createMockupDir, createProject, listProjects, pascalName, readDocs, splitFrontmatter, updateMap, versionDocs } from './vault.ts'

let root: string
let projectsDir: string
let workRoot: string
let home: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mockups-vault-')))
  home = root
  projectsDir = join(root, 'Obsidian', '01-projects')
  workRoot = join(root, 'Work')
  await mkdir(projectsDir, { recursive: true })
  await mkdir(workRoot, { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The shape of `06-maps/day-job/day-job.md` (tasks §M): bullets that wrap, `related:` on one line. */
const MAP = `---
title: day-job
type: map
domain: day-job
status: active
created: 2026-06-04
tags: []
related: ["[[home]]", "[[alpha]]", "[[beta]]"]
---

# day-job

## Active projects
- [[alpha]] — a portal for a hospital. **Fase: diseño.**
- [[beta]] — a bot that books x-rays, over
  a cloud provider. **Fase: propuesta.**

## Courses
- [[course]] — something
`

const NEW = { slug: 'acme-portal', title: 'Acme Portal', client: 'Acme Salud', summary: 'Un portal de resultados.', difficulty: 'medium' as const }

async function hub(slug: string, frontmatter: string): Promise<void> {
  await mkdir(join(projectsDir, slug), { recursive: true })
  await writeFile(join(projectsDir, slug, `${slug}.md`), `---\n${frontmatter}\n---\n\n# ${slug}\n`)
}

test('splitFrontmatter: the keys as strings and the body after the fence', () => {
  const split = splitFrontmatter('---\ntitle: A: B\nwork-dir: ~/x\ntags: [a, b]\n---\n\n# Body\n')
  assert.deepEqual(split.frontmatter, { title: 'A: B', 'work-dir': '~/x', tags: '[a, b]' })
  assert.equal(split.markdown, '\n# Body\n')
  assert.deepEqual(splitFrontmatter('# no fence\n'), { frontmatter: {}, markdown: '# no fence\n' })
  assert.deepEqual(splitFrontmatter('---\nkey: v\nno end'), { frontmatter: {}, markdown: '---\nkey: v\nno end' })
})

test('crit. 6: projects are folders with <slug>/<slug>.md; work-dir with ~ is expanded and real', async () => {
  await mkdir(join(workRoot, 'Alpha'))
  await hub('alpha', 'title: Alpha portal\nwork-dir: ~/Work/Alpha')
  await hub('beta', 'title: Beta')
  await mkdir(join(projectsDir, 'loose'))
  await writeFile(join(projectsDir, 'README.md'), 'x')
  const projects = await listProjects(projectsDir, home)
  assert.deepEqual(projects, [
    { slug: 'alpha', title: 'Alpha portal', workDir: join(workRoot, 'Alpha') },
    { slug: 'beta', title: 'Beta', workDir: null },
  ])
})

test('a hub whose work-dir is ~other is listed without one', async () => {
  await hub('gamma', 'title: Gamma\nwork-dir: ~other/x')
  assert.deepEqual(await listProjects(projectsDir, home), [{ slug: 'gamma', title: 'Gamma', workDir: null }])
})

test('pascalName: words of the title, capitalised, accents and symbols out', () => {
  assert.equal(pascalName('Medical Trust Center'), 'MedicalTrustCenter')
  assert.equal(pascalName('alta GMM — maqueta'), 'AltaGMMMaqueta')
  assert.equal(pascalName('Clínica Ángeles'), 'ClinicaAngeles')
})

test('crit. 6: a new project gets its work-dir, its hub with the full frontmatter, and a line in the map', async () => {
  const mapFile = join(root, 'day-job.md')
  await writeFile(mapFile, MAP)
  await chmod(mapFile, 0o644)
  const created = await createProject({ projectsDir, workRoot, mapFile, home, today: '2026-11-12', ...NEW })
  assert.ok(created.ok, created.ok ? '' : created.error.reason)
  assert.equal(created.value.workDir, join(workRoot, 'AcmePortal'))
  assert.equal(created.value.mapWarning, undefined)
  assert.ok((await stat(join(workRoot, 'AcmePortal'))).isDirectory())

  const text = await readFile(join(projectsDir, 'acme-portal', 'acme-portal.md'), 'utf8')
  const { frontmatter, markdown } = splitFrontmatter(text)
  assert.deepEqual(frontmatter, {
    title: 'Acme Portal',
    type: 'project',
    domain: 'day-job',
    source: 'day-job',
    status: 'active',
    difficulty: 'medium',
    created: '2026-11-12',
    estado: '2026-11-12',
    'work-dir': '~/Work/AcmePortal',
    started: '2026-11-12',
    due: '',
    completed: '',
    tags: '[acme-salud, bwr]',
    related: '["[[day-job]]"]',
  })
  assert.match(markdown, /^\n# Acme Portal\n\nUn portal de resultados\. BWR es proveedor de Acme Salud\.\n/)
  assert.match(markdown, /> \[!info\] Estado — 2026-11-12\n> \*\*Lo último:\*\* Proyecto creado desde Factotum para la maqueta\.\n/)
  assert.match(markdown, /> \*\*Dónde retomo:\*\* Aprobar el brief de la maqueta\.\n> \*\*Bloqueado por:\*\* nada\.\n/)
  assert.match(markdown, /## Próximos pasos\n\n- \[ \] Aprobar el brief de la maqueta\n$/)

  const map = await readFile(mapFile, 'utf8')
  assert.match(map, /related: \["\[\[home\]\]", "\[\[alpha\]\]", "\[\[beta\]\]", "\[\[acme-portal\]\]"\]\n/)
  assert.match(map, /  a cloud provider\. \*\*Fase: propuesta\.\*\*\n- \[\[acme-portal\]\] — Un portal de resultados\.\n\n## Courses/)
  assert.equal((await stat(mapFile)).mode & 0o777, 0o644)
})

test('a due date goes in the hub and in the map line', async () => {
  const mapFile = join(root, 'day-job.md')
  await writeFile(mapFile, MAP)
  const created = await createProject({ projectsDir, workRoot, mapFile, home, today: '2026-11-12', ...NEW, due: '2026-12-01' })
  assert.ok(created.ok)
  assert.match(await readFile(join(projectsDir, 'acme-portal', 'acme-portal.md'), 'utf8'), /\ndue: 2026-12-01\n/)
  assert.match(await readFile(mapFile, 'utf8'), /- \[\[acme-portal\]\] — Un portal de resultados\. \*\*Entrega 2026-12-01\.\*\*\n/)
})

test('crit. 6b: without mapFile the project is created and the answer says the map was not updated', async () => {
  const created = await createProject({ projectsDir, workRoot, home, today: '2026-11-12', ...NEW })
  assert.ok(created.ok)
  assert.match(created.value.mapWarning ?? '', /^map not updated: no mapFile/)
})

test('crit. 6b: a map without ## Active projects is not touched, and says so', async () => {
  const mapFile = join(root, 'day-job.md')
  const other = MAP.replace('## Active projects', '## Proyectos')
  await writeFile(mapFile, other)
  const created = await createProject({ projectsDir, workRoot, mapFile, home, today: '2026-11-12', ...NEW })
  assert.ok(created.ok)
  assert.match(created.value.mapWarning ?? '', /^map not updated: .*## Active projects/)
  assert.equal(await readFile(mapFile, 'utf8'), other)
})

test('crit. 6b: a related: that is not an array on one line leaves the map as it was', async () => {
  const mapFile = join(root, 'day-job.md')
  const other = MAP.replace(/related: .*\n/, 'related:\n  - "[[home]]"\n')
  await writeFile(mapFile, other)
  const created = await createProject({ projectsDir, workRoot, mapFile, home, today: '2026-11-12', ...NEW })
  assert.ok(created.ok)
  assert.match(created.value.mapWarning ?? '', /related/)
  assert.equal(await readFile(mapFile, 'utf8'), other)
})

test('a map that cannot be read is a warning, never a failure', async () => {
  const created = await createProject({ projectsDir, workRoot, mapFile: join(root, 'missing.md'), home, today: '2026-11-12', ...NEW })
  assert.ok(created.ok)
  assert.match(created.value.mapWarning ?? '', /could not be read/)
})

test('updateMap with an empty related: array', () => {
  const updated = updateMap(MAP.replace(/related: .*\n/, 'related: []\n'), 'x', 'X.', undefined)
  assert.ok(updated.ok)
  assert.match(updated.text, /related: \["\[\[x\]\]"\]\n/)
})

test('updateMap puts the line at the end of the section even when it is the last one', () => {
  const updated = updateMap(MAP.replace(/\n## Courses[\s\S]*$/, '\n'), 'x', 'X.', undefined)
  assert.ok(updated.ok)
  assert.match(updated.text, /\*\*Fase: propuesta\.\*\*\n- \[\[x\]\] — X\.\n\n$/)
})

test('crit. 6: a new project whose folder or work-dir exists is a conflict, and nothing is written', async () => {
  await mkdir(join(projectsDir, 'acme-portal'))
  const first = await createProject({ projectsDir, workRoot, home, today: '2026-11-12', ...NEW })
  assert.equal(first.ok ? 'ok' : first.error.code, 'conflict')
  await rm(join(projectsDir, 'acme-portal'), { recursive: true })
  await mkdir(join(workRoot, 'AcmePortal'))
  const second = await createProject({ projectsDir, workRoot, home, today: '2026-11-12', ...NEW })
  assert.equal(second.ok ? 'ok' : second.error.code, 'conflict')
  assert.deepEqual(await readdir(projectsDir), [])
})

test('the work-dir outside the home folder is written as an absolute path', async () => {
  const created = await createProject({ projectsDir, workRoot, home: '/nowhere', today: '2026-11-12', ...NEW })
  assert.ok(created.ok)
  assert.match(await readFile(join(projectsDir, 'acme-portal', 'acme-portal.md'), 'utf8'), new RegExp(`\nwork-dir: ${join(workRoot, 'AcmePortal')}\n`))
})

test('the mockup folder is <project>/mockup, or mockup-2… when it exists', async () => {
  const project = join(projectsDir, 'alpha')
  await mkdir(project)
  assert.equal(await createMockupDir(project), join(project, 'mockup'))
  assert.equal(await createMockupDir(project), join(project, 'mockup-2'))
  assert.equal(await createMockupDir(project), join(project, 'mockup-3'))
})

test('crit. 29: versioning copies each document to _versions/<name>-v<k>.md, once', async () => {
  const vaultDir = join(root, 'mockup')
  await mkdir(vaultDir)
  await writeFile(join(vaultDir, '01-brief.md'), 'first')
  assert.deepEqual(await versionDocs(vaultDir, ['01-brief.md', 'absent.md'], 1), ['_versions/01-brief-v1.md'])
  assert.equal(await readFile(join(vaultDir, '_versions', '01-brief-v1.md'), 'utf8'), 'first')
  assert.equal(await readFile(join(vaultDir, '01-brief.md'), 'utf8'), 'first')
  assert.deepEqual(await versionDocs(vaultDir, ['01-brief.md'], 1), ['_versions/01-brief-v1.md'])
  assert.deepEqual(await readdir(join(vaultDir, '_versions')), ['01-brief-v1.md'])
  await writeFile(join(vaultDir, '01-brief.md'), 'second')
  await versionDocs(vaultDir, ['01-brief.md'], 2)
  assert.deepEqual((await readdir(join(vaultDir, '_versions'))).sort(), ['01-brief-v1.md', '01-brief-v2.md'])
})

test('versioning never overwrites a different version of the same number', async () => {
  const vaultDir = join(root, 'mockup')
  await mkdir(join(vaultDir, '_versions'), { recursive: true })
  await writeFile(join(vaultDir, '_versions', '01-brief-v1.md'), 'older')
  await writeFile(join(vaultDir, '01-brief.md'), 'newer')
  assert.deepEqual(await versionDocs(vaultDir, ['01-brief.md'], 1), ['_versions/01-brief-v1-2.md'])
  assert.equal(await readFile(join(vaultDir, '_versions', '01-brief-v1.md'), 'utf8'), 'older')
})

test('crit. 25: reading the documents of a stage: frontmatter as keys, markdown, mtime; missing ones left out', async () => {
  const vaultDir = join(root, 'mockup')
  await mkdir(vaultDir)
  await writeFile(join(vaultDir, '01-brief.md'), '---\nstage: brief\n---\n# Brief\n')
  const read = await readDocs(vaultDir, ['01-brief.md', '02-concepts.md'])
  assert.ok(read.ok)
  assert.equal(read.value.length, 1)
  assert.equal(read.value[0]?.name, '01-brief.md')
  assert.deepEqual(read.value[0]?.frontmatter, { stage: 'brief' })
  assert.equal(read.value[0]?.markdown, '# Brief\n')
  assert.match(read.value[0]?.mtime ?? '', /^\d{4}-\d\d-\d\dT/)
})

test('documents over DOC_MAX_BYTES are a too-large with the name of the file', async () => {
  const vaultDir = join(root, 'mockup')
  await mkdir(vaultDir)
  await writeFile(join(vaultDir, '01-brief.md'), 'x'.repeat(DOC_MAX_BYTES + 1))
  const read = await readDocs(vaultDir, ['01-brief.md'])
  assert.deepEqual(read.ok ? null : read.error, { code: 'too-large', reason: '01-brief.md is over 1 MiB' })
})
