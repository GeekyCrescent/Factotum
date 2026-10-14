/**
 * The handoff's routes (spec 2026-10-07-dos-hosts, D13). THIN ON PURPOSE: every id arrives raw at the
 * engine, which checks it before it becomes a path (D13, «Quién valida el `hid`»), and every answer
 * comes back as one of five kinds that map to a status here and nowhere else.
 *
 * NO CREDENTIAL, like every route of this daemon (ADR-0002): what the peer's routes have is SHAPE —
 * ids that must be ids, a manifest that limits what lands where. ADR-0020 does not sell it as more.
 */

import type { ModuleRequest, ModuleResponse, RouteTable } from '@factotum/core'
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

  return {
    'GET /handoff/projects': via(async (handoff) => await handoff.projects()),
    'POST /handoff/sessions-check': via(async (handoff, req) => await handoff.sessionsCheck(req.body)),
    'POST /handoff/preview': via((handoff, req) => handoff.startPreview(req.body)),
    'GET /handoff/preview/:previewId': via((handoff, req) => handoff.preview(req.params['previewId'] ?? '')),
  }
}
