/**
 * The `mockups` fragment, carried WHOLE and UNPARSED (spec 2026-11-12-maquetas, D8).
 *
 * `z.unknown()`, like `tasks`: the one schema that knows these fields lives in `packages/mockups` and
 * is applied in `start()`. A mistake there switches off `mockups` with its reason in the log — never
 * the daemon (criterion 2).
 */

import { z } from 'zod'

export const mockupsConfigSchema = z.unknown()
