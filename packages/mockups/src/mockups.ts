/**
 * The facade (design D1): what the module calls, and the only door to the mockups.
 *
 * EVERY INPUT FROM OUTSIDE ARRIVES AS `unknown` and is shaped (`shape.ts`) before an op sees it. Every
 * change of state goes through the store's queue and an op of `ops.ts`; the files around it (the
 * vault, the inputs) are written here, before the change, and are idempotent or harmless if the
 * change then refuses.
 *
 * THE LOG CARRIES IDS, the stage, the run and the state — never a name, a note, a comment or a
 * document (criterion 42).
 */

import { unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { uuidv7 } from '@factotum/sessions'
import { parseMockupsConfig } from './config.ts'
import { INPUTS_DIR, PRIVATE_DIR, saveNote, saveUpload, type SavedInput } from './inputs.ts'
import {
  abandonRun,
  addInput,
  archive,
  canAddInput,
  decide,
  findRun,
  linkSession,
  newMockup,
  setBuildSite,
  stallRun,
  startRun,
  type StartInput,
} from './ops.ts'
import { inside, real } from './paths.ts'
import { contextFor, promptFor } from './prompts/index.ts'
import { sweep } from './runs.ts'
import { parseAbandon, parseCreate, parseDecision, parseLink, parseNote, parseRun, parseSite, parseSiteMatch, SWEEP_EVERY_MS, uploadName, type DecisionInput, type Shaped } from './shape.ts'
import { isLaunchable, RUN_SPECS, STAGES } from './stages.ts'
import { codeOf, openStore, type MockupsStore } from './store/store.ts'
import { createSubmitTool } from './submit.ts'
import { createMockupDir, createProject, listProjects, readDocs, versionDirections, versionDocs, writeChosen } from './vault.ts'
import {
  STAGE_IDS,
  type CreateMockupsResult,
  type Mockup,
  type Mockups,
  type MockupsDeps,
  type MockupsFile,
  type ProjectEntry,
  type Result,
  type RunKind,
  type RunTicket,
  type StageId,
} from './types.ts'

const TITLE_MAX_CHARS = 80

function invalid<T>(shaped: Shaped<unknown> & { readonly ok: false }): Result<T> {
  return { ok: false, error: { code: 'invalid', field: shaped.field, reason: shaped.reason } }
}
const notFound = <T>(reason = 'there is no such mockup'): Result<T> => ({ ok: false, error: { code: 'not-found', reason } })
const conflict = <T>(reason: string): Result<T> => ({ ok: false, error: { code: 'conflict', reason } })

/** `Mockup · <stage> · <name>`, the name cut so the whole fits in 80 and the stage survives (crit. 14). */
export function titleFor(kind: RunKind, name: string): string {
  const prefix = `Mockup · ${kind} · `
  const room = TITLE_MAX_CHARS - prefix.length
  return prefix + (name.length <= room ? name : `${name.slice(0, room - 1)}…`)
}

/** The owner's day, `YYYY-MM-DD`, in the zone of the process. */
function dayOf(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export async function createMockups(deps: MockupsDeps): Promise<CreateMockupsResult> {
  const home = deps.home ?? homedir()
  const caseInsensitive = deps.caseInsensitive ?? process.platform === 'darwin'
  const parsed = parseMockupsConfig(deps.config, home)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const config = parsed.config
  const opened = await openStore({ dir: deps.stateDir, now: deps.now(), log: deps.log })
  if (!opened.ok) return { ok: false, reason: opened.reason }
  const store: MockupsStore = opened.store
  const log = deps.log

  /** Runs `op` on the mockup of that moment, inside the queue. */
  const change = async (id: string, op: (m: Mockup) => Result<Mockup>): Promise<Result<Mockup>> => {
    const result = await store.change<{ readonly file: MockupsFile; readonly mockup: Mockup }>((file) => {
      const m = file.mockups.find((one) => one.id === id)
      if (m === undefined) return notFound()
      const next = op(m)
      if (!next.ok) return next
      return { ok: true, value: { file: { ...file, mockups: file.mockups.map((one) => (one.id === id ? next.value : one)) }, mockup: next.value } }
    })
    return result.ok ? { ok: true, value: result.value.mockup } : result
  }
  const ownerOf = (runId: string): Mockup | undefined => store.current().mockups.find((m) => findRun(m, runId) !== undefined)
  const changeRun = async (runId: string, op: (m: Mockup) => Result<Mockup>): Promise<Result<Mockup>> => {
    const owner = ownerOf(runId)
    return owner === undefined ? notFound('there is no such run') : await change(owner.id, op)
  }

  const sameFolder = (a: string, b: string): boolean => inside(a, b, caseInsensitive) && inside(b, a, caseInsensitive)

  const siteFor = (m: Mockup, kind: RunKind): Result<string> => {
    if (RUN_SPECS[kind].site === 'docs') return { ok: true, value: config.docsSiteId }
    if (m.buildSiteId === null) return conflict(m.buildRefused === undefined ? 'the work folder is not a sessions project yet' : `no build project: ${m.buildRefused}`)
    return { ok: true, value: m.buildSiteId }
  }

  const ticketOf = (m: Mockup, kind: StageId, runId: string, siteId: string, redo?: { readonly comment: string; readonly previous: readonly string[] }): RunTicket | null => {
    const text = promptFor(contextFor(m, kind, runId, redo))
    if (text === null) return null
    return { runId, siteId, text, title: titleFor(kind, m.name), ...(config.model === undefined ? {} : { model: config.model }) }
  }

  /** Starts a run (and, for a redo, records the decision first) in ONE change. */
  const launch = async (id: string, kind: StageId, redo?: { readonly comment: string; readonly previous: readonly string[] }): Promise<Result<{ readonly mockup: Mockup; readonly run: RunTicket }>> => {
    const m = store.current().mockups.find((one) => one.id === id)
    if (m === undefined) return notFound()
    const site = siteFor(m, kind)
    if (!site.ok) return site
    const runId = uuidv7(deps.now().getTime())
    const now = deps.now()
    const ticket = ticketOf(m, kind, runId, site.value, redo)
    if (ticket === null) return { ok: false, error: { code: 'not-yet', reason: `${kind} has no prompt in this cut` } }
    const input: StartInput = { kind, runId, siteId: site.value, ...(redo === undefined ? {} : { redo: { comment: redo.comment } }) }
    const result = await change(id, (current) => {
      if (redo === undefined) return startRun(current, input, now)
      const decided = decide(current, { step: kind, action: 'redo', comment: redo.comment }, now)
      return decided.ok ? startRun(decided.value, input, now) : decided
    })
    if (!result.ok) return result
    log.info(`mockup ${id}: ${kind} run ${runId} started${redo === undefined ? '' : ' (redo)'}`)
    return { ok: true, value: { mockup: result.value, run: ticket } }
  }

  /**
   * Criterion 28: `chosen: <id>` into the stage's document BEFORE the state moves — checked first on
   * the mockup of now, so a choice the op would refuse never touches the document. If the state then
   * refuses (a race), the key stays with a choice the owner did make; choosing again rewrites it.
   */
  const recordChoice = async (id: string, input: DecisionInput): Promise<Result<Mockup>> => {
    const m = store.current().mockups.find((one) => one.id === id)
    if (m === undefined) return notFound()
    const dry = decide(m, input, deps.now())
    if (!dry.ok) return dry
    const file = STAGES[input.step].chosenIn
    if (file === undefined || input.optionId === undefined) return dry
    try {
      await writeChosen(m.vaultDir, file, input.optionId, caseInsensitive)
    } catch (error) {
      log.warn(`mockup ${id}: the ${input.step} choice could not be written (${codeOf(error)})`)
      return { ok: false, error: { code: 'module-error', reason: `the choice could not be written in ${file} (${error instanceof Error ? error.message : codeOf(error)}), so nothing was chosen` } }
    }
    return dry
  }

  const keepInput = async (id: string, save: () => Promise<SavedInput>, isPrivate: boolean, what: 'upload' | 'note'): Promise<Result<Mockup>> => {
    const m = store.current().mockups.find((one) => one.id === id)
    if (m === undefined) return notFound()
    const allowed = canAddInput(m)
    if (!allowed.ok) return allowed
    let saved: SavedInput
    try {
      saved = await save()
    } catch (error) {
      log.error(`mockup ${id}: an ${what} could not be saved (${codeOf(error)})`)
      return { ok: false, error: { code: 'module-error', reason: 'the input could not be saved in the work folder' } }
    }
    const now = deps.now()
    const result = await change(id, (current) => addInput(current, { ...saved, private: isPrivate, at: now.toISOString() }, now))
    if (result.ok) {
      // Never the name, nor its extension: a name can say what the client is (criterion 42).
      log.info(`mockup ${id}: ${what} added${isPrivate ? ' (private)' : ''}`)
      return result
    }
    // A stage started while it uploaded (criterion 12): the file must not sit there unlisted.
    await unlink(join(m.workDir, INPUTS_DIR, ...(isPrivate ? [PRIVATE_DIR] : []), saved.name)).catch(() => log.warn(`mockup ${id}: a refused ${what} could not be removed`))
    return result
  }

  const projects = async (): Promise<Result<readonly ProjectEntry[]>> => {
    try {
      return { ok: true, value: await listProjects(config.vault.projectsDir, home) }
    } catch (error) {
      log.warn(`the projects folder could not be listed (${codeOf(error)})`)
      return { ok: false, error: { code: 'module-error', reason: `the projects folder could not be listed (${codeOf(error)})` } }
    }
  }

  const sweeper = deps.timers.setInterval(() => {
    void sweep(store, deps.now(), log).catch(() => log.error('the sweep of runs failed'))
  }, SWEEP_EVERY_MS)

  const mockups: Mockups = {
    setup: () => ({ docsSiteId: config.docsSiteId, projectsDir: config.vault.projectsDir, workRoot: config.workRoot, crossWritesAllowed: config.crossWritesAllowed }),
    list: () => store.current().mockups.filter((m) => m.status !== 'archived').sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)),
    get: (id) => store.current().mockups.find((m) => m.id === id),

    projects: async () => await projects(),

    create: async (raw) => {
      const input = parseCreate(raw)
      if (!input.ok) return invalid(input)
      const { name, client, project } = input.value
      let projectDir: string
      let workDir: string
      let mapWarning: string | undefined
      if (project.kind === 'existing') {
        const listed = await projects()
        if (!listed.ok) return listed
        const found = listed.value.find((p) => p.slug === project.slug)
        if (found === undefined) return notFound('there is no such project in the vault')
        if (found.workDir === null) return { ok: false, error: { code: 'invalid', field: 'project.slug', reason: 'that project has no work-dir' } }
        workDir = found.workDir
        projectDir = join(config.vault.projectsDir, project.slug)
      } else {
        const made = await createProject({
          projectsDir: config.vault.projectsDir,
          workRoot: config.workRoot,
          ...(config.vault.mapFile === undefined ? {} : { mapFile: config.vault.mapFile }),
          home,
          today: dayOf(deps.now()),
          ...project,
        })
        if (!made.ok) return made
        projectDir = made.value.projectDir
        workDir = await real(made.value.workDir)
        mapWarning = made.value.mapWarning
      }
      const busy = store.current().mockups.find((m) => m.status !== 'archived' && sameFolder(m.workDir, workDir))
      if (busy !== undefined) return conflict(`the work folder already has the open mockup «${busy.name}»`)
      const vaultDir = await real(await createMockupDir(projectDir))
      const id = uuidv7(deps.now().getTime())
      const m = newMockup({ id, name, client, project: project.slug, vaultDir, workDir, buildSiteId: null }, deps.now())
      // Checked again ON THE FILE OF THE CHANGE: two creates at once must not both pass (criterion 8).
      const result = await store.change((file) => {
        const twin = file.mockups.find((one) => one.status !== 'archived' && sameFolder(one.workDir, workDir))
        if (twin !== undefined) return conflict<{ readonly file: MockupsFile }>(`the work folder already has the open mockup «${twin.name}»`)
        return { ok: true, value: { file: { ...file, mockups: [...file.mockups, m] } } }
      })
      if (!result.ok) return result
      log.info(`mockup ${id} created (${project.kind} project)${mapWarning === undefined ? '' : '; the map was not updated'}`)
      return { ok: true, value: { mockup: m, ...(mapWarning === undefined ? {} : { mapWarning }) } }
    },

    siteMatch: async (id, raw) => {
      const input = parseSiteMatch(raw)
      if (!input.ok) return invalid(input)
      const m = mockups.get(id)
      if (m === undefined) return notFound()
      let best: { readonly id: string; readonly path: string } | undefined
      for (const project of input.value.projects) {
        const path = await real(project.path)
        if (inside(path, m.workDir, caseInsensitive) && (best === undefined || path.length > best.path.length)) best = { id: project.id, path }
      }
      return { ok: true, value: { siteId: best?.id ?? null } }
    },

    setSite: async (id, raw) => {
      const input = parseSite(raw)
      if (!input.ok) return invalid(input)
      const result = await change(id, (m) => setBuildSite(m, input.value, deps.now()))
      if (result.ok) log.info(`mockup ${id}: build project ${'siteId' in input.value ? input.value.siteId : 'refused by sessions'}`)
      return result
    },

    addInput: async (id, file, query) => {
      const name = uploadName(query['name'])
      if (!name.ok) return invalid(name)
      const isPrivate = query['private'] === '1'
      const m = mockups.get(id)
      if (m === undefined) return notFound()
      return await keepInput(id, () => saveUpload({ workDir: m.workDir, file, name: name.value, isPrivate }), isPrivate, 'upload')
    },

    addNote: async (id, raw) => {
      const input = parseNote(raw)
      if (!input.ok) return invalid(input)
      const m = mockups.get(id)
      if (m === undefined) return notFound()
      return await keepInput(id, () => saveNote({ workDir: m.workDir, text: input.value.text }), false, 'note')
    },

    docs: async (id, stage) => {
      if (!(STAGE_IDS as readonly string[]).includes(stage)) return { ok: false, error: { code: 'invalid', field: 'stage', reason: 'that is not a stage' } }
      const m = mockups.get(id)
      if (m === undefined) return notFound()
      try {
        const read = await readDocs(m.vaultDir, STAGES[stage as StageId].files, caseInsensitive)
        return read.ok ? { ok: true, value: { files: read.value } } : read
      } catch (error) {
        log.warn(`mockup ${id}: the ${stage} documents could not be read (${codeOf(error)})`)
        return { ok: false, error: { code: 'module-error', reason: `the documents could not be read (${codeOf(error)})` } }
      }
    },

    startRun: async (id, raw) => {
      const input = parseRun(raw)
      if (!input.ok) return invalid(input)
      if (!isLaunchable(input.value.kind)) return { ok: false, error: { code: 'not-yet', reason: `${input.value.kind} arrives in the next cut` } }
      const launched = await launch(id, input.value.kind)
      return launched.ok ? { ok: true, value: launched.value.run } : launched
    },

    decide: async (id, raw) => {
      const input = parseDecision(raw)
      if (!input.ok) return invalid(input)
      const { step, action } = input.value
      if (action === 'redo') {
        if (input.value.comment === undefined) return { ok: false, error: { code: 'invalid', field: 'comment', reason: 'a redo needs a comment' } }
        if (!isLaunchable(step)) return { ok: false, error: { code: 'not-yet', reason: `${step} arrives in the next cut` } }
        const m = mockups.get(id)
        if (m === undefined) return notFound()
        const current = m.stages[step]
        if (current.status !== 'waiting') return conflict(`${step} is ${current.status}, not waiting on you`)
        // COPIED, never moved: if the launch fails, the document is still where it was (criterion 29).
        let previous: readonly string[]
        try {
          const docs = await versionDocs(m.vaultDir, STAGES[step].files, current.version, caseInsensitive)
          const dirs = (STAGES[step].versionedDirs ?? []).length === 0 ? null : await versionDirections(m.workDir, current.version)
          previous = dirs === null ? docs : [...docs, dirs]
        } catch (error) {
          log.warn(`mockup ${id}: the ${step} version could not be kept (${codeOf(error)})`)
          return { ok: false, error: { code: 'module-error', reason: `the current version could not be copied aside, so nothing was redone (${error instanceof Error ? error.message : codeOf(error)})` } }
        }
        const launched = await launch(id, step, { comment: input.value.comment, previous })
        return launched.ok ? { ok: true, value: launched.value } : launched
      }
      if (action === 'choose') {
        const written = await recordChoice(id, input.value)
        if (!written.ok) return written
      }
      const result = await change(id, (m) => decide(m, input.value, deps.now()))
      if (!result.ok) return result
      log.info(`mockup ${id}: ${step} ${action === 'choose' ? 'chosen' : 'approved'}, version ${result.value.stages[step].version}`)
      return { ok: true, value: { mockup: result.value } }
    },

    archive: async (id) => {
      const result = await change(id, (m) => archive(m, deps.now()))
      if (result.ok) log.info(`mockup ${id} archived`)
      return result
    },

    linkRun: async (runId, raw) => {
      const input = parseLink(raw)
      if (!input.ok) return invalid(input)
      return await changeRun(runId, (m) => linkSession(m, runId, input.value.sessionId, deps.now()))
    },

    stallRun: async (runId) => {
      const result = await changeRun(runId, (m) => stallRun(m, runId, deps.now()))
      if (result.ok) log.info(`mockup ${result.value.id}: run ${runId} stalled`)
      return result
    },

    abandonRun: async (runId, raw) => {
      const input = parseAbandon(raw)
      if (!input.ok) return invalid(input)
      const result = await changeRun(runId, (m) => abandonRun(m, runId, deps.now()))
      if (result.ok) log.info(`mockup ${result.value.id}: run ${runId} abandoned`)
      return result
    },

    agent: createSubmitTool({ store, now: deps.now, log, notify: deps.notify, caseInsensitive }),

    stop: async () => {
      sweeper[Symbol.dispose]()
      await store.idle()
    },
  }
  return { ok: true, mockups }
}

