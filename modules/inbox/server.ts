/**
 * The mail digest module: thin on purpose (spec 2026-10-05, D10).
 *
 * Reading mail, launching `claude` and writing digests all happen on the other side of `createInbox`,
 * which the composition root hands in — the way `sessionsModule` receives its engine. This file only
 * turns HTTP into calls and back.
 *
 * NOTHING IS SCHEDULED. There is no interval: a run starts when the owner presses "Check mail"
 * (requirements §0.1).
 */

import type { FactotumModule, ModuleContext, ModuleRequest, ModuleResponse, RouteTable } from '@factotum/core'
import { inboxConfigSchema } from './config.ts'
import { DIGEST_ID, type CreateInbox, type Inbox } from './types.ts'

/** Never cached: senders, subjects and drafts must not stay on the device's disk (as `sessions`). */
const NO_STORE: Readonly<Record<string, string>> = { 'cache-control': 'no-store' }

const STARTING: ModuleResponse = {
  status: 503,
  headers: NO_STORE,
  body: { error: { code: 'starting', message: 'the inbox is not ready yet' } },
}

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100

function ok(body: unknown, status = 200): ModuleResponse {
  return { status, headers: NO_STORE, body }
}

function invalid(message: string): ModuleResponse {
  return { status: 400, headers: NO_STORE, body: { error: { code: 'invalid-request', message } } }
}

function notFound(message: string): ModuleResponse {
  return { status: 404, headers: NO_STORE, body: { error: { code: 'not-found', message } } }
}

interface Holder {
  inbox?: Inbox
}

function routeTable(holder: Holder): RouteTable {
  /** Every route funnels through here, so the empty holder is handled in ONE place. */
  const withInbox =
    (handler: (inbox: Inbox, req: ModuleRequest) => Promise<ModuleResponse> | ModuleResponse) =>
    async (req: ModuleRequest): Promise<ModuleResponse> => {
      const inbox = holder.inbox
      if (inbox === undefined) return STARTING
      return await handler(inbox, req)
    }

  return {
    'GET /status': withInbox((inbox) => ok(inbox.status())),

    'GET /digests': withInbox(async (inbox, req) => {
      const raw = req.query.limit
      const limit = raw === undefined ? DEFAULT_LIMIT : Number(raw)
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return invalid(`limit must be a whole number from 1 to ${MAX_LIMIT}`)
      return ok({ digests: await inbox.list(limit) })
    }),

    // A literal segment: it wins over `:id` whatever order these are written in (`http.ts`).
    'GET /digests/latest': withInbox(async (inbox) => {
      const digest = await inbox.latest()
      return digest === undefined ? notFound('there is no digest yet') : ok(digest)
    }),

    'GET /digests/:id': withInbox(async (inbox, req) => {
      const id = req.params.id ?? ''
      if (!DIGEST_ID.test(id)) return invalid('a digest id looks like 2026-10-06T0812')
      const digest = await inbox.get(id)
      return digest === undefined ? notFound('there is no such digest') : ok(digest)
    }),

    // 202 AT ONCE: the run goes on in the daemon, and the screen follows it through GET /status
    // (criteria 17, 18). 409 while one runs (criterion 19).
    'POST /run': withInbox((inbox) => {
      const result = inbox.runNow()
      if (result.outcome === 'busy') {
        return { status: 409, headers: NO_STORE, body: { error: { code: 'conflict', message: 'already checking' } } }
      }
      return ok({ id: result.id }, 202)
    }),
  }
}

export function inboxModule(createInbox: CreateInbox): FactotumModule<unknown> {
  const holder: Holder = {}

  return {
    id: 'inbox',

    configSchema: inboxConfigSchema,

    nav: { label: 'Inbox', icon: 'envelope-simple', order: 10 },

    // Step 8: composes functions, nothing that can throw.
    routes: () => routeTable(holder),

    start: async (ctx: ModuleContext<unknown>) => {
      const created = await createInbox({
        config: ctx.config,
        stateDir: ctx.stateDir,
        log: ctx.log,
        now: ctx.now,
        timers: ctx.timers,
      })
      if (!created.ok) {
        // The kernel keeps a failed start's reason in the module's state and does NOT log it
        // (`registry.ts`, `startAll`): written here, or the owner never sees why (criterion 1).
        ctx.log.error(`inbox is off: ${created.reason}`)
        throw new Error(created.reason)
      }
      holder.inbox = created.inbox
      const inbox = created.inbox
      return { stop: () => inbox.stop() }
    },
  }
}
