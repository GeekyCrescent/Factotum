/**
 * THE SENDING SIDE of a handoff (spec 2026-10-07-dos-hosts, D9): the factory the handoff and the
 * startup use. One project's steps are `ProjectRun` (`source-run.ts`); steps 13–15, which the startup's
 * row `acked` shares, are here.
 */

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { HANDOFF_HOLDER_PREFIX } from '../locks.ts'
import { HANDOFF_FILE_MAX_BYTES } from './constants.ts'
import { handoffGit } from './git.ts'
import type { HandoffHost } from './host.ts'
import { newJournal, writeJournal, type Journal } from './journal.ts'
import type { PlannedProject } from './plan.ts'
import { HANDOFF_STATUS_WAIT_MS, NOTICE_TIMEOUT_MS, ProjectRun, STATUS_POLL_MS } from './source-run.ts'
import { cleanSource } from './wip.ts'

export { COMMIT_TIMEOUT_MS, fileTimeoutMs, HANDOFF_MANIFEST_TIMEOUT_MS, HANDOFF_STATUS_WAIT_MS, NOTICE_TIMEOUT_MS, PREPARE_TIMEOUT_MS, STATUS_POLL_MS, toldOf } from './source-run.ts'

export interface SourceDeps {
  readonly host: HandoffHost
  /** Waiting between two `status`: on the module's timers, so a test moves it. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly statusWaitMs?: number
  readonly statusPollMs?: number
  /** Tests lower it to reach `code-too-large` without a 256 MiB repo. */
  readonly maxBundleBytes?: number
}

export function createSource(deps: SourceDeps) {
  const { host } = deps
  const runDeps = {
    host,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => host.timers.setTimeout(resolve, ms))),
    statusWaitMs: deps.statusWaitMs ?? HANDOFF_STATUS_WAIT_MS,
    statusPollMs: deps.statusPollMs ?? STATUS_POLL_MS,
    maxBundleBytes: deps.maxBundleBytes ?? HANDOFF_FILE_MAX_BYTES,
    cleanAndRelease: (journal: Journal, tellPeer?: boolean) => cleanAndRelease(journal, tellPeer),
  }

  /**
   * One project, steps 1–15, inside its handoff queue; answers its final journal. NOTHING ESCAPES WITH
   * THE LOCK HELD: an error a step throws is recovered by what the phase says (`ProjectRun.recover`).
   */
  async function moveProject(hid: string, to: string, project: PlannedProject): Promise<Journal> {
    const run = new ProjectRun(runDeps, project, {
      ...newJournal({ hid, siteId: project.siteId, role: 'source', peer: to, phase: 'locking', at: host.now().toISOString() }),
      peerSiteId: project.targetSiteId,
      branch: project.branch,
      sessionIds: [...project.sessions],
    })
    try {
      return await run.run()
    } catch {
      return await run.recover()
    }
  }

  /** The steps of a journal found on disk, for the startup (D11). */
  function resumeOf(journal: Journal): ProjectRun {
    const project: PlannedProject = {
      siteId: journal.siteId,
      targetSiteId: journal.peerSiteId ?? '',
      branch: journal.branch ?? '',
      head: journal.head ?? '',
      sessions: journal.sessionIds ?? [],
      localCommits: 0,
      changedFiles: 0,
      newUntracked: [],
      bytes: 0,
      warnings: [],
    }
    return new ProjectRun(runDeps, project, journal)
  }

  /**
   * Steps 13–15, also the startup's row `acked` (D11): clean the source if it is still what travelled,
   * drop the bundle, `done`, let go — and tell the peer once, without waiting for it to work out.
   *
   * A CLEANUP THAT FAILS IS NOT A REASON TO HOLD THE PROJECT: the sessions are the other host's already.
   * The tree is then left as it is (nothing was reset), the WIP kept in the backup ref, and it says so.
   */
  async function cleanAndRelease(start: Journal, tellPeer = true): Promise<Journal> {
    let journal = start
    const path = host.projects().find((p) => p.id === journal.siteId)?.path
    const work = host.paths.handoffWork(journal.hid, journal.siteId)
    const options = host.gitEnv !== undefined ? { base: host.gitEnv } : {}
    // After a restart the work folder may be gone; the temporary index of `wipTree` lives in it.
    await mkdir(work, { recursive: true })
    if (path !== undefined && journal.head !== undefined && journal.tree !== undefined) {
      const cleaned = await cleanSource(path, { hid: journal.hid, head: journal.head, wip: journal.wip, tree: journal.tree, indexFile: join(work, 'index'), ...(host.gitEnv !== undefined ? { env: host.gitEnv } : {}) }).catch(
        () => 'source-changed-during-handoff' as const,
      )
      if (cleaned !== 'cleaned') {
        host.log.warn(`handoff ${journal.hid}: ${journal.siteId} changed here during the handoff, or could not be cleaned; the WIP is kept in refs/factotum/handoff-backup/${journal.hid}`)
        if (journal.wip !== undefined) await handoffGit(path, ['update-ref', `refs/factotum/handoff-backup/${journal.hid}`, journal.wip], options).catch(() => undefined)
        journal = { ...journal, warnings: [...journal.warnings, cleaned] }
      }
    }
    await rm(join(work, 'code.bundle'), { force: true })
    journal = { ...journal, phase: 'done', at: host.now().toISOString() }
    await writeJournal(host.paths, journal)
    await host.locks.release(journal.siteId, `${HANDOFF_HOLDER_PREFIX}${journal.hid}`)
    // ONCE, and nobody retries it: the target's leftovers go with it or with its prune (v4.1).
    if (tellPeer) await host.peers.json(journal.peer, 'POST', `handoff/${journal.hid}/${journal.peerSiteId}/done`, {}, { timeoutMs: NOTICE_TIMEOUT_MS })
    return journal
  }

  return { moveProject, cleanAndRelease, resumeOf }
}

export type Source = ReturnType<typeof createSource>
