/**
 * The mockups module: thin on purpose (spec 2026-11-12-maquetas, D8).
 *
 * The stages, the file, the vault and the rules live on the other side of `createMockups`, which the
 * composition root hands in — as `tasksModule` receives its factory. This file only turns HTTP into
 * calls and back; every body goes over as it came, and the package shapes it.
 *
 * ONLY `GET` AND `POST`: the only methods the two-hosts proxy passes (ADR-0019). EVERY ANSWER
 * `no-store`: names and documents must not stay on the device's disk. `503 starting` until `start`
 * has finished (criterion 4).
 *
 * `start` fills the link LAST: if anything before it throws, the kernel frees the timers and never
 * calls `stop`, so the link must still be empty.
 */

import { uploadRoute, type FactotumModule, type ModuleContext, type ModuleRequest, type ModuleResponse, type RouteTable } from '@factotum/core'
import { mockupsConfigSchema } from './config.ts'
import { UPLOAD_MAX_BYTES, type CreateMockups, type MockupError, type Mockups, type MockupsLink, type Result } from './types.ts'

const NO_STORE: Readonly<Record<string, string>> = { 'cache-control': 'no-store' }

const STARTING: ModuleResponse = {
  status: 503,
  headers: NO_STORE,
  body: { error: { code: 'starting', message: 'mockups is not ready yet' } },
}

const STATUS_OF: Readonly<Record<Exclude<MockupError['code'], 'invalid'>, readonly [number, string]>> = {
  'not-found': [404, 'not-found'],
  conflict: [409, 'conflict'],
  'too-large': [413, 'body-too-large'],
  'module-error': [500, 'module-error'],
  'not-yet': [501, 'not-yet'],
}

function ok(body: unknown): ModuleResponse {
  return { status: 200, headers: NO_STORE, body }
}

function failure(error: MockupError): ModuleResponse {
  if (error.code === 'invalid') {
    return { status: 400, headers: NO_STORE, body: { error: { code: 'invalid-request', field: error.field, message: `${error.field}: ${error.reason}` } } }
  }
  const [status, code] = STATUS_OF[error.code]
  return { status, headers: NO_STORE, body: { error: { code, message: error.reason } } }
}

function answer<T>(result: Result<T>): ModuleResponse {
  return result.ok ? ok(result.value) : failure(result.error)
}

interface Holder {
  mockups?: Mockups
}

function routeTable(holder: Holder): RouteTable {
  /** Every route funnels through here, so the empty holder is handled in ONE place. */
  const withMockups =
    (handler: (mockups: Mockups, req: ModuleRequest) => Promise<ModuleResponse> | ModuleResponse) =>
    async (req: ModuleRequest): Promise<ModuleResponse> => {
      const mockups = holder.mockups
      return mockups === undefined ? STARTING : await handler(mockups, req)
    }
  const id = (req: ModuleRequest): string => req.params['id'] ?? ''
  const runId = (req: ModuleRequest): string => req.params['runId'] ?? ''

  return {
    'GET /mockups': withMockups((mockups) => ok({ mockups: mockups.list(), setup: mockups.setup() })),
    'GET /projects': withMockups(async (mockups) => {
      const listed = await mockups.projects()
      return listed.ok ? ok({ projects: listed.value }) : failure(listed.error)
    }),
    'POST /mockups': withMockups(async (mockups, req) => answer(await mockups.create(req.body))),
    'GET /mockups/:id': withMockups((mockups, req) => {
      const found = mockups.get(id(req))
      return found === undefined ? failure({ code: 'not-found', reason: 'there is no such mockup' }) : ok(found)
    }),

    'POST /mockups/:id/site-match': withMockups(async (mockups, req) => answer(await mockups.siteMatch(id(req), req.body))),
    'POST /mockups/:id/site': withMockups(async (mockups, req) => answer(await mockups.setSite(id(req), req.body))),

    // THE BYTES OF ONE FILE, written by the kernel under `.incoming/` and handed over as a path; the
    // name travels in `?name=`, real client data in `?private=1` (criteria 9, 10). Over the cap, the
    // kernel answers 413 itself and deletes the part.
    'POST /mockups/:id/inputs': uploadRoute(
      UPLOAD_MAX_BYTES,
      withMockups(async (mockups, req) => {
        if (req.file === undefined) return failure({ code: 'invalid', field: 'body', reason: 'this route takes the bytes of one file' })
        return answer(await mockups.addInput(id(req), req.file, req.query))
      }),
    ),
    'POST /mockups/:id/notes': withMockups(async (mockups, req) => answer(await mockups.addNote(id(req), req.body))),
    'GET /mockups/:id/docs/:stage': withMockups(async (mockups, req) => answer(await mockups.docs(id(req), req.params['stage'] ?? ''))),

    'POST /mockups/:id/runs': withMockups(async (mockups, req) => answer(await mockups.startRun(id(req), req.body))),
    'POST /mockups/:id/decision': withMockups(async (mockups, req) => answer(await mockups.decide(id(req), req.body))),
    'POST /mockups/:id/changes': withMockups(async (mockups, req) => answer(await mockups.requestChange(id(req), req.body))),
    'POST /mockups/:id/archive': withMockups(async (mockups, req) => answer(await mockups.archive(id(req)))),

    'POST /runs/:runId/session': withMockups(async (mockups, req) => answer(await mockups.linkRun(runId(req), req.body))),
    'POST /runs/:runId/stall': withMockups(async (mockups, req) => answer(await mockups.stallRun(runId(req)))),
    'POST /runs/:runId/abandon': withMockups(async (mockups, req) => answer(await mockups.abandonRun(runId(req), req.body))),
  }
}

export function mockupsModule(createMockups: CreateMockups, link: MockupsLink): FactotumModule<unknown> {
  const holder: Holder = {}
  return {
    id: 'mockups',
    configSchema: mockupsConfigSchema,
    // After Tasks (5), before Inbox (10).
    nav: { label: 'Mockups', icon: 'stack', order: 6 },
    routes: () => routeTable(holder),

    start: async (ctx: ModuleContext<unknown>) => {
      const created = await createMockups({ config: ctx.config, stateDir: ctx.stateDir, log: ctx.log, now: ctx.now, timers: ctx.timers, notify: ctx.notify })
      if (!created.ok) {
        // The kernel keeps a failed start's reason in the module's state and does NOT log it.
        ctx.log.error(`mockups is off: ${created.reason}`)
        throw new Error(created.reason)
      }
      holder.mockups = created.mockups
      // LAST: nothing above can leave a filled link behind a `start` that threw.
      link.fill(created.mockups.agent)
      return {
        stop: async () => {
          link.clear()
          await created.mockups.stop()
        },
      }
    },
  }
}
