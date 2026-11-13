/**
 * Job applications, as the composition root sees it (spec 2026-11-12-postulaciones).
 *
 * `packages/cli` imports `createJobs` from here and hands it to `jobsModule` (design D1):
 * `const jobsFactory: CreateJobs = createJobs` (C3). `modules/jobs` mirrors the types below BY HAND
 * (it imports only `@factotum/core`); that assignment is where the two meet.
 *
 * The CLI's dev command (`factotum jobs test-application`) uses the plain functions over the store —
 * `openDb`, `createTestApplication`, `closeApplication` — and never `createJobs` nor its startup write.
 */

export { createJobs, NO_LETTER_YET, NO_REPRINT_YET } from './jobs.ts'
export type {
  ApplicationCard,
  ApplicationDetail,
  BatchAnswer,
  BatchView,
  CompanyRef,
  ContactView,
  CreateJobs,
  CreateJobsResult,
  DecisionInput,
  DecisionOutcome,
  FollowupCard,
  FormAnswerView,
  Health,
  ItemResult,
  Jobs,
  JobsDeps,
  JobsRelay,
  JobStatus,
  Overview,
  PathState,
  ReplyCard,
  RetryJob,
  ReviewItem,
  RewriteInfo,
  SendView,
  UnknownAnswer,
  WhereView,
} from './facade/types.ts'
export type { MailHealth, MailHealthState } from './mail-health.ts'

export { createTestApplication, TEST_COMPANY, type TestApplicationContext } from './dev/test-application.ts'
export { closeApplication, MAX_CLOSE_REASON_CHARS, type CloseContext, type CloseInput } from './owner/close.ts'
export { DB_FILE, openDb, type Db, type OpenOptions } from './store/db.ts'

export type { DecisionKind, SkipReason } from './review/decide.ts'
export type { ImportReport } from './seed/report.ts'
export type {
  Address,
  Application,
  AppState,
  Channel,
  FollowupState,
  JobEvent,
  Profile,
  ProfileVersion,
  Result,
  Rule,
  Send,
  SendKind,
  Warning,
  WarningCode,
} from './types.ts'
