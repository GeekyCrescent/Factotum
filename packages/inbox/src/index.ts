/**
 * The mail digest, as the composition root sees it (spec 2026-10-05-bandeja-resumida).
 *
 * `packages/cli` imports `createInbox` from here and hands it to `inboxModule`. Nothing in
 * `modules/` imports this package: it declares the same shapes by hand and the two meet at one
 * assignment in `main.ts`, as the session engine does (criterion 30).
 */

export type {
  AccountStatus,
  AccountView,
  Category,
  CreateInbox,
  CreateInboxResult,
  Digest,
  DigestEntry,
  DigestState,
  DigestSummary,
  EntryCategory,
  Inbox,
  InboxDeps,
  InboxStatus,
  Priority,
  Progress,
  RunOutcome,
  RunUsage,
} from './types.ts'
export { BATCH_SIZE, createInbox, MAX_PER_RUN, RUN_TIMEOUT_MS } from './inbox.ts'
export { DIGEST_ID } from './digest/store.ts'
