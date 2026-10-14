/**
 * The `tasks` fragment, carried WHOLE and UNPARSED (spec 2026-10-14, design D12).
 *
 * `z.unknown()`, like `inbox`: the one schema that knows these fields lives in `packages/tasks` and is
 * applied in `start()`. A typo there switches off `tasks` with its reason in the log — never the
 * daemon, and never `sessions` (criterion 1). A strict schema here as well would be the second
 * validator that drifts.
 */

import { z } from 'zod'

export const tasksConfigSchema = z.unknown()
