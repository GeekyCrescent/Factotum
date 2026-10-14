/**
 * THE JOURNAL (spec 2026-10-07-dos-hosts, D11): one file per project of a handoff,
 * `<stateDir>/handoff/<hid>/<siteId>.json`, on both hosts.
 *
 * ONE WRITER PER FILE: the handoff's queue of that project (D9). So two projects of one handoff never
 * write the same file from different queues, and nothing here needs a lock. READERS ARE ANYWHERE —
 * `status`, `GET /handoff/:hid`, the startup — and never see half a file: every write is a temporary
 * file and a `rename`, which is atomic within a directory.
 *
 * IT IS WRITTEN BEFORE THE THING IT DESCRIBES: the phase before the lock is taken and before it is
 * let go, and every intention of `installing` before its step. So a restart always finds a journal
 * that explains every holder and says exactly what to undo.
 *
 * A `hid` IS A UUIDv7, checked with `isSessionId` BEFORE it becomes a path (D13), and a `siteId` is
 * checked with a copy of `SITE_ID_PATTERN` — `modules/sessions/config.ts` cannot be imported from
 * here, as `packages/inbox` already knows. What comes off the disk is validated like any outside input.
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { isSessionId } from '../id.ts'
import type { SessionPaths } from '../paths.ts'

/** A COPY of `SITE_ID_PATTERN` (`modules/sessions/config.ts`): a package cannot import a module. */
const SITE_ID = /^[a-z0-9][a-z0-9-]*$/

export const isHandoffId = (hid: string): boolean => isSessionId(hid)
const isSiteId = (siteId: string): boolean => SITE_ID.test(siteId)

export const SOURCE_PHASES = ['locking', 'locked', 'sending', 'committing', 'acked', 'done', 'aborted', 'pending-peer', 'kept'] as const
export const TARGET_PHASES = ['preparing', 'prepared', 'installing', 'committed', 'done', 'aborted', 'abort-failed'] as const
export type SourcePhase = (typeof SOURCE_PHASES)[number]
export type TargetPhase = (typeof TARGET_PHASES)[number]
export type Phase = SourcePhase | TargetPhase

/** What `installing` moved, or meant to: written BEFORE the move (D9). */
const entrySchema = z.object({
  kind: z.enum(['session', 'transcript', 'upload']),
  id: z.string().min(1),
  path: z.string().min(1).optional(),
})

const leftoverSchema = z.object({
  step: z.string().min(1),
  kind: z.enum(['session', 'transcript', 'upload']).optional(),
  id: z.string().min(1).optional(),
})

const sha = z.string().regex(/^[0-9a-f]{40,64}$/)

const journalSchema = z.object({
  hid: z.string(),
  siteId: z.string(),
  role: z.enum(['source', 'target']),
  peer: z.string().min(1),
  /** The TARGET's siteId, on the source (v4.1): the peer's routes carry it, and a restart needs it. */
  peerSiteId: z.string().optional(),
  phase: z.enum([...new Set<Phase>([...SOURCE_PHASES, ...TARGET_PHASES])] as [Phase, ...Phase[]]),
  at: z.string(),
  branch: z.string().optional(),
  head: sha.optional(),
  wip: sha.optional(),
  tree: sha.optional(),
  /** `undefined` on a target that was on a detached HEAD. */
  prevBranch: z.string().optional(),
  prevHead: sha.optional(),
  branchHead: sha.optional(),
  branchCreated: z.boolean().optional(),
  /**
   * On the target, from `prepare`: this host's name as the SOURCE calls it — the `to` of the handoff
   * event. A module never learns its own host's name (the kernel keeps `publicOrigin`), so the one
   * that dialled it says it.
   */
  targetName: z.string().optional(),
  /** On the target, from `prepare` (v4.2): the only sessions a manifest may carry. */
  sessionIds: z.array(z.string()).optional(),
  /** The target's TTL is re-armed from this after a restart (D9). */
  lastSignalAt: z.string().optional(),
  installed: z.array(entrySchema),
  replaced: z.array(entrySchema),
  /** Only in `abort-failed` (v4.2): what could not be undone. No file names. */
  leftovers: z.array(leftoverSchema).optional(),
  stoppedServices: z.array(z.string()),
  /** THIS side's notices: `source-changed-during-handoff` here, `upload-collision` and `target-rescued` there. */
  warnings: z.array(z.string()),
  /** On the target (v4.3): why it said no, and with `target-ignored-collision` the owner's paths. */
  reason: z.string().optional(),
  paths: z.array(z.string()).optional(),
  pathCount: z.number().int().min(0).optional(),
  /** On the source (v4.3): what the target told, copied BEFORE deciding what to do with it. */
  targetReason: z.string().optional(),
  targetWarnings: z.array(z.string()),
  targetPaths: z.array(z.string()).optional(),
  targetPathCount: z.number().int().min(0).optional(),
})

export type JournalEntry = z.infer<typeof entrySchema>
export type Leftover = z.infer<typeof leftoverSchema>

/**
 * `?:` FIELDS ARE `| undefined` TOO: a journal is rebuilt with spreads, phase after phase, and
 * `exactOptionalPropertyTypes` would otherwise refuse clearing one.
 */
type Loosen<T> = { readonly [K in keyof T]: undefined extends T[K] ? T[K] | undefined : T[K] }
export type Journal = Loosen<z.infer<typeof journalSchema>>

export interface NewJournal {
  readonly hid: string
  readonly siteId: string
  readonly role: 'source' | 'target'
  readonly peer: string
  readonly phase: Phase
  readonly at: string
}

export function newJournal(fields: NewJournal): Journal {
  return { ...fields, installed: [], replaced: [], stoppedServices: [], warnings: [], targetWarnings: [] }
}

function guard(paths: SessionPaths, hid: string, siteId: string): string {
  if (!isHandoffId(hid)) throw new Error(`"${hid}" is not a handoff id`)
  if (!isSiteId(siteId)) throw new Error(`"${siteId}" is not a project id`)
  return paths.journalFile(hid, siteId)
}

/** Without the keys that are `undefined`: what goes to disk is what a reader parses back. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T
}

/** Atomically: a temporary file, then `rename`. Only the project's queue calls this (D9). */
export async function writeJournal(paths: SessionPaths, journal: Journal): Promise<void> {
  const file = guard(paths, journal.hid, journal.siteId)
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(compact(journal), null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

/** The journal of one project, or `undefined` — no file, a file that is not one, or ids that are not. Never throws. */
export async function readJournal(paths: SessionPaths, hid: string, siteId: string): Promise<Journal | undefined> {
  if (!isHandoffId(hid) || !isSiteId(siteId)) return undefined
  try {
    const parsed = journalSchema.safeParse(JSON.parse(await readFile(paths.journalFile(hid, siteId), 'utf8')))
    // The FILE names the journal, never its contents: one that says another hid or project is not this one.
    if (!parsed.success || parsed.data.hid !== hid || parsed.data.siteId !== siteId) return undefined
    return parsed.data
  } catch {
    return undefined
  }
}

/** Every readable journal of one handoff. */
export async function listJournals(paths: SessionPaths, hid: string): Promise<readonly Journal[]> {
  if (!isHandoffId(hid)) return []
  const names = await readdir(paths.handoffDir(hid)).catch(() => [] as string[])
  const out: Journal[] = []
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'run.json') continue
    const journal = await readJournal(paths, hid, name.slice(0, -'.json'.length))
    if (journal !== undefined) out.push(journal)
  }
  return out
}

/** Every handoff on disk, by its directory, ignoring anything that is not a handoff id. */
export async function listHids(paths: SessionPaths): Promise<readonly string[]> {
  const names = await readdir(paths.handoff).catch(() => [] as string[])
  return names.filter(isHandoffId)
}

const runSchema = z.object({
  hid: z.string(),
  peer: z.string().min(1),
  startedAt: z.string(),
  siteIds: z.array(z.string()),
  /**
   * Where the whole handoff is (not in the design: D11 has `run.json` written once). `POST /handoff`
   * answers 202 at once and plans apart, so the report needs `planning` before any project has a
   * journal, and `failed` with why when the plan itself could not be made (the peer down).
   */
  state: z.enum(['planning', 'running', 'finished', 'failed']).optional(),
  failure: z.string().optional(),
  /** What the plan left here, with why: the report's «not moved» that never got a journal. */
  skipped: z.array(z.object({ siteId: z.string(), sessionId: z.string().optional(), reason: z.string() })).optional(),
  totals: z.object({ archived: z.number(), tooOld: z.number() }).optional(),
})
export type Run = Loosen<z.infer<typeof runSchema>>

const runFile = (paths: SessionPaths, hid: string) => `${paths.handoffDir(hid)}/run.json`

/** The source's `run.json`, written ONCE by the handoff's loop, when it starts (D9). */
export async function writeRun(paths: SessionPaths, run: Run): Promise<void> {
  if (!isHandoffId(run.hid)) throw new Error(`"${run.hid}" is not a handoff id`)
  const file = runFile(paths, run.hid)
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(run, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

export async function readRun(paths: SessionPaths, hid: string): Promise<Run | undefined> {
  if (!isHandoffId(hid)) return undefined
  try {
    const parsed = runSchema.safeParse(JSON.parse(await readFile(runFile(paths, hid), 'utf8')))
    return parsed.success && parsed.data.hid === hid ? parsed.data : undefined
  } catch {
    return undefined
  }
}
