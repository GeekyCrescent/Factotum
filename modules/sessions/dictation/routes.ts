/**
 * `GET /dictation` and `POST /dictation` (spec 2026-10-03, D7).
 *
 * NO NEW ERROR CODES. `ERROR_CODES` is a closed list owned by the core. What is dictation's own travels in
 * a `dictation` field of the body, exactly as `uploads.off` does for `POST /uploads`:
 *
 * - off → 409 `conflict` + `dictation.off`. Every 409 carries `conflict`; 501 is the kernel's, for a
 *   module disabled by its config.
 * - the provider failed → 502 `module-error` + `dictation.failure`. The screen decides by THE FIELD,
 *   never by the status: `tailscale serve` answers 502 in plain text when the daemon is down.
 *
 * THE SHAPES ARE DECLARED HERE, one line each, not imported from `../server.ts`: that file imports this
 * one, and a cycle would turn "move the folder out" into a refactor (D1).
 */

import { uploadRoute, type ModuleResponse, type RouteTable } from '@factotum/core'
import type { DictationState } from './service.ts'
import { DICTATION_MAX_BYTES, DICTATION_MAX_SECONDS, type ProviderFailure } from './shape.ts'

const NO_STORE = { 'cache-control': 'no-store' } as const

const STARTING: ModuleResponse = { status: 503, body: { error: { code: 'starting', message: 'dictation is not ready yet' } } }

const invalid = (message: string): ModuleResponse => ({ status: 400, headers: NO_STORE, body: { error: { code: 'invalid-request', message } } })

const switchedOff = (reason: string): ModuleResponse => ({
  status: 409,
  headers: NO_STORE,
  body: { error: { code: 'conflict', message: reason }, dictation: { off: reason } },
})

const providerFailed = (failure: ProviderFailure, message: string): ModuleResponse => ({
  status: 502,
  headers: NO_STORE,
  body: { error: { code: 'module-error', message }, dictation: { failure } },
})

/** `current` is read on every request: `start()` fills it after these routes were composed at step 8. */
export function dictationRoutes(current: () => DictationState | undefined): RouteTable {
  return {
    'GET /dictation': () => {
      const state = current()
      if (state === undefined) return STARTING
      const body = state.kind === 'on' ? { on: { maxSeconds: DICTATION_MAX_SECONDS, maxBytes: DICTATION_MAX_BYTES } } : { off: state.reason }
      return { status: 200, headers: NO_STORE, body }
    },

    // The bytes of one recording, written by the kernel under `.incoming/` and deleted by it when this
    // returns — or throws (ADR-0012). The container travels in the query: a request here has no headers.
    'POST /dictation': uploadRoute(DICTATION_MAX_BYTES, async (req) => {
      const state = current()
      if (state === undefined) return STARTING
      if (req.file === undefined) return invalid('this route takes the bytes of one recording')
      if (state.kind === 'off') return switchedOff(state.reason)
      const result = await state.transcribe(req.file, req.query['type'])
      switch (result.kind) {
        case 'ok':
          return { status: 200, headers: NO_STORE, body: { text: result.text } }
        case 'invalid':
          return invalid(result.reason)
        case 'provider':
          return providerFailed(result.failure, result.message)
      }
    }),
  }
}
