/**
 * The handoff's routes (spec 2026-10-07-dos-hosts, D13). THIN ON PURPOSE: every id arrives raw at the
 * engine, which checks it before it becomes a path (D13, «Quién valida el `hid`»), and every answer
 * comes back as one of five kinds that map to a status here and nowhere else.
 *
 * NO CREDENTIAL, like every route of this daemon (ADR-0002): what the peer's routes have is SHAPE —
 * ids that must be ids, a manifest that limits what lands where. ADR-0020 does not sell it as more.
 */

import { MAX_UPLOAD_BYTES, uploadRoute, type ModuleRequest, type ModuleResponse, type RouteTable } from '@factotum/core'
import { SITE_ID_PATTERN } from './config.ts'
import type { HandoffApi, HandoffWire } from './handoff-types.ts'

const NO_STORE = { 'cache-control': 'no-store' }

const STARTING: ModuleResponse = { status: 503, body: { error: { code: 'not-ready', message: 'the sessions engine is still starting' } } }

/** One of the five kinds, as HTTP. */
export function respond(wire: HandoffWire): ModuleResponse {
  switch (wire.kind) {
    case 'ok':
      return { status: wire.status ?? 200, headers: NO_STORE, body: wire.body }
    case 'invalid':
      return { status: 400, body: { error: { code: 'invalid-request', message: wire.message } } }
    case 'not-found':
      return { status: 404, body: { error: { code: 'not-found', message: wire.message } } }
    case 'conflict':
      return { status: 409, body: { error: { code: 'conflict', message: wire.message }, handoff: wire.handoff } }
    case 'expired':
      // `conflict`, which ERROR_CODES already has for «a request the state of now cannot honour» (D8, v4.2):
      // the 410 and `handoff.reason` are what tell this case apart.
      return { status: 410, body: { error: { code: 'conflict', message: 'that handoff expired on this host' }, handoff: wire.handoff } }
  }
}

export function handoffRoutes(api: () => HandoffApi | undefined): RouteTable {
  const via =
    (handler: (handoff: HandoffApi, req: ModuleRequest) => Promise<HandoffWire> | HandoffWire) =>
    async (req: ModuleRequest): Promise<ModuleResponse> => {
      const handoff = api()
      return handoff === undefined ? STARTING : respond(await handler(handoff, req))
    }

  /**
   * `:siteId` IS CHECKED HERE (D13, «Quién valida»): `SITE_ID_PATTERN` lives in this module, and the
   * engine only accepts a project it has. `:hid` goes raw to the engine, which checks it.
   */
  const project =
    (handler: (handoff: HandoffApi, hid: string, siteId: string, req: ModuleRequest) => Promise<HandoffWire>) =>
    (handoff: HandoffApi, req: ModuleRequest) => {
      const siteId = req.params['siteId'] ?? ''
      if (!SITE_ID_PATTERN.test(siteId)) return { kind: 'invalid', message: `"${siteId}" is not a project id` } as const
      return handler(handoff, req.params['hid'] ?? '', siteId, req)
    }

  return {
    // The app's: short, they read memory or journals or start something that runs apart (v4.3).
    'POST /handoff/preview': via((handoff, req) => handoff.startPreview(req.body)),
    'GET /handoff/preview/:previewId': via((handoff, req) => handoff.preview(req.params['previewId'] ?? '')),
    'POST /handoff': via(async (handoff, req) => await handoff.start(req.body)),
    'GET /handoff/:hid': via(async (handoff, req) => await handoff.report(req.params['hid'] ?? '')),
    'POST /handoff/:hid/:siteId/keep': via(project(async (handoff, hid, siteId) => await handoff.keep(hid, siteId))),
    // The peer's.
    'GET /handoff/projects': via(async (handoff) => await handoff.projects()),
    'POST /handoff/sessions-check': via(async (handoff, req) => await handoff.sessionsCheck(req.body)),
    'POST /handoff/:hid/:siteId/prepare': via(project(async (handoff, hid, siteId, req) => await handoff.prepare(hid, siteId, req.body))),
    'POST /handoff/:hid/:siteId/manifest': via(project(async (handoff, hid, siteId, req) => await handoff.manifest(hid, siteId, req.body))),
    'POST /handoff/:hid/:siteId/commit': via(project(async (handoff, hid, siteId) => await handoff.commit(hid, siteId))),
    'POST /handoff/:hid/:siteId/abort': via(project(async (handoff, hid, siteId) => await handoff.abort(hid, siteId))),
    'POST /handoff/:hid/:siteId/done': via(project(async (handoff, hid, siteId) => await handoff.done(hid, siteId))),
    'GET /handoff/:hid/:siteId/status': via(project(async (handoff, hid, siteId) => await handoff.status(hid, siteId))),
    // A file of the manifest: the kernel writes it, caps it at its ceiling, and hands over a path (ADR-0012).
    'POST /handoff/:hid/:siteId/file/:n': uploadRoute(
      MAX_UPLOAD_BYTES,
      via(project(async (handoff, hid, siteId, req) => await handoff.file(hid, siteId, req.params['n'] ?? '', req.file))),
    ),
  }
}
