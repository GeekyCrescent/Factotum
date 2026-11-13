/**
 * The `jobs` fragment, carried WHOLE and UNPARSED (spec 2026-11-12-postulaciones, design D13).
 *
 * `z.unknown()`, like `tasks` and `inbox`: the one schema that knows these fields (`strictObject` at
 * every level) lives in `packages/jobs/src/config.ts` and is applied by the factory in `start()`. A
 * typo there switches off `jobs` with its reason in the log — never the daemon (requirements crit. 1).
 * A strict schema here as well would be the second validator that drifts.
 */

import { z } from 'zod'

export const jobsConfigSchema = z.unknown()
