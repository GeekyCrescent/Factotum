/**
 * The live ad's caller (design D9 «El anuncio vivo»; requirements crit. 24, 46b): every vacancy in
 * review whose last look is older than 24 h is revalidated IN THE BACKGROUND, one at a time, from the
 * clock's round — never inside «Start review», which stays synchronous and off the network.
 *
 * `revalidateAd` decides what is due (`whyNot`: fresh, not a vacancy, no URL…) and writes the verdict;
 * this only walks the candidates. A `kick` while a walk is under way does nothing: the next round
 * picks up whatever this one did not reach.
 */

import type { Logger } from '@factotum/core'

import { AD_STALE_MS, revalidateAd } from '../build/revalidate.ts'
import type { Net } from '../scout/net.ts'
import type { Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'

export interface AdRevalidatorDeps {
  readonly db: Db
  readonly net: Net
  readonly now: () => Date
  readonly log: Logger
}

export interface AdRevalidator {
  /** Starts a walk unless one is under way. Never throws, never waits. */
  readonly kick: () => void
  /** Resolves when no walk is under way. */
  readonly idle: () => Promise<void>
  /** Aborts the `GET` under way and waits for the walk to end. */
  readonly stop: () => Promise<void>
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** In-review and ready vacancies with a URL whose ad was never looked at or not in the last 24 h. */
function dueApplications(db: Db, now: Date): readonly string[] {
  return db.read((q) =>
    repo.applicationsByState(q, ['in-review', 'ready']).flatMap((app) => {
      const opportunity = repo.getOpportunity(q, app.opportunityId)
      if (opportunity === undefined || opportunity.kind !== 'vacancy' || opportunity.url === null || opportunity.status !== 'open') return []
      const checked = opportunity.checkedAt === null ? Number.NaN : Date.parse(opportunity.checkedAt)
      const fresh = !Number.isNaN(checked) && now.getTime() - checked < AD_STALE_MS
      return fresh ? [] : [app.id]
    }),
  )
}

export function createAdRevalidator(deps: AdRevalidatorDeps): AdRevalidator {
  let walking: Promise<void> | null = null
  let controller = new AbortController()
  let stopped = false

  async function walk(): Promise<void> {
    for (const id of dueApplications(deps.db, deps.now())) {
      if (stopped) return
      const outcome = await revalidateAd({ db: deps.db, net: deps.net, now: deps.now }, id, controller.signal)
      if (!outcome.ok) deps.log.warn(`jobs: the ad of application ${id} was not revalidated (${outcome.error.reason})`)
    }
  }

  return {
    kick: () => {
      if (stopped || walking !== null) return
      walking = walk()
        .catch((error: unknown) => deps.log.error(`jobs: the ad revalidation failed (${messageOf(error)})`))
        .finally(() => {
          walking = null
        })
    },
    idle: async () => {
      await walking
    },
    stop: async () => {
      stopped = true
      controller.abort()
      await walking
      controller = new AbortController()
    },
  }
}
