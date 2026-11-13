/**
 * `createJobs`, the facade (design D3 «La fachada», D13; tasks C1). IT ONLY COMPOSES what B–E, G–H,
 * L, N and R1–R2 already built — no method here does work of its own beyond reading a view.
 *
 * `start` (this function) IN D13's ORDER, all local, no network and no child process, to fit in 10 s:
 * 1. parse the config; in `relay`, only `where` — and return;
 * 2. open `jobs.db` with the startup write in ONE `tx`: `recoverOnStart` (`sending → send-unknown`,
 *    `work.running → queued`, `checking → unverified`), then `applyDeferredRepliesOnStart`; the seed
 *    profile becomes version 1 on an empty store (D7);
 * 3. look for the vault, the master CV, the guide, the seed files, chromium, poppler and `claude` on PATH,
 *    and read the CV font — a miss WARNS in
 *    `health()`, never switches the module off (the tracker serves without them);
 * 4. arm the clock (D16) WITHOUT WAITING for its first round; the check queue takes back what the
 *    startup write took out of `checking` (T-D2);
 * 5. launch, WITHOUT WAITING, the `lstat` of the password file (`mail-health.ts`): never its content.
 * The clock is armed LAST of steps 4–5; a step that throws stops whatever is live, then closes the store.
 *
 * `stop`: the imports in flight, the clock, the ad walk, the checks, the queue (its runs aborted), the
 * sends in flight (aborted WITHOUT their step 3: they stay `sending`, the next start makes them
 * `send-unknown`) — all awaited — then the store closes (`facade/lifecycle.ts`).
 *
 * THE LAYERS are built in `facade/layers.ts`, the reads in `facade/reads.ts`; `compose` is the glue.
 */

import { existsSync } from 'node:fs'

import { z } from 'zod'

import type { Queue } from './ai/queue.ts'
import type { CheckQueue } from './build/checks.ts'
import { createLinter, saveProfileRelinting, saveRuleRelinting, type Linter } from './build/relint.ts'
import { parseJobsConfig, type HostConfig } from './config.ts'
import { buildCheckLayer, buildClock, buildGeneration, buildSendLayer, failing, type Base } from './facade/layers.ts'
import { inFlight, lifecycle, type InFlight, type Lifecycle } from './facade/lifecycle.ts'
import { views, type Reads } from './facade/reads.ts'
import { checkPaths, generationWarnings, readFont, vaultReader } from './facade/sources.ts'
import type { CreateJobsResult, DecisionInput, Health, Jobs, JobsDeps, RetryJob } from './facade/types.ts'
import { applicationCard, sendView } from './facade/views.ts'
import { closeApplication } from './owner/close.ts'
import { ensureProfile } from './profile.ts'
import { decide, DECISION_KINDS, MAX_SEEN_CHARS } from './review/decide.ts'
import { openReview } from './review/open.ts'
import { importSeed } from './seed/import.ts'
import type { ImportReport } from './seed/report.ts'
import { applyDeferredRepliesOnStart } from './send/deferred.ts'
import { NO_LETTER_YET } from './state.ts'
import { openDb, type Db } from './store/db.ts'
import * as repo from './store/repo.ts'
import { fail, ok, type Result, type Send, type SendKind } from './types.ts'

/** The `letter` handler's reason until T1 (§M); its `missing-letter` says it (`state.ts`). */
export { NO_LETTER_YET }
/** A handler that always fails with its reason (`facade/layers.ts`). */
export { failing }
/** Until H5c, nothing reprints a CV: «Retry print» says so. */
export const NO_REPRINT_YET = 'reprint arrives with H5c'

const decisionSchema = z.strictObject({
  itemId: z.string().min(1).max(64),
  kind: z.enum(DECISION_KINDS),
  reason: z.string().max(200).optional(),
  text: z.string().max(4000).optional(),
  addressOverride: z.boolean().optional(),
  warningCodes: z.array(z.string().max(40)).max(20).optional(),
  seen: z.string().min(1).max(MAX_SEEN_CHARS),
})

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Step 2: the store, the startup write in one `tx`, and the profile. */
async function openStore(deps: JobsDeps): Promise<Result<Db>> {
  const opened = await openDb({ dir: deps.stateDir, now: deps.now })
  if (!opened.ok) return opened
  const db = opened.value
  const at = deps.now()
  let recovered = db.tx((q) => {
    const done = repo.recoverOnStart(q, at)
    const replies = applyDeferredRepliesOnStart(q, at)
    return replies.ok ? ok(done) : replies
  })
  if (!recovered.ok) {
    // The deferred replies wait for the next start; the recovery itself never does.
    deps.log.error(`jobs: the deferred replies were not applied at start (${recovered.error.reason})`)
    recovered = db.tx((q) => ok(repo.recoverOnStart(q, at)))
  }
  if (!recovered.ok) {
    db.close()
    return fail('module-error', `the startup write failed (${recovered.error.reason})`)
  }
  for (const skip of recovered.value.skipped) deps.log.warn(`jobs: the startup write skipped ${skip.kind} ${skip.id} (${skip.reason})`)
  const profile = ensureProfile(db, { now: deps.now })
  if (!profile.ok) {
    db.close()
    return profile
  }
  return ok(db)
}

export async function createJobs(deps: JobsDeps): Promise<CreateJobsResult> {
  const parsed = parseJobsConfig(deps.config)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const { config, timeZone } = parsed
  if (config.mode === 'relay') {
    const host = config.relayTo
    return { ok: true, relay: { where: () => ({ mode: 'relay', host }), stop: async () => undefined } }
  }
  const stored = await openStore(deps)
  if (!stored.ok) return { ok: false, reason: stored.error.reason }
  let composed: Composed
  try {
    composed = compose(deps, config, timeZone, stored.value)
  } catch (error) {
    // Nothing is live yet: building arms no timer and starts no run.
    stored.value.close()
    return { ok: false, reason: `jobs could not start (${messageOf(error)})` }
  }
  try {
    composed.start()
  } catch (error) {
    // Something may be live (the check queue, the clock): `stop` halts all of it, then closes the store.
    await composed.jobs.stop()
    return { ok: false, reason: `jobs could not start (${messageOf(error)})` }
  }
  return { ok: true, jobs: composed.jobs }
}

/** The facade, built but not started; `start` runs steps 4–5 (D13) and may throw. */
interface Composed {
  readonly jobs: Jobs
  readonly start: () => void
}

function compose(deps: JobsDeps, config: HostConfig, timeZone: string, db: Db): Composed {
  const { log, now, stateDir } = deps
  const base: Base = { db, deps, config, timeZone }

  // Step 3: what is on disk.
  const font = readFont()
  const lookup = { claudeBin: deps.claudeBin, envPath: process.env.PATH ?? '' }
  const disk = (): Health['paths'] => checkPaths(config, font, lookup)
  const paths = disk()
  const vault = vaultReader(config.vault)
  const linter = createLinter({ master: vault.master, pdfExists: existsSync })

  const { checks, ads, enqueueCheck } = buildCheckLayer(base)
  const { password, sender, assist } = buildSendLayer(base, enqueueCheck)
  const { queue } = buildGeneration(base, { font, vault, linter })
  const clock = buildClock(base, { queue, ads, checks })
  const review = openReview({ db, now, timeZone, enqueueChecks: (ids) => checks.enqueueContacts(ids, { front: true }), log })
  const reads = views({ db, queue, mail: password.current, paths, stateDir, now, timeZone })
  const imports = inFlight()

  const life = lifecycle({
    start: [
      // Step 4: the contacts the startup write took out of `checking`, in front.
      checks.enqueueRestarted,
      // Step 5: the password file's `lstat`, never awaited.
      () => void password.check().catch((error: unknown) => log.error(`jobs: the password file check failed (${messageOf(error)})`)),
      // Step 4: the tick, without waiting for it — LAST, after everything that can throw.
      clock.start,
    ],
    stop: [
      // An import writes into the store and the queue: it ends before either stops.
      [{ name: 'the imports', stop: imports.settled }],
      [{ name: 'the clock', stop: clock.stop }],
      [
        { name: 'the ad walk', stop: ads.stop },
        { name: 'the check queue', stop: checks.stop },
        { name: 'the generation queue', stop: queue.stop },
        { name: 'the sender', stop: sender.stop },
      ],
    ],
    close: db.close,
    log,
  })

  const jobs = facade({ base, linter, queue, checks, sender, assist, review, reads, imports, life, disk })
  return { jobs, start: life.start }
}

type SendLayer = ReturnType<typeof buildSendLayer>

/** What the `Jobs` methods call into. */
interface Parts {
  readonly base: Base
  readonly linter: Linter
  readonly queue: Queue
  readonly checks: CheckQueue
  readonly sender: SendLayer['sender']
  readonly assist: SendLayer['assist']
  readonly review: ReturnType<typeof openReview>
  readonly reads: Reads
  readonly imports: InFlight
  readonly life: Lifecycle
  /** What is on disk NOW (step 3's check, again): the import says what would fail its CVs. */
  readonly disk: () => Health['paths']
}

const viewSend = (result: Result<Send>): Result<ReturnType<typeof sendView>> => (result.ok ? ok(sendView(result.value)) : result)

/** The seed import, then a pump for the CVs it queued. */
async function importNow({ base, queue, checks, disk }: Parts, input: { readonly dryRun: boolean }): Promise<Result<ImportReport>> {
  const { db, deps, config, timeZone } = base
  const report = await importSeed(
    db,
    { now: deps.now, timeZone, vault: config.vault, enqueueCv: queue.enqueueCv, enqueueSeedChecks: (ids) => checks.enqueueContacts(ids, { front: true }), log: deps.log },
    { dryRun: input.dryRun === true },
  )
  queue.pump()
  if (!report.ok) return report
  // A wrong guide path, or no `claude` on PATH, fails every CV the import queues: say it before (review 1a).
  const gaps = generationWarnings(disk())
  return gaps.length === 0 ? report : ok({ ...report.value, warnings: [...gaps, ...report.value.warnings] })
}

function retryOf({ base, queue }: Parts, id: string, job: RetryJob): Result<{ readonly queued: readonly ('cv' | 'letter')[] }> {
  if (job === 'reprint') return fail('conflict', NO_REPRINT_YET)
  const done = base.db.tx((q) => queue.retry(q, id))
  if (!done.ok) return done
  queue.pump()
  return ok({ queued: done.value })
}

/** The `Jobs` object: each method a call into a part. */
function facade(parts: Parts): Jobs {
  const { base, linter, queue, sender, assist, review, reads, imports, life } = parts
  const { db } = base
  const { now, log } = base.deps
  const relintDeps = { now, linter, log, enqueueReprint: (): void => undefined } // H5c connects the reprint
  return {
    where: () => ({ mode: 'host' }),
    overview: reads.overview,
    application: (id) =>
      db.read((q) => {
        const app = repo.getApplication(q, id)
        const profile = repo.latestProfileVersion(q)?.profile
        if (app === undefined || profile === undefined) return fail('not-found', 'no such application')
        return ok({ application: applicationCard(q, app, profile), events: repo.eventsOf(q, id) })
      }),
    importSeed: async (input) => (life.stopping() ? fail('conflict', 'stopping') : imports.track(importNow(parts, input))),
    profile: () => {
      const current = db.read((q) => repo.latestProfileVersion(q))
      if (current === undefined) throw new Error('jobs: the profile is gone')
      return current
    },
    saveProfile: (input) => saveProfileRelinting(db, input, relintDeps),
    rules: () => db.read((q) => repo.listRules(q)),
    saveRule: (input, id) => saveRuleRelinting(db, input, relintDeps, id),
    startBatch: () => {
      const started = review.startBatch()
      return started.ok ? ok(reads.answer(started.value)) : started
    },
    batch: () => {
      const open = review.batch()
      return open.ok ? ok(reads.answer(open.value)) : open
    },
    decide: (input) => {
      const parsed = decisionSchema.safeParse(input)
      if (!parsed.success) return fail('invalid', parsed.error.issues[0]?.message ?? 'invalid', parsed.error.issues[0]?.path.join('.') || 'body')
      return decide({ db, now, approve: sender.approve, queue, pdfExists: existsSync, relintOne: linter.relintOne, log }, parsed.data as DecisionInput)
    },
    retry: (id, job) => retryOf(parts, id, job),
    send: (id, kind: SendKind) => viewSend(sender.send(id, kind)),
    markSent: (id, kind) => assist.markSent(id, kind),
    resolveUnknown: (id, kind, answer, options) => viewSend(assist.resolveUnknown(id, kind, answer, options)),
    retrySend: (id, kind, options) => viewSend(assist.retrySend(id, kind, options)),
    close: (id, input) => closeApplication(db, { now }, id, input),
    health: reads.health,
    file: reads.file,
    stop: life.stop,
  }
}
