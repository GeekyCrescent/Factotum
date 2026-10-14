/**
 * THE PRUNE (spec 2026-10-07-dos-hosts, D11, «La poda»; guardrail 5). Each daemon prunes ITS OWN —
 * its `stateDir` and its repos — and never calls the peer. At startup after the reconciliation, then
 * once a day, each project through its handoff queue, so it never steps on one in course.
 *
 * The age of a handoff is its `hid`'s, a UUIDv7. NOTHING OF A LIVE HANDOFF, AND NOTHING OF AN
 * `abort-failed` EVER: there the owner's only copy may be in `replaced/`, and the undo is theirs.
 */

import { readdir, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { KeyedQueue } from '../keyed-queue.ts'
import { HANDOFF_BACKUP_DAYS } from './constants.ts'
import { handoffGit } from './git.ts'
import type { HandoffHost } from './host.ts'
import { isHandoffId, listHids, listJournals, type Journal } from './journal.ts'

const DAY_MS = 86_400_000
export const HANDOFF_PRUNE_MS = DAY_MS
/** Phases nothing is happening in: what the prune may look at. `abort-failed` is not one of them. */
const AT_REST: readonly string[] = ['aborted', 'done', 'kept', 'committed']

/** When the handoff began: the first 48 bits of its UUIDv7. */
export function hidTime(hid: string): number {
  return Number.parseInt(hid.replaceAll('-', '').slice(0, 12), 16)
}

export async function prune(host: HandoffHost, queue: KeyedQueue): Promise<void> {
  const now = host.now().getTime()
  const older = (hid: string, ms: number) => now - hidTime(hid) > ms
  const keep = new Map<string, Journal>()
  for (const hid of await listHids(host.paths)) {
    for (const journal of await listJournals(host.paths, hid)) {
      keep.set(`${hid}/${journal.siteId}`, journal)
      await queue.run(journal.siteId, async () => await pruneOne(host, journal, older))
    }
    // `run.json` and the folder go once no journal is left in it.
    const left = (await readdir(host.paths.handoffDir(hid)).catch(() => [] as string[])).filter((name) => name.endsWith('.json') && name !== 'run.json')
    if (left.length === 0) await rm(host.paths.handoffDir(hid), { recursive: true, force: true })
  }
  await pruneRefs(host, queue, older)
}

async function pruneOne(host: HandoffHost, journal: Journal, older: (hid: string, ms: number) => boolean): Promise<void> {
  if (!AT_REST.includes(journal.phase)) return
  const work = host.paths.handoffWork(journal.hid, journal.siteId)
  await rm(join(work, 'code.bundle'), { force: true })
  await rm(join(work, 'index'), { force: true })
  await rm(join(work, 'staging'), { recursive: true, force: true })
  await rm(join(work, 'manifest.json'), { force: true })
  const replaced = join(work, 'replaced')
  const backupAge = older(journal.hid, HANDOFF_BACKUP_DAYS * DAY_MS)
  if (journal.phase === 'done') await rm(replaced, { recursive: true, force: true })
  else if (journal.phase === 'aborted') {
    // `aborted` promises everything came back, so `replaced/` should be empty; if it is not, it waits
    // as long as a backup, and says so.
    const removedEmpty = await rmdir(replaced).then(() => true, (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
    if (!removedEmpty) {
      // Its journal and folder wait with it: without them, nothing would ever come back for it.
      if (!backupAge) return
      host.log.warn(`handoff ${journal.hid}: removed what an aborted handoff left in replaced/ after ${HANDOFF_BACKUP_DAYS} days`)
      await rm(replaced, { recursive: true, force: true })
    }
  } else if (journal.phase === 'committed' && backupAge) await rm(replaced, { recursive: true, force: true })

  const journalAge = journal.phase === 'committed' ? backupAge : older(journal.hid, DAY_MS)
  if (journalAge) {
    await rm(work, { recursive: true, force: true })
    await rm(host.paths.journalFile(journal.hid, journal.siteId), { force: true })
  }
}

/**
 * The refs, repo by repo: backups and rescues after HANDOFF_BACKUP_DAYS; a `refs/factotum/handoff/<hid>/*`
 * as soon as its project has no live journal of that handoff — only a failure leaves one behind.
 */
async function pruneRefs(host: HandoffHost, queue: KeyedQueue, older: (hid: string, ms: number) => boolean): Promise<void> {
  const options = host.gitEnv !== undefined ? { base: host.gitEnv } : {}
  for (const project of host.projects()) {
    await queue.run(project.id, async () => {
      const refs = await handoffGit(project.path, ['for-each-ref', '--format=%(refname)', 'refs/factotum/'], options).then(
        (out) => out.split('\n').filter(Boolean),
        () => undefined,
      )
      if (refs === undefined) {
        // Not a repo any more: skipped, and said without its path.
        host.log.info(`handoff prune: project ${project.id} is not a repo; skipped`)
        return
      }
      for (const ref of refs) {
        const match = /^refs\/factotum\/(handoff-backup|handoff-rescue|handoff)\/([^/]+)/.exec(ref)
        const hid = match?.[2]
        if (match === null || hid === undefined || !isHandoffId(hid)) continue
        const journal = (await listJournals(host.paths, hid)).find((j) => j.siteId === project.id)
        const goes =
          match[1] === 'handoff'
            ? journal === undefined || AT_REST.includes(journal.phase)
            : older(hid, HANDOFF_BACKUP_DAYS * DAY_MS)
        if (goes && journal?.phase !== 'abort-failed') await handoffGit(project.path, ['update-ref', '-d', ref], options).catch(() => undefined)
      }
    })
  }
}
