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

import type { FactotumModule, ModuleContext, ModuleRequest, ModuleResponse, RouteTable } from '@factotum/core'
import { sessionsConfigSchema, type SessionsConfig } from './config.ts'
import type { CreateEngine, LaunchResult, SessionEngine } from './types.ts'

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
  return { status: 400, body: { error: { code: 'invalid-request', message } } }
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
          error: { code: 'invalid-request', message: 'that site already has a live session' },
          conflict: { sessionId: result.sessionId },
        },
      }
    case 'stale':
      return {
        status: 409,
        body: {
          error: { code: 'invalid-request', message: 'that site is not clean or not up to date' },
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

function routeTable(holder: EngineHolder): RouteTable {
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
    'GET /setup': withEngine(async (engine) => ({ status: 200, body: engine.view() })),

    'GET /sessions': withEngine(async (engine, req) => {
      const page = Number.parseInt(req.query['page'] ?? '0', 10)
      return { status: 200, body: await engine.list({ page: Number.isNaN(page) ? 0 : page }) }
    }),

    'POST /sessions': withEngine(async (engine, req) => {
      const siteId = text(req.body, 'siteId')
      const entryId = text(req.body, 'entryId')
      const body = req.body as { force?: unknown } | null | undefined
      if (siteId === undefined || entryId === undefined) {
        return invalid('a launch needs a siteId and an entryId')
      }
      return fromLaunch(
        await engine.launch({
          siteId,
          entryId,
          text: text(req.body, 'text') ?? '',
          force: body?.force === true,
        }),
      )
    }),

    'GET /sessions/:id/events': withEngine(async (engine, req) => {
      const fromSeq = Number.parseInt(req.query['fromSeq'] ?? '0', 10)
      return {
        status: 200,
        body: await engine.read(req.params['id'] ?? '', Number.isNaN(fromSeq) ? 0 : fromSeq),
      }
    }),

    'POST /sessions/:id/reply': withEngine(async (engine, req) => {
      const message = text(req.body, 'text')
      if (message === undefined || message === '') return invalid('a reply needs some text')
      return fromLaunch(await engine.reply(req.params['id'] ?? '', message))
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

export function sessionsModule(
  createEngine: CreateEngine,
  /**
   * Separate from the setup because only the composition root knows it, and does not
   * know it until step 13. A launch that arrives in the window between `boot`
   * returning and this being filled in fails with a message that says so, rather than
   * starting an agent whose gate is unreachable.
   */
  hookUrl: () => string,
): FactotumModule<SessionsConfig> {
  const holder: EngineHolder = {}

  return {
    id: 'sessions',

    configSchema: sessionsConfigSchema,

    nav: { label: 'Sessions', icon: 'terminal', order: 0 },

    // Step 8. Composes functions and nothing else: no disk, no validation, nothing
    // that can throw.
    routes: () => routeTable(holder),

    // Step 12. The setup crosses WHOLE — nothing is added to it from outside, because
    // the revision that split it in two did not compile.
    start: async (ctx: ModuleContext<SessionsConfig>) => {
      const engine = await createEngine({
        stateDir: ctx.stateDir,
        sites: ctx.config.sites,
        sharedPaths: ctx.config.sharedPaths,
        catalog: ctx.config.catalog,
        log: ctx.log,
        now: ctx.now,
        timers: ctx.timers,
        hookUrl,
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
