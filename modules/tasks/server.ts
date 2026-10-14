/**
 * The task board module: thin on purpose (spec 2026-10-14-tareas-kanban, D12).
 *
 * The board, its file, its cycles and its rules all live on the other side of `createTasks`, which
 * the composition root hands in — the way `inboxModule` receives its factory. This file only turns
 * HTTP into calls and back, and every body goes over as it came: the package shapes it and answers
 * `{ field, reason }` for the `400`.
 *
 * ONLY `GET` AND `POST`: they are the only methods the two-hosts proxy passes (ADR-0019).
 *
 * `start` IN THE ORDER OF D12: load (the factory), then — LAST — fill the link. If anything before
 * that throws, the kernel frees the timers and never calls `stop`, so the link must still be empty.
 */

import type { FactotumModule, ModuleContext, ModuleRequest, ModuleResponse, RouteTable } from '@factotum/core'
import { tasksConfigSchema } from './config.ts'
import { CYCLE_ID_PATTERN, type CreateTasks, type Result, type TaskError, type Tasks, type TasksLink } from './types.ts'

/** Never cached: titles and notes must not stay on the device's disk (as `sessions` and `inbox`). */
const NO_STORE: Readonly<Record<string, string>> = { 'cache-control': 'no-store' }

const STARTING: ModuleResponse = {
  status: 503,
  headers: NO_STORE,
  body: { error: { code: 'starting', message: 'the board is not ready yet' } },
}

const STATUS_OF: Readonly<Record<Exclude<TaskError['code'], 'invalid'>, number>> = {
  'not-found': 404,
  conflict: 409,
  'module-error': 500,
  'not-yet': 501,
}

export interface TasksModuleOptions {
  /** The dev-only clock knob (S13): added to `ctx.now()`. 0, or absent, in prod. */
  readonly nowOffsetMs?: number
}

function ok(body: unknown, status = 200): ModuleResponse {
  return { status, headers: NO_STORE, body }
}

function failure(error: TaskError): ModuleResponse {
  if (error.code === 'invalid') {
    return {
      status: 400,
      headers: NO_STORE,
      body: { error: { code: 'invalid-request', field: error.field, message: `${error.field}: ${error.reason}` } },
    }
  }
  return { status: STATUS_OF[error.code], headers: NO_STORE, body: { error: { code: error.code, message: error.reason } } }
}

function answer<T>(result: Result<T>, shape: (value: T) => unknown = (value) => value): ModuleResponse {
  return result.ok ? ok(shape(result.value)) : failure(result.error)
}

function badCycle(): ModuleResponse {
  return failure({ code: 'invalid', field: 'cycle', reason: 'a cycle is YYYY-Www, the week with two digits' })
}

interface Holder {
  tasks?: Tasks
}

function routeTable(holder: Holder): RouteTable {
  /** Every route funnels through here, so the empty holder is handled in ONE place. */
  const withTasks =
    (handler: (tasks: Tasks, req: ModuleRequest) => Promise<ModuleResponse> | ModuleResponse) =>
    async (req: ModuleRequest): Promise<ModuleResponse> => {
      const tasks = holder.tasks
      if (tasks === undefined) return STARTING
      return await handler(tasks, req)
    }
  const id = (req: ModuleRequest): string => req.params.id ?? ''

  return {
    'GET /board': withTasks((tasks, req) => {
      const cycle = req.query.cycle
      if (cycle === undefined) return ok(tasks.board())
      return CYCLE_ID_PATTERN.test(cycle) ? ok(tasks.board({ cycle })) : badCycle()
    }),

    'POST /tasks': withTasks(async (tasks, req) => answer(await tasks.create(req.body))),
    'GET /tasks/:id': withTasks((tasks, req) => {
      const card = tasks.get(id(req))
      return card === undefined ? failure({ code: 'not-found', reason: 'there is no such card' }) : ok(card)
    }),
    'POST /tasks/:id': withTasks(async (tasks, req) => answer(await tasks.patch(id(req), req.body))),
    'POST /tasks/:id/move': withTasks(async (tasks, req) => answer(await tasks.move(id(req), req.body))),
    'POST /tasks/:id/accept': withTasks(async (tasks, req) => answer(await tasks.accept(id(req), req.body))),
    'POST /tasks/:id/remove': withTasks(async (tasks, req) => answer(await tasks.remove(id(req)))),
    'POST /tasks/:id/sessions': withTasks(async (tasks, req) => answer(await tasks.linkSession(id(req), req.body))),

    // 202: the card is in triage now; claude reads it afterwards, outside this request (criterion 21).
    'POST /capture': withTasks(async (tasks, req) => {
      const result = await tasks.capture(req.body)
      return result.ok ? ok(result.value, 202) : failure(result.error)
    }),
    'GET /triage': withTasks((tasks) => {
      const cards = tasks.triage()
      const pending = cards.filter((card) => card.source.kind === 'capture' && card.source.parse === 'pending').length
      return ok({ tasks: cards, pending })
    }),

    'POST /cycles/close': withTasks(async (tasks, req) => answer(await tasks.closeCycles(req.body), (closed) => ({ closed }))),
    'GET /cycles': withTasks((tasks) => ok({ cycles: tasks.cycles() })),
    'GET /cycles/:id': withTasks((tasks, req) => {
      if (!CYCLE_ID_PATTERN.test(id(req))) return badCycle()
      const cycle = tasks.cycle(id(req))
      return cycle === undefined ? failure({ code: 'not-found', reason: 'that cycle is not in the history' }) : ok(cycle)
    }),
  }
}

export function tasksModule(createTasks: CreateTasks, link: TasksLink, options: TasksModuleOptions = {}): FactotumModule<unknown> {
  const holder: Holder = {}
  const offset = options.nowOffsetMs ?? 0

  return {
    id: 'tasks',

    configSchema: tasksConfigSchema,

    // Before Inbox (10). Static, so it is the same in both modes (design D12).
    nav: { label: 'Tasks', icon: 'kanban', order: 5 },

    // Step 8: composes functions, nothing that can throw.
    routes: () => routeTable(holder),

    start: async (ctx: ModuleContext<unknown>) => {
      const now = offset === 0 ? ctx.now : () => new Date(ctx.now().getTime() + offset)
      const created = await createTasks({
        config: ctx.config,
        stateDir: ctx.stateDir,
        log: ctx.log,
        now,
        timers: ctx.timers,
        notify: ctx.notify,
      })
      if (!created.ok) {
        // The kernel keeps a failed start's reason in the module's state and does NOT log it
        // (`registry.ts`, `startAll`): written here, or the owner never sees why (criterion 1).
        ctx.log.error(`tasks is off: ${created.reason}`)
        throw new Error(created.reason)
      }
      const tasks = created.tasks
      // LAST: nothing above can leave a filled link behind a `start` that threw (design D12).
      link.fill(tasks.agent)
      holder.tasks = tasks
      return {
        stop: async () => {
          link.clear()
          await tasks.stop()
        },
      }
    },
  }
}
