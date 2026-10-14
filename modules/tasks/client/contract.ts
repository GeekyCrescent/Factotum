/**
 * What the shell hands this module, declared HERE, structurally (spec 2026-10-14, design D9) — as
 * `modules/inbox/client/contract.ts` does. Nothing is imported from `apps/web` or from another
 * module: the shell's props and these meet where `modules.ts` puts `tasksClient` in its list, and the
 * typecheck there is the link. The edge to `sessions` (`peerModule`, `openModule`) arrives with G1.
 */

export interface Api {
  readonly get: <T>(path: string) => Promise<T>
  readonly post: <T>(path: string, body?: unknown) => Promise<T>
}

export interface ViewProps {
  readonly api: Api
  /** What follows `/m/tasks/`: `''`, `cycles`, `cycles/<id>`, or a card id. */
  readonly rest: string
  readonly navigate: (rest: string, options?: { readonly replace?: boolean }) => void
  /** The module draws its own bar (`ownsTopBar`), so its ☰ opens the shell's drawer through this. */
  readonly openDrawer: () => void
  /** Everything pending across the app: the count on the ☰. */
  readonly pendingTotal: number
}
