/**
 * What the handoff answers, BEFORE it is HTTP (ADR-0005: the engine knows no HTTP). Five kinds, and
 * `modules/sessions/handoff-routes.ts` maps each to its status: 200/202, 400, 404, 409, 410.
 *
 * EVERY REFUSAL OF THE TARGET CARRIES `handoff` (spec 2026-10-07-dos-hosts, D8, v4.3): its reason, its
 * warnings and, with `target-ignored-collision`, the owner's paths. The good `commit` and `status`
 * carry it too. The source decides by `handoff.reason`, never by the status, and copies all of it
 * into its journal before deciding (D9, step 10).
 */

export interface TargetHandoff {
  readonly reason?: string
  readonly warnings: readonly string[]
  readonly paths?: readonly string[]
  readonly pathCount?: number
}

export type Wire =
  | { readonly kind: 'ok'; readonly body: unknown; readonly status?: 200 | 202 }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'not-found'; readonly message: string }
  | { readonly kind: 'conflict'; readonly message: string; readonly handoff: TargetHandoff }
  | { readonly kind: 'expired'; readonly handoff: TargetHandoff }

export const ok = (body: unknown): Wire => ({ kind: 'ok', body })
export const accepted = (body: unknown): Wire => ({ kind: 'ok', body, status: 202 })
export const invalid = (message: string): Wire => ({ kind: 'invalid', message })
export const notFound = (message: string): Wire => ({ kind: 'not-found', message })
export const refuse = (reason: string, message: string, handoff: Partial<TargetHandoff> = {}): Wire => ({
  kind: 'conflict',
  message,
  handoff: { warnings: [], ...handoff, reason },
})
export const expired = (handoff: Partial<TargetHandoff> = {}): Wire => ({ kind: 'expired', handoff: { warnings: [], ...handoff, reason: 'expired' } })
