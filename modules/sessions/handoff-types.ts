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
  readonly startPreview: (body: unknown) => HandoffWire
  readonly preview: (previewId: string) => HandoffWire
  readonly start: (body: unknown) => Promise<HandoffWire>
  readonly report: (hid: string) => Promise<HandoffWire>
  readonly keep: (hid: string, siteId: string) => Promise<HandoffWire>
  readonly projects: () => Promise<HandoffWire>
  readonly sessionsCheck: (body: unknown) => Promise<HandoffWire>
  readonly prepare: (hid: string, siteId: string, body: unknown) => Promise<HandoffWire>
  readonly manifest: (hid: string, siteId: string, body: unknown) => Promise<HandoffWire>
  readonly file: (hid: string, siteId: string, n: string, file: { readonly path: string; readonly bytes: number } | undefined) => Promise<HandoffWire>
  readonly commit: (hid: string, siteId: string) => Promise<HandoffWire>
  readonly abort: (hid: string, siteId: string) => Promise<HandoffWire>
  readonly done: (hid: string, siteId: string) => Promise<HandoffWire>
  readonly status: (hid: string, siteId: string) => Promise<HandoffWire>
}
