/**
 * The facade's reads (design D13 `GET /health`, D15; tasks C1): `health`, `overview`, the batch's
 * `answer` and a version's `file`. Synchronous, no write: caches and one `db.read` each.
 */

import type { Queue } from '../ai/queue.ts'
import { BACKUP_FAILING } from '../clock.ts'
import type { MailHealth } from '../mail-health.ts'
import type { SeenBatch } from '../review/seen.ts'
import type { Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { APP_STATES, fail, ok, type Result } from '../types.ts'
import { confinedArtifact, pathWarnings } from './sources.ts'
import type { BatchAnswer, Health, Overview } from './types.ts'
import { batchView, readyOutside } from './views.ts'

export interface ReadsDeps {
  readonly db: Db
  readonly queue: Pick<Queue, 'pausedUntil' | 'running'>
  /** The password file's cache (D13 step 5). */
  readonly mail: () => MailHealth
  /** What step 3 found on disk. */
  readonly paths: Health['paths']
  readonly stateDir: string
}

export interface Reads {
  readonly health: () => Health
  readonly overview: () => Overview
  readonly answer: (batch: SeenBatch | null) => BatchAnswer
  readonly file: (id: string, version: number, kind: 'pdf' | 'png') => Result<string>
}

export function views({ db, queue, mail: mailNow, paths, stateDir }: ReadsDeps): Reads {
  function health(): Health {
    const mail = mailNow()
    const backupFailing = db.read((q) => repo.getMeta(q, BACKUP_FAILING)) ?? null
    const pausedUntil = queue.pausedUntil()
    const warnings = [
      ...(mail.state === 'bad' && mail.reason !== null ? [mail.reason] : []),
      ...pathWarnings(paths),
      ...(pausedUntil === null ? [] : [`Claude usage limit — resumes at ${pausedUntil}`]),
      ...(backupFailing === null ? [] : ['The daily copy of jobs.db keeps failing']),
    ]
    return { mail, queue: { pausedUntil, running: queue.running().length }, paths, backupFailing, warnings }
  }

  function answer(batch: SeenBatch | null): BatchAnswer {
    return db.read((q) => {
      const profile = repo.latestProfileVersion(q)?.profile
      return { batch: batch === null || profile === undefined ? null : batchView(q, batch, profile), ready: readyOutside(q, batch?.items ?? []) }
    })
  }

  function overview(): Overview {
    return db.read((q) => {
      const apps = repo.applicationsByState(q, [...APP_STATES]).filter((app) => !app.test)
      const counts: Partial<Record<(typeof APP_STATES)[number], number>> = {}
      for (const app of apps) counts[app.state] = (counts[app.state] ?? 0) + 1
      const open = repo.openBatch(q)?.items ?? []
      return { counts, ready: readyOutside(q, open), warnings: health().warnings }
    })
  }

  function file(id: string, version: number, kind: 'pdf' | 'png'): Result<string> {
    const artifacts = db.read((q) => repo.getArtifacts(q, id, version))
    const stored = kind === 'pdf' ? artifacts?.pdf : artifacts?.png
    if (stored === null || stored === undefined) return fail('not-found', `no ${kind} for this version`)
    const real = confinedArtifact(stateDir, stored, kind === 'pdf' ? '.pdf' : '.png')
    return real === null ? fail('not-found', `no ${kind} for this version`) : ok(real)
  }

  return { health, overview, answer, file }
}
