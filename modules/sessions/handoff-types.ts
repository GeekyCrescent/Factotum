/**
 * The handoff's types, DECLARED BY HAND like the rest of this module's copy of the engine (ADR-0005:
 * a module imports only `@factotum/core`). The engine's own are in `packages/sessions/src/handoff/`;
 * `main.ts` is what checks the two agree, by passing one where the other is expected.
 */

export interface TargetHandoff {
  readonly reason?: string
  readonly warnings: readonly string[]
  readonly paths?: readonly string[]
  readonly pathCount?: number
}

/** What the handoff answers before it is HTTP: `handoff-routes.ts` maps each kind to its status. */
export type HandoffWire =
  | { readonly kind: 'ok'; readonly body: unknown; readonly status?: 200 | 202 }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'not-found'; readonly message: string }
  | { readonly kind: 'conflict'; readonly message: string; readonly handoff: TargetHandoff }
  | { readonly kind: 'expired'; readonly handoff: TargetHandoff }

export interface HandoffApi {
  readonly projects: () => Promise<HandoffWire>
  readonly sessionsCheck: (body: unknown) => Promise<HandoffWire>
  readonly startPreview: (body: unknown) => HandoffWire
  readonly preview: (previewId: string) => HandoffWire
}
