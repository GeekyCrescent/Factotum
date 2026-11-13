/**
 * `createJobs`, the facade (design D3 «La fachada», D13; tasks C1). IT ONLY COMPOSES what B–E, G–H,
 * L, N and R1–R2 already built — no method here does work of its own beyond reading a view.
 *
 * `start` (this function) IN D13's ORDER, all local, no network and no child process, to fit in 10 s:
 * 1. parse the config; in `relay`, only `where` — and return;
 * 2. open `jobs.db` with the startup write in ONE `tx`: `recoverOnStart` (`sending → send-unknown`,
 *    `work.running → queued`, `checking → unverified`), then `applyDeferredRepliesOnStart`; the seed
 *    profile becomes version 1 on an empty store (D7);
 * 3. look for the vault, the master CV, chromium and poppler, and read the CV font — a miss WARNS in
 *    `health()`, never switches the module off (the tracker serves without them);
 * 4. arm the clock (D16) WITHOUT WAITING for its first round; the check queue takes back what the
 *    startup write took out of `checking` (T-D2);
 * 5. launch, WITHOUT WAITING, the `lstat` of the password file (`mail-health.ts`): never its content.
 * The clock is armed LAST of steps 4–5; a step that throws stops whatever is live, then closes the store.
 *
 * `stop`: the clock, the ad walk, the checks, the queue (its runs aborted), the sends in flight
 * (aborted WITHOUT their step 3: they stay `sending`, the next start makes them `send-unknown`) — all
 * awaited — then the store closes.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { sendMail as smtpSend } from '@factotum/mail'
import { z } from 'zod'

import { createQueue, type JobHandler } from './ai/queue.ts'
import { addressSearch } from './build/address.ts'
import { createCheckQueue } from './build/checks.ts'
import { createCvHandler, type ClaudeSettings } from './build/cv.ts'
import { createLinter, saveProfileRelinting, saveRuleRelinting } from './build/relint.ts'
import { createVerifier } from './build/verify.ts'
import { BACKUP_FAILING, createClock } from './clock.ts'
import { parseJobsConfig, type HostConfig } from './config.ts'
import { createAdRevalidator } from './facade/ads.ts'
import { stopInOrder } from './facade/lifecycle.ts'
import { checkPaths, confinedArtifact, pathWarnings, printer, readFont, vaultReader } from './facade/sources.ts'
import type { BatchAnswer, CreateJobsResult, DecisionInput, Health, Jobs, JobsDeps, Overview, RetryJob } from './facade/types.ts'
import { applicationCard, batchView, readyOutside, sendView } from './facade/views.ts'
import { createPasswordHealth } from './mail-health.ts'
import { closeApplication } from './owner/close.ts'
import { ensureProfile } from './profile.ts'
import { decide, DECISION_KINDS } from './review/decide.ts'
import { openReview } from './review/open.ts'
import { createRewriteHandler } from './review/rewrite.ts'
import type { SeenBatch } from './review/seen.ts'
import { createNet, systemLookup } from './scout/net.ts'
import { importSeed } from './seed/import.ts'
import type { ImportReport } from './seed/report.ts'
import { createAssist } from './send/assist.ts'
import { applyDeferredRepliesOnStart } from './send/deferred.ts'
import { createSender } from './send/send.ts'
import { openDb, type Db } from './store/db.ts'
import * as repo from './store/repo.ts'
import { APP_STATES, fail, ok, type Profile, type Result, type Send, type SendKind } from './types.ts'

/** Until T1 writes `draftOutreach`, nothing generates a letter: a `letter` work fails with this (§M). */
export const NO_LETTER_YET = 'letter generation arrives with T1'
/** Until H5c, nothing reprints a CV: «Retry print» says so. */
export const NO_REPRINT_YET = 'reprint arrives with H5c'

const decisionSchema = z.strictObject({
  itemId: z.string().min(1).max(64),
  kind: z.enum(DECISION_KINDS),
  reason: z.string().max(200).optional(),
  text: z.string().max(4000).optional(),
  addressOverride: z.boolean().optional(),
  warningCodes: z.array(z.string().max(40)).max(20).optional(),
  seen: z.string().max(128).optional(),
})

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const failing =
  (reason: string): JobHandler =>
  async () => ({ ok: false, kind: 'failed', reason })

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

const claudeOf = (model: string, deps: JobsDeps): ClaudeSettings => ({ model, effort: undefined, bin: deps.claudeBin })

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
  const { log, now, timers, stateDir } = deps

  // Step 3: what is on disk.
  const font = readFont()
  const paths = checkPaths(config, font)
  const vault = vaultReader(config.vault)
  const linter = createLinter({ master: vault.master, pdfExists: existsSync })

  // The network of the address checks and the live ad: https only, private ranges refused (N1).
  const net = createNet({ fetch: deps.fetch ?? globalThis.fetch, lookup: deps.lookup ?? systemLookup, timers, now, politeMs: config.scout.politeMs })
  const checks = createCheckQueue({ db, timers, now, search: addressSearch(net), log })
  const enqueueCheck = (contactId: string, options: { readonly front: true }): unknown => checks.enqueueCheck(contactId, options)
  const ads = createAdRevalidator({ db, net, now, log })

  // Step 5's cache; every real read refreshes it.
  const password = createPasswordHealth({ file: config.mail.passwordFile, now, ...(deps.lstat === undefined ? {} : { lstat: deps.lstat }), ...(deps.readPassword === undefined ? {} : { readPassword: deps.readPassword }) })

  const sender = createSender({
    db,
    now,
    timers,
    timeZone,
    mail: { address: config.mail.address, displayName: config.mail.displayName, passwordFile: config.mail.passwordFile, smtpHost: config.mail.smtpHost, maxSendsPerDay: config.mail.maxSendsPerDay },
    readPassword: password.readPassword,
    sendMail: deps.sendMail ?? smtpSend,
    enqueueCheck,
    log,
    stateDir,
  })
  const assist = createAssist({ db, now, timeZone, maxSendsPerDay: config.mail.maxSendsPerDay, sender, enqueueCheck })

  // The generation queue and its handlers (G2a, H5a/H5b, R2), the real linter as its guard (L4).
  const printDeps = { stateDir, timers, log, font: font ?? new Uint8Array(), chromium: config.chromium, poppler: config.poppler }
  const verify = createVerifier({ stateDir, now, timers, log, claude: claudeOf(config.claude.models.verify, deps), sources: vault.fixed })
  const cv = font === null ? failing('the CV font could not be read') : createCvHandler({ db, ...printDeps, now, sources: vault.sources, claude: claudeOf(config.claude.models.write, deps), verify })
  const rewrite = createRewriteHandler({
    db,
    now,
    timers,
    stateDir,
    runDir: join(stateDir, 'run'),
    claude: { model: config.claude.models.write, effort: undefined, ...(deps.claudeBin === undefined ? {} : { bin: deps.claudeBin }) },
    readFixed: vault.fixed,
    print: printer(db, printDeps),
    verify,
    log,
  })
  const queue = createQueue({
    db,
    now,
    concurrency: config.claude.concurrency,
    handlers: { cv, rewrite, letter: failing(NO_LETTER_YET) },
    log,
    lint: linter.lint,
    relintOne: linter.relintOne,
    pdfExists: existsSync,
  })
  const review = openReview({ db, now, timeZone, enqueueChecks: (ids) => checks.enqueueContacts(ids, { front: true }), log })

  const profileNow = (): Profile => {
    const current = db.read((q) => repo.latestProfileVersion(q))
    if (current === undefined) throw new Error('jobs: the profile is gone')
    return current.profile
  }
  const seedFiles = (): readonly string[] => config.vault.seed.packages.filter((p) => p.byHand !== true).map((p) => p.file.split('/').at(-1) ?? p.file)
  const clock = createClock({
    db,
    timers,
    now,
    timeZone,
    log,
    stateDir,
    pump: queue.pump,
    prepareTick: () => {
      ads.kick() // D9 «El anuncio vivo», in the background (crit. 24, 46b)
      return checks.prepareTick({ batchSize: profileNow().batchSize })
    },
    enqueueCv: queue.enqueueCv,
    seedFiles,
  })

  /**
   * Steps 4–5. THE CLOCK IS ARMED LAST, after everything that can throw: an interval armed before a
   * step that throws would tick on the closed store.
   */
  function start(): void {
    // Step 4: the contacts the startup write took out of `checking`, in front.
    checks.enqueueRestarted()
    // Step 5: the password file's `lstat`, never awaited.
    password.check().catch((error: unknown) => log.error(`jobs: the password file check failed (${messageOf(error)})`))
    // Step 4: the tick, without waiting for it.
    clock.start()
  }

  const relintDeps = { now, linter, log, enqueueReprint: (): void => undefined } // H5c connects the reprint

  function health(): Health {
    const mail = password.current()
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

  const viewSend = (result: Result<Send>): Result<ReturnType<typeof sendView>> => (result.ok ? ok(sendView(result.value)) : result)

  function overview(): Overview {
    return db.read((q) => {
      const apps = repo.applicationsByState(q, [...APP_STATES]).filter((app) => !app.test)
      const counts: Partial<Record<(typeof APP_STATES)[number], number>> = {}
      for (const app of apps) counts[app.state] = (counts[app.state] ?? 0) + 1
      const open = repo.openBatch(q)?.items ?? []
      return { counts, ready: readyOutside(q, open), warnings: health().warnings }
    })
  }

  function retry(id: string, job: RetryJob): Result<{ readonly queued: readonly ('cv' | 'letter')[] }> {
    if (job === 'reprint') return fail('conflict', NO_REPRINT_YET)
    const done = db.tx((q) => queue.retry(q, id))
    if (!done.ok) return done
    queue.pump()
    return ok({ queued: done.value })
  }

  function file(id: string, version: number, kind: 'pdf' | 'png'): Result<string> {
    const artifacts = db.read((q) => repo.getArtifacts(q, id, version))
    const stored = kind === 'pdf' ? artifacts?.pdf : artifacts?.png
    if (stored === null || stored === undefined) return fail('not-found', `no ${kind} for this version`)
    const real = confinedArtifact(stateDir, stored, kind === 'pdf' ? '.pdf' : '.png')
    return real === null ? fail('not-found', `no ${kind} for this version`) : ok(real)
  }

  /** The imports in flight: `stop` waits for them before anything else, and refuses new ones. */
  const imports = new Set<Promise<unknown>>()
  async function importNow(input: { readonly dryRun: boolean }): Promise<Result<ImportReport>> {
    const report = await importSeed(
      db,
      { now, timeZone, vault: config.vault, enqueueCv: queue.enqueueCv, enqueueSeedChecks: (ids) => checks.enqueueContacts(ids, { front: true }), log },
      { dryRun: input.dryRun === true },
    )
    queue.pump()
    return report
  }

  let stopping: Promise<void> | null = null
  const stop = (): Promise<void> =>
    stopInOrder(
      [
        // An import writes into the store and the queue: it ends before either stops.
        [{ name: 'the imports', stop: async () => void (await Promise.allSettled([...imports])) }],
        [{ name: 'the clock', stop: clock.stop }],
        [
          { name: 'the ad walk', stop: ads.stop },
          { name: 'the check queue', stop: checks.stop },
          { name: 'the generation queue', stop: queue.stop },
          { name: 'the sender', stop: sender.stop },
        ],
      ],
      db.close,
      log,
    )

  const jobs: Jobs = {
    where: () => ({ mode: 'host' }),
    overview,
    application: (id) =>
      db.read((q) => {
        const app = repo.getApplication(q, id)
        const profile = repo.latestProfileVersion(q)?.profile
        if (app === undefined || profile === undefined) return fail('not-found', 'no such application')
        return ok({ application: applicationCard(q, app, profile), events: repo.eventsOf(q, id) })
      }),
    importSeed: async (input) => {
      if (stopping !== null) return fail('conflict', 'stopping')
      const running = importNow(input)
      imports.add(running)
      try {
        return await running
      } finally {
        imports.delete(running)
      }
    },
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
      return started.ok ? ok(answer(started.value)) : started
    },
    batch: () => {
      const open = review.batch()
      return open.ok ? ok(answer(open.value)) : open
    },
    decide: (input) => {
      const parsed = decisionSchema.safeParse(input)
      if (!parsed.success) return fail('invalid', parsed.error.issues[0]?.message ?? 'invalid', parsed.error.issues[0]?.path.join('.') || 'body')
      return decide({ db, now, approve: sender.approve, queue, pdfExists: existsSync, relintOne: linter.relintOne, log }, parsed.data as DecisionInput)
    },
    retry,
    send: (id, kind: SendKind) => viewSend(sender.send(id, kind)),
    markSent: (id, kind) => assist.markSent(id, kind),
    resolveUnknown: (id, kind, answer) => viewSend(assist.resolveUnknown(id, kind, answer)),
    retrySend: (id, kind) => viewSend(assist.retrySend(id, kind)),
    close: (id, input) => closeApplication(db, { now }, id, input),
    health,
    file,
    stop: () => {
      stopping ??= stop()
      return stopping
    },
  }
  return { jobs, start }
}
