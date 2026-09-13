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
