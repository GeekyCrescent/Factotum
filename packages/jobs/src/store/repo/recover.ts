/**
 * The startup write (design D13 `start` step 2). THE ONE EXCEPTION to «`state.ts` decides, the store
 * stores»: it applies T-S4/T-A16/T-F8 and T-D6 itself, because nothing else runs at that moment.
 */

import { addressTransition, appTransition, followupTransition, sendTransition } from '../../state.ts'
import type { Contact, Send } from '../../types.ts'
import type { Queries } from '../db.ts'
import { companyOf, getApplication, saveApplication } from './applications.ts'
import { saveContact, toContact } from './companies.ts'
import { appendEvent } from './events.ts'
import { getFollowup, saveFollowup } from './followups.ts'
import { text, type Row } from './rows.ts'
import { toSend, upsertSend } from './sends.ts'

/** Something the startup write found and could not move: said, never hidden in a count. */
export interface Skipped {
  readonly kind: 'send' | 'contact'
  /** `<applicationId>/<kind>` for a send, the contact id for a contact. */
  readonly id: string
  readonly reason: string
}

export interface Recovered {
  /** Moved, not merely found: what could not move is in `skipped`. */
  readonly sends: number
  readonly work: number
  readonly contacts: number
  readonly skipped: readonly Skipped[]
}

/** Moves one `sending` row and its owner; the reason when the row itself cannot move, else null. */
function recoverSend(q: Queries, applicationId: string, row: Send, now: Date): string | null {
  const restarted = { kind: row.kind, restarted: true }
  const sendMoved = sendTransition(row, { type: 'smtp-unknown' }, now) // T-S4: always valid from `sending`
  if (!sendMoved.ok) return sendMoved.error.reason
  if (row.kind === 'initial') {
    const app = getApplication(q, applicationId)
    const moved = app === undefined ? undefined : appTransition(app, { type: 'smtp-unknown' }, now) // T-A16 + T-S4
    if (moved?.ok === true && saveApplication(q, moved.value, { kind: 'send-unknown', data: restarted }, now).ok) return null
  } else {
    const f = row.followupId === null ? undefined : getFollowup(q, row.followupId)
    const fMoved = f === undefined ? undefined : followupTransition(f, { type: 'smtp-unknown' }, now) // T-F8
    if (fMoved?.ok === true && saveFollowup(q, fMoved.value, { kind: 'send-unknown', data: restarted }, now, sendMoved.value).ok) return null
  }
  // The owner of the row is not in `sending` (it should be): the row alone still leaves `sending`, so
  // no send waits forever, and the event says the two disagreed.
  upsertSend(q, applicationId, sendMoved.value)
  const data = { ...restarted, followupId: row.followupId, ownerOutOfStep: true }
  appendEvent(q, { kind: 'send-unknown', data, applicationId, companyId: companyOf(q, applicationId) }, now)
  return null
}

/** T-D6 on one contact; the reason when it cannot move, else null. */
function recoverContact(q: Queries, contact: Contact, now: Date): string | null {
  const moved = addressTransition(contact, { type: 'restart' }, now)
  if (!moved.ok) return moved.error.reason
  const saved = saveContact(q, moved.value, { kind: 'address-checked', data: { found: false, restarted: true } }, now)
  return saved.ok ? null : saved.error.reason
}

/**
 * Only the daemon runs this, in its opening `tx` — never the CLI, which would mark a send in flight
 * as doubtful (design D3, «La postulación de prueba»). Every `sends` row in `sending` (initial and
 * follow-ups) → `send-unknown`; `work.running → queued`; every contact `checking → unverified` with
 * `checkedAt = null` and its override kept (T-D6; the requeue is the check queue's, N4).
 */
export function recoverOnStart(q: Queries, now: Date): Recovered {
  const sending = q.all<Row>("SELECT * FROM sends WHERE state = 'sending' ORDER BY rowid")
  const sendSkips = sending.flatMap((row): Skipped[] => {
    const send = toSend(row)
    const applicationId = text(row, 'application_id')
    const reason = recoverSend(q, applicationId, send, now)
    return reason === null ? [] : [{ kind: 'send', id: `${applicationId}/${send.kind}`, reason }]
  })
  const work = q.run("UPDATE work SET state = 'queued', updated_at = ? WHERE state = 'running'", now.toISOString()).changes
  const checking = q.all<Row>("SELECT * FROM contacts WHERE address_status = 'checking' ORDER BY rowid").map(toContact)
  const contactSkips = checking.flatMap((contact): Skipped[] => {
    const reason = recoverContact(q, contact, now)
    return reason === null ? [] : [{ kind: 'contact', id: contact.id, reason }]
  })
  return {
    sends: sending.length - sendSkips.length,
    work,
    contacts: checking.length - contactSkips.length,
    skipped: [...sendSkips, ...contactSkips],
  }
}
