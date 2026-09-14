/**
 * The modules that ship with factotum, plus whatever `local.ts` adds.
 *
 * This barrel is imported by `packages/cli`, NEVER by `packages/kernel`. The kernel
 * receives the list through `boot({ modules })` and so never knows a module by name —
 * which is what makes `grep -rn 'example' packages/kernel/src` come back empty.
 */

import type { AnyModule } from '@factotum/core'
import { exampleModule } from './example/server.ts'
import { LOCAL } from './local.ts'

export const BUNDLED: readonly AnyModule[] = [exampleModule]

export const ALL_MODULES: readonly AnyModule[] = [...BUNDLED, ...LOCAL]

export { LOCAL }

/**
 * A module built by a FACTORY, exported beside the instances.
 *
 * It is not in `BUNDLED` because it cannot be: it needs two things only the
 * composition root has — the engine, and a way to ask where this daemon ended up
 * listening. So `packages/cli` calls this and appends the result to the list it passes
 * to `boot`. The kernel never learns that anything different happened.
 *
 * `local.ts` is deliberately NOT converted to factories by this. Somebody adding their
 * own module should not have to pay for a pattern one bundled module needed.
 */
export { sessionsModule } from './sessions/server.ts'
export type {
  CreateEngine,
  EngineSetup,
  EngineSetupView,
  EventPage,
  LaunchInput,
  LaunchResult,
  SessionEngine,
  SessionEvent,
  SessionPage,
  SessionState,
  SessionSummary,
} from './sessions/types.ts'
export { sessionsConfigSchema } from './sessions/config.ts'
export type { SessionsConfig } from './sessions/config.ts'
