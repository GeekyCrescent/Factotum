/**
 * The vault side of a mockup (design D7): the projects, a new project's hub and map line, the mockup
 * folder, the versions before a redo, and reading the documents.
 *
 * WHAT THIS WRITES, and nothing else (requirements §5, «Rutas declaradas»): a new project's folder and
 * hub under `projectsDir`, its work-dir under `workRoot`, one line and one link in `mapFile`, the
 * mockup folder, the copies in `_versions/` (and in the work-dir's `directions/_versions/`), and
 * `chosen:` in a document's frontmatter (D6). Nothing
 * else of a document is written here: the sessions write them.
 *
 * THE MAP IS THE OWNER'S, not ours: if it does not have the shape this expects, it is left exactly as
 * it was and the answer says so (criterion 6b). It is written to a temporary file and renamed, keeping
 * its mode.
 */

import { cp, copyFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { expandHome, inside, real, underHome } from './paths.ts'
import { DOC_MAX_BYTES } from './shape.ts'
import { codeOf, writeAtomically } from './store/store.ts'
import type { DocFile, ProjectEntry, Result } from './types.ts'

const ACTIVE_SECTION = '## Active projects'
const VERSIONS = '_versions'

export interface Split {
  readonly frontmatter: Readonly<Record<string, string>>
  readonly markdown: string
}

/**
 * The `key: value` lines between a leading `---` and the next, as strings — an array stays the text
 * it is. Without both fences, there is no frontmatter and the whole text is the body.
 */
export function splitFrontmatter(text: string): Split {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return { frontmatter: {}, markdown: text }
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  if (end === -1) return { frontmatter: {}, markdown: text }
  const frontmatter: Record<string, string> = {}
  let last: string | undefined
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line)
    if (match !== null && match[1] !== undefined) {
      last = match[1]
      frontmatter[last] = (match[2] ?? '').trim()
    } else if (last !== undefined && line.trim() !== '') {
      frontmatter[last] = `${frontmatter[last] ?? ''}\n${line}`.trim()
    }
  }
  return { frontmatter, markdown: lines.slice(end + 1).join('\n') }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Folders of `projectsDir` with a `<folder>/<folder>.md`; `work-dir` expanded and real (crit. 6). */
export async function listProjects(projectsDir: string, home: string): Promise<readonly ProjectEntry[]> {
  const entries = await readdir(projectsDir, { withFileTypes: true })
  const projects: ProjectEntry[] = []
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    let text: string
    try {
      text = await readFile(join(projectsDir, entry.name, `${entry.name}.md`), 'utf8')
    } catch (error) {
      // A folder without a hub is not a project. A hub that cannot be read is a problem to say.
      if (codeOf(error) === 'ENOENT') continue
      throw error
    }
    const { frontmatter } = splitFrontmatter(text)
    const declared = frontmatter['work-dir']
    const expanded = declared === undefined || declared === '' ? null : expandHome(declared, home)
    projects.push({ slug: entry.name, title: frontmatter['title'] || entry.name, workDir: expanded === null ? null : await real(expanded) })
  }
  return projects
}

/** «Medical Trust Center» → `MedicalTrustCenter`: the work-dir's name, as the existing ones. */
export function pascalName(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '')
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join('')
}

const tagOf = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** One line, and quoted only if YAML would read it as something else. */
function scalar(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim()
  return /^[\s\-?:,[\]{}#&*!|>'"%@`]|: | #|:$/.test(line) ? JSON.stringify(line) : line
}

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim()

export interface NewProjectInput {
  readonly projectsDir: string
  readonly workRoot: string
  readonly mapFile?: string
  readonly home: string
  /** `YYYY-MM-DD`, the owner's day. */
  readonly today: string
  readonly slug: string
  readonly title: string
  readonly client: string
  readonly summary: string
  readonly difficulty: 'low' | 'medium' | 'high'
  readonly due?: string
}

/** The hub of `/nuevo-proyecto`, with the state block of «Where each project stands» (D7, step 3). */
function hubText(input: NewProjectInput, workDir: string): string {
  const summary = oneLine(input.summary)
  const sentence = /[.!?]$/.test(summary) ? summary : `${summary}.`
  return [
    '---',
    `title: ${scalar(input.title)}`,
    'type: project',
    'domain: day-job',
    'source: day-job',
    'status: active',
    `difficulty: ${input.difficulty}`,
    `created: ${input.today}`,
    `estado: ${input.today}`,
    `work-dir: ${underHome(workDir, input.home)}`,
    `started: ${input.today}`,
    `due:${input.due === undefined ? '' : ` ${input.due}`}`,
    'completed:',
    `tags: [${[tagOf(input.client), 'bwr'].filter((tag) => tag !== '').join(', ')}]`,
    'related: ["[[day-job]]"]',
    '---',
    '',
    `# ${oneLine(input.title)}`,
    '',
    `${sentence} BWR es proveedor de ${oneLine(input.client)}.`,
    '',
    `> [!info] Estado — ${input.today}`,
    '> **Lo último:** Proyecto creado desde Factotum para la maqueta.',
    '> **Dónde retomo:** Aprobar el brief de la maqueta.',
    '> **Bloqueado por:** nada.',
    '',
    '## Próximos pasos',
    '',
    '- [ ] Aprobar el brief de la maqueta',
    '',
  ].join('\n')
}

export type MapUpdate = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string }

/**
 * The map with `- [[slug]] — summary` at the END of `## Active projects` and `"[[slug]]"` in its
 * one-line `related:` array — or why not (criterion 6b). Pure.
 */
export function updateMap(text: string, slug: string, summary: string, due: string | undefined): MapUpdate {
  const lines = text.split('\n')
  const fence = lines[0]?.trim() === '---' ? lines.findIndex((line, i) => i > 0 && line.trim() === '---') : -1
  const relatedAt = lines.findIndex((line, i) => i > 0 && i < fence && /^related:/.test(line))
  const related = relatedAt === -1 ? null : /^related:\s*\[(.*)\]\s*$/.exec(lines[relatedAt] ?? '')
  if (fence === -1) return { ok: false, reason: 'it has no frontmatter' }
  if (related === null || related[1] === undefined) return { ok: false, reason: 'its related: is not an array on one line' }
  const start = lines.findIndex((line) => line.trim() === ACTIVE_SECTION)
  if (start === -1) return { ok: false, reason: `it has no ${ACTIVE_SECTION} section` }
  const next = lines.findIndex((line, i) => i > start && /^#{1,2} /.test(line))
  const end = next === -1 ? lines.length : next
  let last = end - 1
  while (last > start && (lines[last] ?? '').trim() === '') last--

  const items = related[1].trim()
  const link = `"[[${slug}]]"`
  const bullet = `- [[${slug}]] — ${oneLine(summary)}${due === undefined ? '' : ` **Entrega ${due}.**`}`
  const updated = [...lines]
  updated.splice(last + 1, 0, bullet)
  updated[relatedAt] = `related: [${items === '' ? link : `${items}, ${link}`}]`
  return { ok: true, text: updated.join('\n') }
}

/** One map write at a time in this process: two new projects never both start from the same map. */
let mapQueue: Promise<unknown> = Promise.resolve()

async function touchMap(input: NewProjectInput): Promise<string | undefined> {
  const mapFile = input.mapFile
  if (mapFile === undefined) return 'map not updated: no mapFile in the config'
  const write = async (): Promise<string | undefined> => {
    let target: string
    let text: string
    let mode: number
    try {
      // Through a link to the file it points at: the link stays a link.
      target = await realpath(mapFile)
      text = await readFile(target, 'utf8')
      mode = (await stat(target)).mode & 0o777
    } catch (error) {
      return `map not updated: it could not be read (${codeOf(error)})`
    }
    const updated = updateMap(text, input.slug, input.summary, input.due)
    if (!updated.ok) return `map not updated: ${updated.reason}`
    try {
      await writeAtomically(target, updated.text, mode)
    } catch (error) {
      return `map not updated: it could not be written (${codeOf(error)})`
    }
    return undefined
  }
  const next = mapQueue.then(write)
  mapQueue = next.catch(() => undefined)
  return await next
}

export interface NewProject {
  readonly projectDir: string
  readonly workDir: string
  readonly mapWarning?: string
}

/** D7, «Proyecto nuevo»: refuse what exists, then work-dir, hub, map. */
export async function createProject(input: NewProjectInput): Promise<Result<NewProject>> {
  const projectDir = join(input.projectsDir, input.slug)
  const name = pascalName(input.title) || pascalName(input.slug)
  const workDir = join(input.workRoot, name)
  if (await exists(projectDir)) return { ok: false, error: { code: 'conflict', reason: `the project ${input.slug} already exists` } }
  if (await exists(workDir)) return { ok: false, error: { code: 'conflict', reason: `the work folder ${name} already exists` } }
  try {
    await mkdir(workDir, { recursive: true })
    await mkdir(projectDir)
    await writeFile(join(projectDir, `${input.slug}.md`), hubText(input, workDir), { flag: 'wx' })
  } catch (error) {
    // Undone, so a retry is not refused for a half-made project. Both were checked absent above.
    await rm(projectDir, { recursive: true, force: true }).catch(() => undefined)
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: { code: 'module-error', reason: `the project could not be created (${codeOf(error)})` } }
  }
  const mapWarning = await touchMap(input)
  return { ok: true, value: { projectDir, workDir, ...(mapWarning === undefined ? {} : { mapWarning }) } }
}

/** `<project>/mockup`, or `mockup-2`, `mockup-3`… — created, so two calls never get the same one. */
export async function createMockupDir(projectDir: string): Promise<string> {
  for (let n = 1; ; n++) {
    const dir = join(projectDir, n === 1 ? 'mockup' : `mockup-${n}`)
    try {
      await mkdir(dir)
      return dir
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error
    }
  }
}

type Doc = { readonly kind: 'missing' } | { readonly kind: 'outside' } | { readonly kind: 'ok'; readonly path: string }

/**
 * A document of the mockup folder, by its REAL path: a link that leads out of the folder, or anything
 * that is not a plain file, is `outside` — read nor copied (a session can put a link there after its
 * submission was checked). Only "not there" is `missing`; any other error is thrown.
 */
async function docOf(vaultDir: string, name: string, caseInsensitive: boolean): Promise<Doc> {
  let path: string
  try {
    path = await realpath(join(vaultDir, name))
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return { kind: 'missing' }
    throw error
  }
  if (!inside(await realpath(vaultDir), path, caseInsensitive) || !(await stat(path)).isFile()) return { kind: 'outside' }
  return { kind: 'ok', path }
}

/**
 * Before a redo (criterion 29): COPY each document of the stage to `_versions/<name>-v<k>.md`. The
 * same content already there is not copied again; a different one is never overwritten. Returns the
 * versions, relative to `vaultDir`, that hold the documents now. A document that cannot be read
 * THROWS: a redo without its copy would let the new session overwrite the only one.
 */
export async function versionDocs(vaultDir: string, files: readonly string[], k: number, caseInsensitive: boolean): Promise<readonly string[]> {
  const kept: string[] = []
  for (const file of files) {
    const doc = await docOf(vaultDir, file, caseInsensitive)
    if (doc.kind === 'missing') continue
    if (doc.kind === 'outside') throw new Error(`${file} is outside the mockup folder or not a file`)
    const content = await readFile(doc.path, 'utf8')
    await mkdir(join(vaultDir, VERSIONS), { recursive: true })
    const stem = basename(file, extname(file))
    for (let n = 1; ; n++) {
      const name = `${stem}-v${k}${n === 1 ? '' : `-${n}`}${extname(file)}`
      const target = join(vaultDir, VERSIONS, name)
      let there: string | undefined
      try {
        there = await readFile(target, 'utf8')
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') throw error
        there = undefined
      }
      if (there === undefined) await copyFile(doc.path, target)
      if (there === undefined || there === content) {
        kept.push(`${VERSIONS}/${name}`)
        break
      }
    }
  }
  return kept
}

/**
 * `text` with `key: value` in its frontmatter: the line replaced if the key is there, added at the end
 * of the frontmatter if not, and a frontmatter made if the text has none. Pure. The value is one
 * plain token (an option id), never quoted.
 */
export function withFrontmatterKey(text: string, key: string, value: string): string {
  const lines = text.split('\n')
  const end = lines[0]?.trim() === '---' ? lines.findIndex((line, i) => i > 0 && line.trim() === '---') : -1
  if (end === -1) return ['---', `${key}: ${value}`, '---', text].join('\n')
  const at = lines.findIndex((line, i) => i > 0 && i < end && line.startsWith(`${key}:`))
  const updated = [...lines]
  if (at === -1) updated.splice(end, 0, `${key}: ${value}`)
  else updated[at] = `${key}: ${value}`
  return updated.join('\n')
}

/**
 * Criterion 28: the ONE key the module writes in a document of the owner (D1, D6) — read, change the
 * key, write to a temporary file and rename, keeping the mode. A document that is missing, or a link
 * out of the mockup folder, THROWS: the choice is not recorded half.
 */
export async function writeChosen(vaultDir: string, file: string, optionId: string, caseInsensitive: boolean): Promise<void> {
  const doc = await docOf(vaultDir, file, caseInsensitive)
  if (doc.kind === 'missing') throw new Error(`${file} does not exist in the mockup folder`)
  if (doc.kind === 'outside') throw new Error(`${file} is outside the mockup folder or not a file`)
  const mode = (await stat(doc.path)).mode & 0o777
  await writeAtomically(doc.path, withFrontmatterKey(await readFile(doc.path, 'utf8'), 'chosen', optionId), mode)
}

/** Every file under `dir`, relative, sorted, without `skip` at its top: what two trees are compared on. */
async function tree(dir: string, skip: ReadonlySet<string>): Promise<readonly string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .filter((path) => !skip.has(path.split('/')[0] ?? ''))
    .sort()
}

async function sameTree(a: string, b: string, skip: ReadonlySet<string>): Promise<boolean> {
  const [left, right] = [await tree(a, skip), await tree(b, new Set())]
  if (left.length !== right.length || left.some((path, i) => path !== right[i])) return false
  for (const path of left) {
    if (!(await readFile(join(a, path))).equals(await readFile(join(b, path)))) return false
  }
  return true
}

const DIR_SKIP = new Set([VERSIONS, '.vercel', 'node_modules', '.next'])

/**
 * Before a plan redo (D7; criterion 29): COPY `<workDir>/directions/` to `directions/_versions/v<k>/`,
 * without its own `_versions`, `.vercel`, `node_modules` and `.next`. The same tree already there is
 * not copied again (a retried redo); a different one is never overwritten: `v<k>-2`. Returns the
 * absolute folder that holds the version, or `null` when there is no `directions/` to keep.
 */
export async function versionDirections(workDir: string, k: number, folder = 'directions'): Promise<string | null> {
  const dir = join(workDir, folder)
  try {
    if (!(await stat(dir)).isDirectory()) return null
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return null
    throw error
  }
  for (let n = 1; ; n++) {
    const target = join(dir, VERSIONS, `v${k}${n === 1 ? '' : `-${n}`}`)
    let there = true
    try {
      await stat(target)
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error
      there = false
    }
    if (there) {
      if (await sameTree(dir, target, DIR_SKIP)) return target
      continue
    }
    await mkdir(target, { recursive: true })
    for (const entry of await readdir(dir)) {
      if (DIR_SKIP.has(entry)) continue
      await cp(join(dir, entry), join(target, entry), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
    }
    return target
  }
}

/** The documents of a stage that exist, read now (criterion 25). Over `DOC_MAX_BYTES` together: `too-large`. */
export async function readDocs(vaultDir: string, files: readonly string[], caseInsensitive: boolean): Promise<Result<readonly DocFile[]>> {
  const docs: DocFile[] = []
  let total = 0
  for (const name of files) {
    const doc = await docOf(vaultDir, name, caseInsensitive)
    if (doc.kind === 'missing') continue
    if (doc.kind === 'outside') return { ok: false, error: { code: 'conflict', reason: `${name} is outside the mockup folder or not a file` } }
    const info = await stat(doc.path)
    total += info.size
    if (total > DOC_MAX_BYTES) return { ok: false, error: { code: 'too-large', reason: `${name} is over 1 MiB` } }
    const { frontmatter, markdown } = splitFrontmatter(await readFile(doc.path, 'utf8'))
    docs.push({ name, frontmatter, markdown, mtime: info.mtime.toISOString() })
  }
  return { ok: true, value: docs }
}
