/**
 * The mail digest, as the composition root sees it (spec 2026-10-05-bandeja-resumida).
 *
 * `packages/cli` imports `createInbox` from here and hands it to `inboxModule`. Nothing in
 * `modules/` imports this package: it declares the same shapes by hand and the two meet at one
 * assignment in `main.ts`, as the session engine does (criterion 30).
 */

export {}
