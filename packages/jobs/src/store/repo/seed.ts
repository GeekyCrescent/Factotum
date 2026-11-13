/** The seed import's selections (design D8): drafts whose CV was never queued, and wave 2. */

import type { Queries } from '../db.ts'
import { text, type Row } from './rows.ts'

/**
 * The `draft` applications imported from the given seed files (`seed_key = '<file>#<N>'`, D8) that have
 * no `gen_requests(id, 'cv')` row, in the order of the files and then of the rows. What the import
 * queues: a CV the queue refused, or one lost to a crash after the import's `tx`, is queued again.
 */
export function seedDraftsWithoutCv(q: Queries, files: readonly string[]): readonly { readonly id: string; readonly seedKey: string }[] {
  return files.flatMap((file) =>
    q
      .all<Row>(
        `SELECT a.id, a.seed_key FROM applications a
         WHERE a.state = 'draft' AND substr(a.seed_key, 1, ?) = ?
           AND NOT EXISTS (SELECT 1 FROM gen_requests g WHERE g.entity_id = a.id AND g.kind = 'cv')
         ORDER BY a.rowid`,
        file.length + 1,
        `${file}#`,
      )
      .map((row) => ({ id: text(row, 'id'), seedKey: text(row, 'seed_key') })),
  )
}

/**
 * Wave 2 (G5, D8 step 7): the `draft` applications of these seed files held to a day no later than
 * `lastHoldDay` (= today + 7 d) whose CV was never requested, in the order of the files and the rows.
 */
export function heldDraftsDue(q: Queries, files: readonly string[], lastHoldDay: string): readonly string[] {
  return files.flatMap((file) =>
    q
      .all<Row>(
        `SELECT a.id FROM applications a
         WHERE a.state = 'draft' AND a.hold_until IS NOT NULL AND a.hold_until <= ? AND substr(a.seed_key, 1, ?) = ?
           AND NOT EXISTS (SELECT 1 FROM gen_requests g WHERE g.entity_id = a.id AND g.kind = 'cv')
         ORDER BY a.rowid`,
        lastHoldDay,
        file.length + 1,
        `${file}#`,
      )
      .map((row) => text(row, 'id')),
  )
}
