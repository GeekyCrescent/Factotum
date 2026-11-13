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
import type { Queries } from '../store/db.ts'
import { APP_STATES, fail, ok, type Application, type Result } from '../types.ts'
import { confinedArtifact, pathWarnings } from './sources.ts'
import type { BatchAnswer, Health, Overview, SendNeed } from './types.ts'
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
      const open = repo.openBatch(q)
      const phone = repo.latestProfileVersion(q)?.profile.identity?.phone ?? ''
      return {
        counts: countsOf(apps),
        reviewable: readyOutside(q, open?.items ?? []),
        batchOpen: open !== undefined,
        missingPhone: phone.trim() === '',
        notices: health().warnings,
        sends: sendsNeeding(q, apps),
        byState: byStateOf(apps),
      }
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

const initialSent = (app: Application): boolean => app.sends.some((send) => send.kind === 'initial' && send.state === 'sent')

/** crit. 63, the screen's six counters. */
function countsOf(apps: readonly Application[]): Overview['counts'] {
  const count = (keep: (app: Application) => boolean): number => apps.filter(keep).length
  return {
    toReview: count((app) => app.state === 'in-review' || app.state === 'ready'),
    approvedNotSent: count((app) => app.state === 'approved'),
    sent: count(initialSent),
    awaitingReply: count((app) => app.state === 'sent'),
    interviews: count((app) => app.outcome === 'interview'),
    offers: count((app) => app.outcome === 'offer'),
  }
}

function byStateOf(apps: readonly Application[]): Overview['byState'] {
  return apps.reduce<Partial<Record<Application['state'], number>>>((counts, app) => ({ ...counts, [app.state]: (counts[app.state] ?? 0) + 1 }), {})
}

/** The sends the owner has to answer: `send-unknown` or `failed`, of an application not closed. */
function sendsNeeding(q: Queries, apps: readonly Application[]): readonly SendNeed[] {
  return apps
    .filter((app) => app.state !== 'closed')
    .flatMap((app) =>
      app.sends.flatMap((send): SendNeed[] =>
        send.state === 'send-unknown' || send.state === 'failed'
          ? [{ applicationId: app.id, company: repo.getCompany(q, app.companyId)?.name ?? '', kind: send.kind, state: send.state, at: send.at, reason: send.reason }]
          : [],
      ),
    )
    .toSorted((a, b) => a.at.localeCompare(b.at) || a.applicationId.localeCompare(b.applicationId))
}
