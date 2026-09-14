/**
 * The engine, as the composition root sees it.
 *
 * `packages/cli` imports `createEngine` from here and hands it to the module's
 * factory. Nothing in `modules/` imports this package — it declares the same shapes by
 * hand and the two meet at one assignment in `main.ts`. That is the point of the whole
 * arrangement, and criterion 22 is a grep that proves it.
 */

export type {
  CatalogEntry,
  CreateEngine,
  Decision,
  EngineSetup,
  EngineSetupView,
  EventInput,
  EventPage,
  FreshnessReport,
  HookDecision,
  InvokeConfig,
  LaunchInput,
  LaunchResult,
  Page,
  SessionEngine,
  SessionEvent,
  SessionPage,
  SessionState,
  SessionSummary,
  SiteConfig,
} from './types.ts'

export { contains, insideSite, inspectSite, resolveAgainst } from './sites.ts'
export type { Site } from './sites.ts'
export { findInvokable, resolveCatalog } from './catalog.ts'
export type { Invoke, ResolvedEntry } from './catalog.ts'
export { isTerminal, parseLine, parseLog, serialize, stateFrom, SESSION_STATES } from './events.ts'
export { sessionPaths } from './paths.ts'
export type { SessionPaths } from './paths.ts'
export { SessionStore } from './store.ts'
export type { NewSession, SessionMeta } from './store.ts'
