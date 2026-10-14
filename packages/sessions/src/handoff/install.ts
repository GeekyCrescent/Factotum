/**
 * Installing one session on the target, and undoing it (spec 2026-10-07-dos-hosts, D8, «La
 * instalación»). Three steps, in this order so a session that already shows in the list has its
 * transcript: the uploads, the transcript, the session.
 *
 * THE INTENTION GOES IN THE JOURNAL BEFORE EACH MOVE (D9). So a restart in the middle finds exactly
 * what may have happened, and the undo tolerates an intention that never became a move: an entry of
 * `replaced` with nothing in `replaced/` is a rename that did not happen, and what is there is still
 * the owner's.
 */

import { lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseMeta, type SessionMeta } from '../store.ts'
import { cliDirOf, findTranscripts } from './cli-paths.ts'
import type { HandoffHost } from './host.ts'
import type { JournalEntry, Leftover } from './journal.ts'
import { sha256Of } from './manifest.ts'

const exists = async (path: string) => (await lstat(path).catch(() => undefined)) !== undefined

/** Where the work of one project lives on this host. */
export interface Work {
  readonly staging: string
  readonly replaced: string
}

export interface InstallJournal {
  /** Writes the intention, BEFORE the move it describes. */
  readonly intend: (change: { readonly installed?: JournalEntry; readonly replaced?: JournalEntry }) => Promise<void>
  readonly warn: (code: 'upload-collision') => Promise<void>
}

export interface InstallInput {
  readonly sessionId: string
  /** THIS host's project: its id and the path a launch here writes as `sitePath`. */
  readonly siteId: string
  readonly projectPath: string
  readonly event: { readonly from: string; readonly to: string; readonly hid: string }
}

type InstallHost = Pick<HandoffHost, 'store' | 'uploadsRoot' | 'claudeProjects' | 'log'>

export async function installSession(host: InstallHost, work: Work, journal: InstallJournal, input: InstallInput): Promise<void> {
  const staged = join(work.staging, input.sessionId)
  await installUploads(host, staged, journal)
  await installTranscript(host, work, staged, journal, input)

  const arrived = parseMeta(input.sessionId, JSON.parse(await readFile(join(staged, 'session', 'meta.json'), 'utf8')))
  if (arrived === undefined) throw new Error('the meta that arrived does not read')
  // THE META OF THIS SIDE (v4.2): this host's project and path, and nothing that says it moved.
  // The rest stays — `entryId`, `title`, `touchedAt` — so the history is ordered alike on both hosts.
  const meta: SessionMeta = { ...arrived, siteId: input.siteId, sitePath: input.projectPath, movedTo: undefined, movedAt: undefined, agentPid: undefined }
  await host.store.importSession(input.sessionId, join(staged, 'session'), work.replaced, async (step) => {
    await journal.intend(step === 'replace' ? { replaced: { kind: 'session', id: input.sessionId } } : { installed: { kind: 'session', id: input.sessionId } })
  }, meta)
  // ONE EVENT PER CROSSING, and only the host that receives writes it (criterion 28).
  await host.store.append(input.sessionId, { kind: 'handoff', ...input.event })
}

/** Same id and same bytes: skipped, it went from here. Same id and other bytes: the one here stays. */
async function installUploads(host: InstallHost, staged: string, journal: InstallJournal): Promise<void> {
  const root = join(staged, 'uploads')
  for (const uploadId of await readdir(root).catch(() => [] as string[])) {
    const from = join(root, uploadId)
    const to = join(host.uploadsRoot, uploadId)
    if (await exists(to)) {
      if (!(await sameUpload(from, to))) {
        // Never a file name in the log (criterion 36).
        host.log.warn('handoff: an upload with the same id and other contents was already here; it was kept')
        await journal.warn('upload-collision')
      }
      continue
    }
    await journal.intend({ installed: { kind: 'upload', id: uploadId } })
    await mkdir(host.uploadsRoot, { recursive: true })
    await rename(from, to)
  }
}

async function sameUpload(a: string, b: string): Promise<boolean> {
  const [left, right] = [(await readdir(a)).sort(), (await readdir(b).catch(() => [] as string[])).sort()]
  if (left.join('\u0000') !== right.join('\u0000')) return false
  for (const name of left) if ((await sha256Of(join(a, name))) !== (await sha256Of(join(b, name)))) return false
  return true
}

/**
 * Every copy the source's search would find HERE goes to `replaced/cli/<folder>/` first: two copies
 * of one id would leave `--resume` to choose by itself. Then the new one goes where the CLI would put
 * it for this host's path.
 */
async function installTranscript(host: InstallHost, work: Work, staged: string, journal: InstallJournal, input: InstallInput): Promise<void> {
  const file = join(staged, 'cli', `${input.sessionId}.jsonl`)
  if (!(await exists(file))) return
  for (const copy of await findTranscripts(host.claudeProjects, input.sessionId)) {
    await journal.intend({ replaced: { kind: 'transcript', id: input.sessionId, path: copy.folder } })
    const keep = join(work.replaced, 'cli', basename(copy.folder))
    await mkdir(keep, { recursive: true })
    await rename(copy.file, join(keep, `${input.sessionId}.jsonl`))
    if (copy.dir !== undefined) await rename(copy.dir, join(keep, input.sessionId))
  }
  const folder = join(host.claudeProjects, await cliDirOf(input.projectPath))
  await journal.intend({ installed: { kind: 'transcript', id: input.sessionId, path: folder } })
  await mkdir(folder, { recursive: true })
  await rename(file, join(folder, `${input.sessionId}.jsonl`))
  const dir = join(staged, 'cli', input.sessionId)
  if (await exists(dir)) await rename(dir, join(folder, input.sessionId))
}

/**
 * The undo of `installing`, from the journal, LAST ENTRY FIRST (D9, «Abortar en el destino»): what was
 * installed goes, then what was replaced comes back. EVERY STEP IS TRIED even when one fails, and
 * what failed is returned — `abort-failed` — never a pretence that all is as before (v4.2).
 */
export async function undoInstall(host: Pick<HandoffHost, 'store' | 'uploadsRoot'>, work: Work, installed: readonly JournalEntry[], replaced: readonly JournalEntry[]): Promise<readonly Leftover[]> {
  const leftovers: Leftover[] = []
  const attempt = async (step: string, entry: JournalEntry, work: () => Promise<void>) => {
    try {
      await work()
    } catch {
      leftovers.push({ step, kind: entry.kind, id: entry.id })
    }
  }
  for (const entry of [...installed].reverse()) {
    if (entry.kind === 'session') await attempt('discardImported', entry, () => host.store.discardImported(entry.id))
    if (entry.kind === 'upload') await attempt('removeUpload', entry, () => rm(join(host.uploadsRoot, entry.id), { recursive: true, force: true }))
    if (entry.kind === 'transcript' && entry.path !== undefined) {
      const folder = entry.path
      await attempt('removeTranscript', entry, async () => {
        await rm(join(folder, `${entry.id}.jsonl`), { force: true })
        await rm(join(folder, entry.id), { recursive: true, force: true })
      })
    }
  }
  for (const entry of [...replaced].reverse()) {
    if (entry.kind === 'session') {
      const from = join(work.replaced, entry.id)
      if (await exists(from)) await attempt('restoreSession', entry, () => host.store.restoreSession(entry.id, from))
    }
    if (entry.kind === 'transcript' && entry.path !== undefined) {
      const folder = entry.path
      const keep = join(work.replaced, 'cli', basename(folder))
      await attempt('restoreTranscript', entry, async () => {
        if (await exists(join(keep, `${entry.id}.jsonl`))) await rename(join(keep, `${entry.id}.jsonl`), join(folder, `${entry.id}.jsonl`))
        if (await exists(join(keep, entry.id))) await rename(join(keep, entry.id), join(folder, entry.id))
      })
    }
  }
  return leftovers
}
