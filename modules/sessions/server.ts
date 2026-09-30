/**
 * The thin module. It puts the five parts of the contract on the table and delegates
 * everything else to a capability it is HANDED.
 *
 * A FACTORY, NOT AN INSTANCE, and that costs nothing: the barrel already exports
 * instances and `packages/cli` passes them to `boot({ modules })` untouched, so a
 * module built by calling a function slots in without the kernel noticing and without
 * `ModuleContext` growing a field.
 *
 * The three things this file is careful about, all measured rather than assumed:
 *
 *  - `configSchema` runs at step 6 and `composeModules` is SYNCHRONOUS, so it checks
 *    shape and never touches the disk;
 *  - `routes()` runs at step 8, which has NO try/catch anywhere above it — block A ran
 *    this and watched a plain Error there kill the daemon with a raw stack — so it
 *    only composes functions;
 *  - `start()` runs at step 12, after the bind has been verified and INSIDE the
 *    registry's try/catch, so everything that can fail happens there and the worst
 *    outcome is this module disabled with a reason.
 */

import { homedir } from 'node:os'
import type { FactotumModule, ModuleContext, ModuleRequest, ModuleResponse, RouteTable } from '@factotum/core'
import { sessionsConfigSchema, type SessionsConfig } from './config.ts'
import { createRegistryStore, factotumRootOf, registryFile } from './registry.ts'
import {
  isSiteId,
  parseArchived,
  parseIds,
  parseLayout,
  parseProjectPatch,
  parseProjectRequest,
  parseQuery,
  parseSharedRequest,
  parseTitle,
} from './requests.ts'
import type { CreateEngine, LaunchResult, ProjectChange, RequestResult, SessionEdit, SessionEngine } from './types.ts'

/**
 * The hole.
 *
 * The route table built at step 8 closes over THIS, not over the engine, because at
 * step 8 the engine does not exist yet — and building it there would be building it
 * where the kernel cannot disable anything.
 */
interface EngineHolder {
  engine?: SessionEngine
}

const STARTING: ModuleResponse = {
  status: 503,
  body: { error: { code: 'starting', message: 'the session engine is not ready yet' } },
}

function invalid(message: string): ModuleResponse {
  return { status: 400, headers: NO_STORE, body: { error: { code: 'invalid-request', message } } }
}

/**
 * NEVER CACHED: lists, summaries, searches and requests (criterion 40). A stored response would
 * keep titles, paths and message text on the device's disk after the history was deleted.
 */
const NO_STORE: Readonly<Record<string, string>> = { 'cache-control': 'no-store' }

/**
 * A 409 that says WHICH conflict, with the kernel's closed list of codes untouched: `conflict`
 * plus a field, the way `busy` carries `conflict` and `stale` carries `freshness`.
 */
function siteMissing(siteId: string): ModuleResponse {
  return {
    status: 409,
    headers: NO_STORE,
    body: { error: { code: 'conflict', message: `the folder of project "${siteId}" is missing` }, missing: { siteId } },
  }
}

function notFound(message: string): ModuleResponse {
  return { status: 404, headers: NO_STORE, body: { error: { code: 'not-found', message } } }
}

function conflict(message: string, extra: Readonly<Record<string, unknown>> = {}): ModuleResponse {
  return { status: 409, headers: NO_STORE, body: { error: { code: 'conflict', message }, ...extra } }
}

function fromEdit(result: SessionEdit): ModuleResponse {
  switch (result.outcome) {
    case 'ok':
      return { status: 200, headers: NO_STORE, body: { summary: result.summary } }
    case 'unknown':
      return notFound('there is no conversation with that id')
    case 'running':
      return conflict('that conversation is running', { running: true })
    case 'invalid':
      return invalid(result.reason)
  }
}

function fromChange(result: ProjectChange): ModuleResponse {
  switch (result.outcome) {
    case 'ok':
      return { status: 200, headers: NO_STORE, body: { removedSessions: result.removedSessions } }
    case 'unknown':
      return notFound('there is no such project')
    case 'conflict':
      return conflict(result.reason)
    case 'invalid':
      return invalid(result.reason)
  }
}

/**
 * A folder request. THE 202 IS BUILT FIELD BY FIELD, never forwarded: whatever the engine returns,
 * only the request id and the deadline leave (criterion 8). The token authorises the approval and
 * travels in the push alone; a response that carried it would hand it to any process that asked.
 */
function fromRequest(result: RequestResult): ModuleResponse {
  switch (result.outcome) {
    case 'requested':
      return { status: 202, headers: NO_STORE, body: { requestId: result.requestId, expiresAt: result.expiresAt } }
    case 'invalid':
      return invalid(result.reason)
    case 'conflict':
      return conflict(result.reason, { request: { conflict: result.conflict } })
  }
}

/** A refusal the owner has to be able to read, turned into a response that carries it. */
function fromLaunch(result: LaunchResult): ModuleResponse {
  switch (result.outcome) {
    case 'started':
      return { status: 200, body: { sessionId: result.sessionId } }
    case 'busy':
      // THE BODY CARRIES THE SESSION ID. Without it the screen can say "busy" and
      // nothing else — it cannot offer to go to the session that has the site, or to
      // cancel it, which is the whole of criterion 17.
      return {
        status: 409,
        body: {
          error: { code: 'conflict', message: 'that site already has a live session' },
          conflict: { sessionId: result.sessionId },
        },
      }
    case 'stale':
      return {
        status: 409,
        body: {
          error: { code: 'conflict', message: 'that site is not clean or not up to date' },
          freshness: result.freshness,
        },
      }
    case 'rejected':
      return invalid(result.reason)
  }
}

function text(body: unknown, key: string): string | undefined {
  const value = (body as Record<string, unknown> | null | undefined)?.[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * The owner's text becomes an ARGUMENT of `claude`, and Node refuses an argument holding a NUL by
 * THROWING inside `spawn`. By then `launch` has already written a `running` meta, so the NUL would
 * leave a conversation with no process behind it until the next boot reconciles it. Refused here,
 * before the engine sees it.
 */
const HAS_NUL = /\u0000/
const NUL_REFUSED = 'a message cannot contain a NUL character'

function routeTable(holder: EngineHolder, home: string): RouteTable {
  /**
   * Every route funnels through here, so the empty hole is handled in ONE place.
   *
   * It is only reachable before step 13, when the kernel already answers 503 of its
   * own accord (`server.ts:90-92`), and it is handled anyway: failing closed on
   * something that cannot happen costs one branch.
   */
  const withEngine = (
    handler: (engine: SessionEngine, req: ModuleRequest) => Promise<ModuleResponse>,
  ) => async (req: ModuleRequest): Promise<ModuleResponse> => {
    const engine = holder.engine
    if (engine === undefined) return STARTING
    return await handler(engine, req)
  }

  return {
    'GET /setup': withEngine(async (engine) => ({ status: 200, headers: NO_STORE, body: engine.view() })),

    'GET /sessions': withEngine(async (engine, req) => {
      const page = Number.parseInt(req.query['page'] ?? '0', 10)
      const site = req.query['site']
      if (site !== undefined && !isSiteId(site)) return invalid('that is not a project id')
      return {
        status: 200,
        headers: NO_STORE,
        body: await engine.list({ page: Number.isNaN(page) ? 0 : page, site, archived: req.query['archived'] === 'true' }),
      }
    }),

    // --- the history (spec 2026-09-29, D8) ---------------------------------

    'GET /projects': withEngine(async (engine) => ({ status: 200, headers: NO_STORE, body: await engine.projects() })),

    // Titles, projects and the text of the messages, in every conversation of a project that is
    // there, archived included (criteria 25, 38). NEVER CACHED: the snippets are message text.
    'GET /search': withEngine(async (engine, req) => {
      const query = parseQuery(req.query['q'])
      if (!query.ok) return invalid(query.message)
      return { status: 200, headers: NO_STORE, body: { hits: await engine.search(query.value) } }
    }),

    // One conversation with its title, its state and its project's colour (criterion 36). The id is
    // checked by the engine, where the rule for a session id lives (criterion 32).
    'GET /sessions/:id': withEngine(async (engine, req) => {
      const found = await engine.summary(req.params['id'] ?? '')
      switch (found.kind) {
        case 'ok':
          return { status: 200, headers: NO_STORE, body: { summary: found.summary, project: found.project } }
        case 'unknown':
          return notFound('there is no conversation with that id')
        case 'invalid':
          return invalid('that is not a session id')
        case 'site-missing':
          return siteMissing(found.siteId)
      }
    }),

    'POST /sessions/:id/title': withEngine(async (engine, req) => {
      const title = parseTitle(req.body)
      if (!title.ok) return invalid(title.message)
      return fromEdit(await engine.rename(req.params['id'] ?? '', title.value))
    }),

    'POST /sessions/:id/archive': withEngine(async (engine, req) => {
      const archived = parseArchived(req.body)
      if (!archived.ok) return invalid(archived.message)
      return fromEdit(await engine.archive(req.params['id'] ?? '', archived.value))
    }),

    // POST, not DELETE: the contract has no DELETE and one action does not earn a verb. A result per
    // id, in the order asked (criterion 34).
    'POST /sessions/remove': withEngine(async (engine, req) => {
      const ids = parseIds(req.body)
      if (!ids.ok) return invalid(ids.message)
      return { status: 200, headers: NO_STORE, body: { results: await engine.remove(ids.value) } }
    }),

    // --- the projects (spec 2026-09-29, D3, D8) -------------------------------

    // ASKING, NOT ADDING: 202, a request id and a deadline. The approval goes to the owner's phone
    // (criteria 8-10). The body's shape is checked here, before the engine touches the disk (11).
    'POST /projects': withEngine(async (engine, req) => {
      const parsed = parseProjectRequest(req.body, home)
      if (!parsed.ok) return invalid(parsed.message)
      return fromRequest(await engine.requestProject(parsed.value))
    }),

    'GET /projects/requests/:requestId': withEngine(async (engine, req) => {
      const status = await engine.requestStatus(req.params['requestId'] ?? '')
      if (status.status === 'unknown') return notFound('there is no request with that id')
      return { status: 200, headers: NO_STORE, body: status }
    }),

    // Name and colour: nothing an agent can use, so no approval (guardrail 4).
    'POST /projects/:id': withEngine(async (engine, req) => {
      const id = req.params['id']
      if (!isSiteId(id)) return invalid('that is not a project id')
      const patch = parseProjectPatch(req.body)
      if (!patch.ok) return invalid(patch.message)
      return fromChange(await engine.updateProject(id, patch.value))
    }),

    // The drawer's order and categories, WHOLE (see `ProjectLayout`). Cosmetic, like a name: no
    // approval. NOT `/projects/layout`: a literal beats a parameter, so a project whose folder is
    // called `layout` could never be renamed again.
    'POST /project-layout': withEngine(async (engine, req) => {
      const layout = parseLayout(req.body)
      if (!layout.ok) return invalid(layout.message)
      return fromChange(await engine.setLayout(layout.value))
    }),

    // Its history goes, its folder never does (guardrail 7). The name typed on the screen is the
    // client's check; this is the daemon's part.
    'POST /projects/:id/remove': withEngine(async (engine, req) => {
      const id = req.params['id']
      if (!isSiteId(id)) return invalid('that is not a project id')
      return fromChange(await engine.removeProject(id))
    }),

    'POST /projects/removed/:siteId/remove': withEngine(async (engine, req) => {
      const siteId = req.params['siteId']
      if (!isSiteId(siteId)) return invalid('that is not a project id')
      return fromChange(await engine.removeHistory(siteId))
    }),

    'POST /shared': withEngine(async (engine, req) => {
      const path = parseSharedRequest(req.body, home)
      if (!path.ok) return invalid(path.message)
      return fromRequest(await engine.requestShared(path.value))
    }),

    'POST /shared/remove': withEngine(async (engine, req) => {
      const path = parseSharedRequest(req.body, home)
      if (!path.ok) return invalid(path.message)
      return fromChange(await engine.removeShared(path.value))
    }),

    // One request BY ITS TOKEN, for the approval panel: the full path, which the push never
    // carries. Authorised like the answer, never a list, NEVER CACHED (criterion 17).
    'GET /grants/:token': withEngine(async (engine, req) => {
      const found = await engine.inspectGrant(req.params['token'] ?? '')
      switch (found.kind) {
        case 'pending':
          return { status: 200, headers: NO_STORE, body: { ...found.request, expiresAt: found.expiresAt } }
        case 'settled':
          return conflict('that request was already answered, or it expired')
        case 'unknown':
          return notFound('there is no request with that token')
      }
    }),

    'POST /grants/:token/answer': withEngine(async (engine, req) => {
      const decision = text(req.body, 'decision')
      if (decision !== 'allow' && decision !== 'deny') return invalid('an answer is `allow` or `deny`')
      const result = await engine.answerGrant(req.params['token'] ?? '', decision)
      switch (result.outcome) {
        case 'unknown':
          return notFound('there is no request with that token')
        case 'expired':
          return conflict('too late: that request expired')
        default:
          return { status: 200, headers: NO_STORE, body: { first: result.first, outcome: result.outcome, reason: result.reason } }
      }
    }),

    'POST /sessions': withEngine(async (engine, req) => {
      const siteId = text(req.body, 'siteId')
      const entryId = text(req.body, 'entryId')
      const body = req.body as { force?: unknown } | null | undefined
      if (siteId === undefined || entryId === undefined) {
        return invalid('a launch needs a siteId and an entryId')
      }
      const prompt = text(req.body, 'text') ?? ''
      if (HAS_NUL.test(prompt)) return invalid(NUL_REFUSED)
      return fromLaunch(
        await engine.launch({
          siteId,
          entryId,
          text: prompt,
          force: body?.force === true,
        }),
      )
    }),

    'GET /sessions/:id/events': withEngine(async (engine, req) => {
      const fromSeq = Number.parseInt(req.query['fromSeq'] ?? '0', 10)
      const result = await engine.read(req.params['id'] ?? '', Number.isNaN(fromSeq) ? 0 : fromSeq)
      if ('kind' in result) return result.kind === 'invalid' ? invalid('that is not a session id') : siteMissing(result.siteId)
      return { status: 200, headers: NO_STORE, body: result }
    }),

    'POST /sessions/:id/reply': withEngine(async (engine, req) => {
      const message = text(req.body, 'text')
      if (message === undefined || message === '') return invalid('a reply needs some text')
      if (HAS_NUL.test(message)) return invalid(NUL_REFUSED)
      // `force` exactly as `POST /sessions` reads it: resuming onto a dirty or stale repo is
      // refused with the report, and the owner can choose to go over it (criteria 31, 32).
      const body = req.body as { force?: unknown } | null | undefined
      return fromLaunch(await engine.reply(req.params['id'] ?? '', message, body?.force === true))
    }),

    /**
     * The owner's answer to an ask. The TOKEN IS THE AUTHORISATION (spec §5): the kernel's origin
     * check stops someone else's browser, not a process on this machine, and the token is what a
     * process on this machine does not have — it lives in memory and in the encrypted push.
     *
     * Answered twice is 200: a service worker may retry on a bad network, and a notice tapped twice
     * must not paint an error.
     */
    'POST /asks/:askId/answer': withEngine(async (engine, req) => {
      const decision = text(req.body, 'decision')
      if (decision !== 'allow' && decision !== 'deny') return invalid('an answer is `allow` or `deny`')

      const result = await engine.answer(req.params['askId'] ?? '', decision)
      switch (result.kind) {
        // Both 200 — a service worker may retry — but the body says which, so a screen that
        // answers an ask already answered elsewhere does not report "Allowed" (criterion 24).
        case 'answered':
          return { status: 200, body: { answered: true, first: true } }
        case 'already':
          return { status: 200, body: { answered: true, first: false } }
        case 'expired':
          return {
            status: 409,
            body: { error: { code: 'conflict', message: 'too late: that ask expired, and the agent was already told no' } },
          }
        case 'unknown':
          return { status: 404, body: { error: { code: 'not-found', message: 'there is no ask with that token' } } }
      }
    }),

    // One ask BY ITS TOKEN, for the approval panel: the full path and the preview, which the
    // push never carries (spec D8). Authorised exactly like the answer — whoever can read it could
    // already answer it — and never a list. NEVER CACHED: the token is in the URL, and a stored
    // response would keep it, with the path and the preview, on the device's disk.
    'GET /asks/:askId': withEngine(async (engine, req) => {
      const headers = { 'cache-control': 'no-store' }
      const found = await engine.inspect(req.params['askId'] ?? '')
      switch (found.kind) {
        case 'pending':
          return {
            status: 200,
            headers,
            body: {
              sessionId: found.sessionId,
              toolName: found.toolName,
              target: found.target,
              preview: found.preview,
              deadlineAt: found.deadlineAt,
            },
          }
        case 'settled':
          return {
            status: 409,
            headers,
            body: { error: { code: 'conflict', message: 'that ask was already answered, or it expired' } },
          }
        case 'unknown':
          return { status: 404, headers, body: { error: { code: 'not-found', message: 'there is no ask with that token' } } }
      }
    }),

    // POST and not DELETE: adding a verb to the contract for one action is exactly the
    // growth it exists to avoid, and cancelling deletes nothing.
    'POST /sessions/:id/cancel': withEngine(async (engine, req) => {
      await engine.cancel(req.params['id'] ?? '')
      return { status: 200, body: { cancelled: true } }
    }),

    /**
     * The gate. Not called by the client — called by the subprocess.
     *
     * THE try/catch IS NOT DEFENSIVE HABIT. Without it an exception leaves through
     * `registry.dispatch` (`registry.ts:255`, which does not catch it) and arrives as
     * `500 module-error` (`server.ts:114-120`) — and a 500 CARRIES NO DECISION. Block A
     * measured what the CLI does with one of those: under `--permission-mode manual` it
     * treats a reply with no decision as "not granted" and blocks the tool, which is
     * the safe outcome but is the CLI's choice and not this project's. With the
     * try/catch, the answer is a 200 that says `deny` for a reason somebody can read.
     */
    'POST /hooks/pre-tool-use': async (req: ModuleRequest): Promise<ModuleResponse> => {
      const engine = holder.engine
      if (engine === undefined) return STARTING
      try {
        return { status: 200, body: await engine.decide(req.body) }
      } catch (error) {
        return {
          status: 200,
          body: {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `factotum could not decide: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          },
        }
      }
    },
  }
}

export interface SessionsModuleOptions {
  /**
   * The checkout the daemon runs from. Only the composition root knows it, and a project there or
   * above it is refused (ADR-0011): an agent in it could rewrite the gate for the next start.
   */
  readonly installRoot?: string
  /** `os.homedir()` unless a test says otherwise. */
  readonly home?: string
}

export function sessionsModule(
  createEngine: CreateEngine,
  /**
   * Separate from the setup because only the composition root knows it, and does not
   * know it until step 13. A launch that arrives in the window between `boot`
   * returning and this being filled in fails with a message that says so, rather than
   * starting an agent whose gate is unreachable.
   */
  hookUrl: () => string,
  options: SessionsModuleOptions = {},
): FactotumModule<SessionsConfig> {
  const holder: EngineHolder = {}
  const home = options.home ?? homedir()

  return {
    id: 'sessions',

    configSchema: sessionsConfigSchema,

    nav: { label: 'Sessions', icon: 'terminal', order: 0 },

    // Step 8. Composes functions and nothing else: no disk, no validation, nothing
    // that can throw.
    routes: () => routeTable(holder, home),

    // Step 12. The setup crosses WHOLE — nothing is added to it from outside, because
    // the revision that split it in two did not compile.
    start: async (ctx: ModuleContext<SessionsConfig>) => {
      // THE REGISTRY IS BUILT HERE AND HANDED OVER: the one schema of a project is this module's,
      // and the daemon — this — is the only thing that writes it (spec 2026-09-29, D1).
      const registry = createRegistryStore({
        file: registryFile(ctx.stateDir),
        seed: { sites: ctx.config.sites, sharedPaths: ctx.config.sharedPaths },
        now: ctx.now,
      })
      const engine = await createEngine({
        stateDir: ctx.stateDir,
        registry,
        home,
        factotumRoot: factotumRootOf(ctx.stateDir),
        installRoot: options.installRoot,
        catalog: ctx.config.catalog,
        log: ctx.log,
        now: ctx.now,
        timers: ctx.timers,
        hookUrl,
        notify: ctx.notify,
        titles: ctx.config.titles,
      })
      await engine.reconcile()
      holder.engine = engine

      // Stopping is stopping, with no ceremony around the hole: from the first instant
      // of shutdown `boot.ts` has set ready to false and the kernel answers 503 to
      // everything under /modules, so what this holds is unobservable. An earlier
      // revision claimed emptying it closed a fail-open window; it closed nothing.
      return { stop: () => engine.stop() }
    },
  }
}
