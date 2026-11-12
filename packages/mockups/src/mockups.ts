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

import { homedir } from 'node:os'
import { join } from 'node:path'
import { uuidv7 } from '@factotum/sessions'
import { parseMockupsConfig } from './config.ts'
import { saveNote, saveUpload, type SavedInput } from './inputs.ts'
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
import { promptFor } from './prompts/index.ts'
import { sweep } from './runs.ts'
import { parseAbandon, parseCreate, parseDecision, parseLink, parseNote, parseRun, parseSite, parseSiteMatch, SWEEP_EVERY_MS, uploadName, type Shaped } from './shape.ts'
import { isLaunchable, RUN_SPECS, STAGES } from './stages.ts'
import { openStore, type MockupsStore } from './store/store.ts'
import { createSubmitTool } from './submit.ts'
import { createMockupDir, createProject, listProjects, readDocs, versionDocs } from './vault.ts'
import {
  STAGE_IDS,
  type CreateMockupsResult,
  type Mockup,
  type Mockups,
  type MockupsDeps,
  type MockupsFile,
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

  const siteFor = (m: Mockup, kind: RunKind): Result<string> => {
    if (RUN_SPECS[kind].site === 'docs') return { ok: true, value: config.docsSiteId }
    if (m.buildSiteId === null) return conflict(m.buildRefused === undefined ? 'the work folder is not a sessions project yet' : `no build project: ${m.buildRefused}`)
    return { ok: true, value: m.buildSiteId }
  }

  const ticketOf = (m: Mockup, kind: StageId, runId: string, siteId: string, redo?: { readonly comment: string; readonly previous: readonly string[] }): RunTicket => {
    const text = promptFor({ runId, stage: kind, name: m.name, client: m.client, vaultDir: m.vaultDir, workDir: m.workDir, inputs: m.inputs, ...(redo === undefined ? {} : { redo }) })
    return { runId, siteId, text: text ?? '', title: titleFor(kind, m.name), ...(config.model === undefined ? {} : { model: config.model }) }
  }

  /** Starts a run (and, for a redo, records the decision first) in ONE change. */
  const launch = async (id: string, kind: StageId, redo?: { readonly comment: string; readonly previous: readonly string[] }): Promise<Result<{ readonly mockup: Mockup; readonly run: RunTicket }>> => {
    const m = store.current().mockups.find((one) => one.id === id)
    if (m === undefined) return notFound()
    const site = siteFor(m, kind)
    if (!site.ok) return site
    const runId = uuidv7(deps.now().getTime())
    const now = deps.now()
    const input: StartInput = { kind, runId, siteId: site.value, ...(redo === undefined ? {} : { redo: { comment: redo.comment } }) }
    const result = await change(id, (current) => {
      if (redo === undefined) return startRun(current, input, now)
      const decided = decide(current, { step: kind, action: 'redo', comment: redo.comment }, now)
      return decided.ok ? startRun(decided.value, input, now) : decided
    })
    if (!result.ok) return result
    log.info(`mockup ${id}: ${kind} run ${runId} started${redo === undefined ? '' : ' (redo)'}`)
    return { ok: true, value: { mockup: result.value, run: ticketOf(result.value, kind, runId, site.value, redo) } }
  }

  const keepInput = async (id: string, save: () => Promise<SavedInput>, isPrivate: boolean): Promise<Result<Mockup>> => {
    const m = store.current().mockups.find((one) => one.id === id)
    if (m === undefined) return notFound()
    const allowed = canAddInput(m)
    if (!allowed.ok) return allowed
    let saved: SavedInput
    try {
      saved = await save()
    } catch (error) {
      log.error(`mockup ${id}: an input could not be saved (${error instanceof Error && 'code' in error ? String(error.code) : 'unknown'})`)
      return { ok: false, error: { code: 'module-error', reason: 'the input could not be saved in the work folder' } }
    }
    const now = deps.now()
    const result = await change(id, (current) => addInput(current, { ...saved, private: isPrivate, at: now.toISOString() }, now))
    if (result.ok) log.info(`mockup ${id}: input added (${saved.kind}${isPrivate ? ', private' : ''})`)
    return result
  }

  const sweeper = deps.timers.setInterval(() => {
    void sweep(store, deps.now(), log).catch(() => log.error('the sweep of runs failed'))
  }, SWEEP_EVERY_MS)

  const mockups: Mockups = {
    setup: () => ({ docsSiteId: config.docsSiteId, projectsDir: config.vault.projectsDir, workRoot: config.workRoot, crossWritesAllowed: config.crossWritesAllowed }),
    list: () => store.current().mockups.filter((m) => m.status !== 'archived').sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)),
    get: (id) => store.current().mockups.find((m) => m.id === id),

    projects: async () => {
      try {
        return await listProjects(config.vault.projectsDir, home)
      } catch (error) {
        log.warn(`the projects folder could not be listed (${error instanceof Error && 'code' in error ? String(error.code) : 'unknown'})`)
        return []
      }
    },

    create: async (raw) => {
      const input = parseCreate(raw)
      if (!input.ok) return invalid(input)
      const { name, client, project } = input.value
      let projectDir: string
      let workDir: string
      let mapWarning: string | undefined
      if (project.kind === 'existing') {
        const found = (await mockups.projects()).find((p) => p.slug === project.slug)
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
      const busy = store.current().mockups.find((m) => m.status !== 'archived' && inside(m.workDir, workDir, caseInsensitive) && inside(workDir, m.workDir, caseInsensitive))
      if (busy !== undefined) return conflict(`the work folder already has the open mockup «${busy.name}»`)
      const vaultDir = await real(await createMockupDir(projectDir))
      const id = uuidv7(deps.now().getTime())
      const m = newMockup({ id, name, client, project: project.slug, vaultDir, workDir, buildSiteId: null }, deps.now())
      const result = await store.change((file) => ({ ok: true, value: { file: { ...file, mockups: [...file.mockups, m] } } }))
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
      return await keepInput(id, () => saveUpload({ workDir: m.workDir, file, name: name.value, isPrivate }), isPrivate)
    },

    addNote: async (id, raw) => {
      const input = parseNote(raw)
      if (!input.ok) return invalid(input)
      const m = mockups.get(id)
      if (m === undefined) return notFound()
      return await keepInput(id, () => saveNote({ workDir: m.workDir, text: input.value.text }), false)
    },

    docs: async (id, stage) => {
      if (!(STAGE_IDS as readonly string[]).includes(stage)) return { ok: false, error: { code: 'invalid', field: 'stage', reason: 'that is not a stage' } }
      const m = mockups.get(id)
      if (m === undefined) return notFound()
      const read = await readDocs(m.vaultDir, STAGES[stage as StageId].files)
      return read.ok ? { ok: true, value: { files: read.value } } : read
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
        const previous = await versionDocs(m.vaultDir, STAGES[step].files, current.version)
        const launched = await launch(id, step, { comment: input.value.comment, previous })
        return launched.ok ? { ok: true, value: launched.value } : launched
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

