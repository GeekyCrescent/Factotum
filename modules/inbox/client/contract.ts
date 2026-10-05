/**
 * What the shell hands this module, declared HERE, structurally (spec 2026-10-05, D9) — as
 * `modules/sessions/client/contract.ts` does. Nothing is imported from `apps/web` or from another
 * module: the shell's props and these meet where `modules.ts` puts `inboxClient` in its list, and the
 * typecheck there is the link. A screen that declares fewer props than the shell gives still fits.
 */

export interface Api {
  readonly get: <T>(path: string) => Promise<T>
  readonly post: <T>(path: string, body?: unknown) => Promise<T>
}

export interface ViewProps {
  readonly api: Api
  /** What follows `/m/inbox/`: `''`, `history`, or a digest id. */
  readonly rest: string
  readonly navigate: (rest: string, options?: { readonly replace?: boolean }) => void
}
