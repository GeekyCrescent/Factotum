/**
 * The `inbox` fragment, carried WHOLE and UNPARSED (spec 2026-10-05, D3, D10).
 *
 * `z.unknown()`, like `dictation` and `skills` in `modules/sessions/config.ts`: the one schema that
 * knows these fields lives with the code that reads mail, and is applied in `start()`. A typo there
 * switches off `inbox` with its reason in the log — never the daemon, and never `sessions`
 * (CLAUDE.md §5). A strict schema here as well would be the second validator that drifts.
 */

import { z } from 'zod'

export const inboxConfigSchema = z.unknown()
