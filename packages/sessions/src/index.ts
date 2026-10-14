/**
 * The engine, as the composition root sees it.
 *
 * `packages/cli` imports `createEngine` from here and hands it to the module's
 * factory. Nothing in `modules/` imports this package — it declares the same shapes by
 * hand and the two meet at one assignment in `main.ts`. That is the point of the whole
 * arrangement, and criterion 22 is a grep that proves it.
 */

export type {
  Announced,
  UsageCount,
  CatalogEntry,
  CreateEngine,
  Decision,
  EngineSetup,
  EngineSetupView,
  EventInput,
  EventPage,
  FilesQuery,
  FilesResult,
  FilesView,
  FreshnessReport,
  AskPreview,
  HookDecision,
  InspectResult,
  InvokeConfig,
  LaunchInput,
  LaunchResult,
  Listing,
  ListingEntry,
  Page,
  SessionEngine,
  SessionEvent,
  SessionPage,
  SessionState,
  SessionSummary,
  SiteConfig,
  TitlerEffort,
  TitlesConfig,
} from './types.ts'

export { createEngine, PAGE_SIZE } from './engine.ts'
export type { EngineDeps } from './engine.ts'
export { announcedOf, createAnnounced, MAX_ANNOUNCED } from './announced.ts'
export { checkFreshness, describeFreshness, isFresh } from './freshness.ts'
export { uuidv7 } from './id.ts'
export { reconcile } from './lifecycle.ts'
export type { LockTable } from './lifecycle.ts'
export { isAlive, SiteLocks } from './locks.ts'
export type { LockInfo, LockResult } from './locks.ts'
export { clip, redactInput, StreamTranslator } from './parse.ts'
export { decide, isWritingTool, resolveTarget } from './permissions/decide.ts'
export type { DecideInput, DecisionResult } from './permissions/decide.ts'
export { HEAD_CHARS, previewOf, TAIL_CHARS } from './permissions/preview.ts'
export { allowBody, decisionBody, denyBody, preToolUsePayloadSchema } from './permissions/payload.ts'
export type { PreToolUsePayload } from './permissions/payload.ts'
export { ASK_TIMEOUT_SECONDS, HOOK_PATH, HOOK_TIMEOUT_SECONDS, hookSettings, serializeSettings } from './permissions/settings.ts'
export { buildArgs, CLAUDE_BIN, killGroup, runAgent } from './run.ts'
// The mail digest launches `claude` the titler's way and kills it with the same guard (spec 2026-10-05, D1).
export { killQuietly } from './titler/index.ts'
export type { AgentExit, AgentRun, BuildArgsInput, RunOptions } from './run.ts'
export { contains, insideSite, inspectSite, resolveAgainst } from './sites.ts'
export type { Site } from './sites.ts'
export { findInvokable, isInvokableName, NAME, resolveCatalog } from './catalog.ts'
export type { Invoke, ResolvedEntry } from './catalog.ts'
export { isTerminal, parseLine, parseLog, serialize, stateFrom, SESSION_STATES } from './events.ts'
export { sessionPaths } from './paths.ts'
export type { SessionPaths } from './paths.ts'
export { SessionStore } from './store.ts'
export type { NewSession, SessionMeta } from './store.ts'

// What `factotum doctor` reads of the handoff (spec 2026-10-07-dos-hosts, D13, «doctor en el corte 2»).
export { GIT_NET_TIMEOUT_MS, runGit } from './git.ts'
export { ignoreDigest, remoteKey } from './handoff/git.ts'
export type { IgnoreDigest } from './handoff/git.ts'
export { HANDOFF_PEER_READ_TIMEOUT_MS } from './handoff/constants.ts'
export { listHids, listJournals } from './handoff/journal.ts'
export type { Journal } from './handoff/journal.ts'

// The hole for MCP tools from other modules (spec 2026-10-14-tareas-kanban, D7): the task board's
// `create_task` is built against these, as the inbox builds against `CLAUDE_BIN`.
export type { AgentToolFamily } from './types.ts'
export type { McpTool, ToolResult } from './questions/mcp.ts'
