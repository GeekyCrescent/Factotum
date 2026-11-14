/** The address-check queue's selections (task N4, design D9 «Cuándo se comprueba»). */

import type { Application } from '../../types.ts'
import type { Queries } from '../db.ts'
import { text, type Row } from './rows.ts'

/** Before the first send leaves: what the seed import may still send by email. */
const UNSENT_STATES: readonly Application['state'][] = ['draft', 'generating', 'in-review', 'ready', 'rewriting']

const uniqueIds = (rows: readonly Row[]): readonly string[] => [...new Set(rows.map((row) => text(row, 'id')))]

/**
 * The contacts of the email applications, not sent yet, imported from the given seed files
 * (`seed_key = '<file>#<N>'`, D8), in the order of the files and then of the rows; each contact once.
 * The caller passes only the files the module sends (never a `byHand` one).
 */
export function seedCheckContacts(q: Queries, files: readonly string[]): readonly string[] {
  const marks = UNSENT_STATES.map(() => '?').join(', ')
  const rows = files.flatMap((file) =>
    q.all<Row>(
      `SELECT contact_id AS id FROM applications
       WHERE channel = 'email' AND contact_id IS NOT NULL AND state IN (${marks}) AND substr(seed_key, 1, ?) = ?
       ORDER BY rowid`,
      ...UNSENT_STATES,
      file.length + 1,
      `${file}#`,
    ),
  )
  return uniqueIds(rows)
}

/**
 * The contacts of the next batch's email items, in a batch's order, until R1's own order exists
 * (design D15 «Qué entra al lote»): follow-ups `draft`/`ready`, then applications `ready`, then
 * `in-review`, each by score (none last); never the test application nor one held past today.
 * A contact may come more than once: one per item.
 */
export function batchCandidateContacts(q: Queries, now: Date): readonly string[] {
  const today = now.toISOString().slice(0, 10)
  const followups = q.all<Row>(
    "SELECT contact_id AS id FROM followups WHERE channel = 'email' AND contact_id IS NOT NULL AND state IN ('draft', 'ready') ORDER BY created_at, rowid",
  )
  const applications = q.all<Row>(
    `SELECT a.contact_id AS id FROM applications a JOIN opportunities o ON o.id = a.opportunity_id
     WHERE a.channel = 'email' AND a.contact_id IS NOT NULL AND a.test = 0 AND a.state IN ('ready', 'in-review')
       AND (a.hold_until IS NULL OR a.hold_until <= ?)
     ORDER BY CASE a.state WHEN 'ready' THEN 0 ELSE 1 END, o.score IS NULL, o.score DESC, a.rowid`,
    today,
  )
  return [...followups, ...applications].map((row) => text(row, 'id'))
}

/**
 * The contacts the startup write moved `checking → unverified` (T-D6) and no check has touched since:
 * their last `address-checked` event is the `restarted` one. They go back to the front (D9 «Al arrancar»).
 */
export function restartedContacts(q: Queries): readonly string[] {
  const rows = q.all<Row>(
    `SELECT c.id FROM contacts c
     WHERE c.address_status = 'unverified' AND c.checked_at IS NULL
       AND (SELECT json_extract(e.data, '$.restarted') FROM events e
            WHERE e.kind = 'address-checked' AND json_extract(e.data, '$.contactId') = c.id
            ORDER BY e.rowid DESC LIMIT 1) = 1
     ORDER BY c.rowid`,
  )
  return uniqueIds(rows)
}
