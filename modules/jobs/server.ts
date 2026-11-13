/**
 * The jobs module: thin on purpose (spec 2026-11-12-postulaciones, design D13; tasks C2).
 *
 * The store, the queue, the sender and the review all live on the other side of `createJobs`, which
 * the composition root hands in — as `tasksModule` receives its factory. This file only turns HTTP
 * into calls and back. A body goes over as it came and the engine shapes it; only the closed lists a
 * path or a one-field body carries (`:kind`, `answer`, `job`, `dryRun`) are checked here, because the
 * facade takes them typed.
 *
 * ONLY `GET` AND `POST`: the only methods the two-hosts proxy passes (ADR-0019). Every answer is
 * `no-store`: letters, addresses and CVs must not stay on the device's disk.
 *
 * THE FILES: the engine answers the path from the artifact's row, never one built from the request;
 * the kernel serves it and decides from its bytes how (a PNG inline, anything else a download,
 * ADR-0012). The download's name is the last part of the URL, so it is held to a closed alphabet
 * (D5 «Servir»), and the id and the version are checked before the engine is asked.
 *
 * Cut 1a: no `relay` mode and no `GET /where` (block Y, cut 1b).
 */

import type { FactotumModule, Logger, ModuleContext, ModuleRequest, ModuleResponse, RouteTable } from '@factotum/core'
import type { DecideAnswer, SendKind, SendView } from './client/contract.ts'
import { jobsConfigSchema } from './config.ts'
import {
  RETRY_JOBS,
  SEND_KINDS,
  UNKNOWN_ANSWERS,
  type CreateJobs,
  type Jobs,
  type JobsError,
  type Result,
  type RetryJob,
  type Send,
  type UnknownAnswer,
} from './types.ts'

const NO_STORE: Readonly<Record<string, string>> = { 'cache-control': 'no-store' }

const STARTING: ModuleResponse = {
  status: 503,
  headers: NO_STORE,
  body: { error: { code: 'starting', message: 'jobs is not ready yet' } },
}

const STATUS_OF: Readonly<Record<Exclude<JobsError['code'], 'invalid'>, number>> = {
  'not-found': 404,
  conflict: 409,
  blocked: 422,
  limit: 429,
  'module-error': 500,
}

/** An application id: what the engine mints (UUIDv7) and nothing that can climb a tree. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/
/** An artifact version: a whole number from 1, no leading zero. */
const VERSION_PATTERN = /^[1-9]\d{0,5}$/
/** The download's name (`Juan-Rodrigo-Ferro-Rayon-CV-Acme.pdf`): ASCII letters, digits and `-`. */
const PDF_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,119}\.pdf$/

function ok(body: unknown): ModuleResponse {
  return { status: 200, headers: NO_STORE, body }
}

function invalid(field: string, reason: string): ModuleResponse {
  return { status: 400, headers: NO_STORE, body: { error: { code: 'invalid-request', field, message: `${field}: ${reason}` } } }
}

function noFile(): ModuleResponse {
  return { status: 404, headers: NO_STORE, body: { error: { code: 'not-found', message: 'there is no such file' } } }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.stack ?? cause.message
  return String(cause)
}

/** The client reads `error.message` as the engine's reason (`stale`, `check-pending`…). */
function failure(error: JobsError, log: Logger): ModuleResponse {
  if (error.code === 'invalid') return invalid(error.field ?? 'body', error.reason)
  if (error.code === 'module-error') {
    // The cause is for the log only (the engine's rule): never in the body.
    log.error(error.cause === undefined ? `jobs: ${error.reason}` : `jobs: ${error.reason} — ${describe(error.cause)}`)
  }
  return { status: STATUS_OF[error.code], headers: NO_STORE, body: { error: { code: error.code, message: error.reason } } }
}

/** The poll's four fields; the rest of the engine's row (message id, the server's response) stays. */
function sendView(send: Send): SendView {
  return { kind: send.kind, state: send.state, at: send.at, reason: send.reason }
}

function fieldOf(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined
}

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
}

interface Holder {
  jobs?: Jobs
}

function routeTable(holder: Holder, log: Logger): RouteTable {
  /** Every route funnels through here, so the empty holder is handled in ONE place (crit. 4). */
  const withJobs =
    (handler: (jobs: Jobs, req: ModuleRequest) => Promise<ModuleResponse> | ModuleResponse) =>
    async (req: ModuleRequest): Promise<ModuleResponse> => {
      const jobs = holder.jobs
      if (jobs === undefined) return STARTING
      return await handler(jobs, req)
    }

  const answer = <T>(result: Result<T>, shape: (value: T) => unknown = (value) => value): ModuleResponse =>
    result.ok ? ok(shape(result.value)) : failure(result.error, log)

  const id = (req: ModuleRequest): string => req.params.id ?? ''

  /** The send routes: `:kind` checked against the closed list before the engine is asked. */
  const withSend = (handler: (jobs: Jobs, id: string, kind: SendKind, req: ModuleRequest) => ModuleResponse) =>
    withJobs((jobs, req) => {
      const kind = req.params.kind
      if (!oneOf(SEND_KINDS, kind)) return invalid('kind', `one of ${SEND_KINDS.join(', ')}`)
      return handler(jobs, id(req), kind, req)
    })

  /** The file routes: id and version checked, then the path the ENGINE knows, absolute or nothing. */
  const withFile = (kind: 'pdf' | 'png', named: (req: ModuleRequest) => boolean) =>
    withJobs((jobs, req) => {
      const version = req.params.version ?? ''
      if (!ID_PATTERN.test(id(req)) || !VERSION_PATTERN.test(version) || !named(req)) return noFile()
      const found = jobs.file(id(req), Number(version), kind)
      if (!found.ok) return found.error.code === 'not-found' ? noFile() : failure(found.error, log)
      if (!found.value.startsWith('/')) {
        return failure({ code: 'module-error', reason: 'the engine answered a file path that is not absolute' }, log)
      }
      return { status: 200, file: found.value }
    })

  return {
    'GET /health': withJobs((jobs) => ok(jobs.health())),
    'GET /overview': withJobs((jobs) => ok(jobs.overview())),
    'GET /a/:id': withJobs((jobs, req) => answer(jobs.application(id(req)))),

    // PNG inline · PDF download (D5 «Servir»): the literal `preview.png` wins over `:name` in the kernel.
    'GET /a/:id/v/:version/preview.png': withFile('png', () => true),
    'GET /a/:id/v/:version/:name': withFile('pdf', (req) => PDF_NAME_PATTERN.test(req.params.name ?? '')),

    // D9: approve answers at once, and the screen polls this.
    'GET /a/:id/sends/:kind': withSend((jobs, appId, kind) => answer(jobs.send(appId, kind), sendView)),
    'POST /a/:id/sends/:kind/mark': withSend((jobs, appId, kind) => answer(jobs.markSent(appId, kind))),
    'POST /a/:id/sends/:kind/unknown': withSend((jobs, appId, kind, req) => {
      const reply = fieldOf(req.body, 'answer')
      if (!oneOf<UnknownAnswer>(UNKNOWN_ANSWERS, reply)) return invalid('answer', `one of ${UNKNOWN_ANSWERS.join(', ')}`)
      return answer(jobs.resolveUnknown(appId, kind, reply), sendView)
    }),
    'POST /a/:id/sends/:kind/retry': withSend((jobs, appId, kind) => answer(jobs.retrySend(appId, kind), sendView)),

    // Not in D13: the client's «Retry» (`missing-cv`, `missing-letter`) and «Retry print» (`cv-stale`).
    'POST /a/:id/retry': withJobs((jobs, req) => {
      const job = fieldOf(req.body, 'job')
      if (!oneOf<RetryJob>(RETRY_JOBS, job)) return invalid('job', `one of ${RETRY_JOBS.join(', ')}`)
      return answer(jobs.retryJob(id(req), job))
    }),

    'POST /import': withJobs(async (jobs, req) => {
      const dryRun = fieldOf(req.body, 'dryRun')
      if (typeof dryRun !== 'boolean') return invalid('dryRun', 'true or false')
      return answer(await jobs.importSeed({ dryRun }))
    }),

    'GET /profile': withJobs((jobs) => ok(jobs.profile())),
    'POST /profile': withJobs((jobs, req) => answer(jobs.saveProfile(req.body))),
    'GET /rules': withJobs((jobs) => ok({ rules: jobs.rules() })),
    'POST /rules': withJobs((jobs, req) => answer(jobs.saveRule(req.body))),
    'POST /rules/:ruleId': withJobs((jobs, req) => answer(jobs.saveRule(req.body, req.params.ruleId ?? ''))),

    // `{ batch, ready }`, each item already resolved for the screen (client/contract.ts).
    'GET /batch': withJobs((jobs) => answer(jobs.batch())),
    'POST /batch': withJobs((jobs) => answer(jobs.startBatch())),
    // Never waits for SMTP (D9 step 4): `{ ok: true, state: 'sending' }` and the screen moves on.
    'POST /batch/decide': withJobs((jobs, req) =>
      answer(jobs.decide(req.body), (outcome): DecideAnswer => (outcome.send === undefined ? { ok: true } : { ok: true, state: outcome.send.state })),
    ),
  }
}

export function jobsModule(createJobs: CreateJobs): FactotumModule<unknown> {
  const holder: Holder = {}

  return {
    id: 'jobs',

    configSchema: jobsConfigSchema,

    nav: { label: 'Jobs', icon: 'briefcase', order: 7 },

    // Step 8: composes functions, nothing that can throw.
    routes: (ctx: ModuleContext<unknown>) => routeTable(holder, ctx.log),

    start: async (ctx: ModuleContext<unknown>) => {
      const created = await createJobs({
        config: ctx.config,
        stateDir: ctx.stateDir,
        log: ctx.log,
        now: ctx.now,
        timers: ctx.timers,
        notify: ctx.notify,
      })
      if (!created.ok) {
        // The kernel keeps a failed start's reason and does NOT log it (`registry.ts`, `startAll`).
        ctx.log.error(`jobs is off: ${created.reason}`)
        throw new Error(created.reason)
      }
      // LAST: the routes answer only once nothing above can throw.
      holder.jobs = created.jobs
      const running = created.jobs
      return {
        stop: async () => {
          delete holder.jobs
          await running.stop()
        },
      }
    },
  }
}
