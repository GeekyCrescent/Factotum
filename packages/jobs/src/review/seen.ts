/**
 * What the card showed (design D15 «Lo que se vio es lo que se aprueba»): every item of the batch
 * carries `seen`, a fingerprint of what its card shows, and a `Decision` sends it back. If the item
 * changed in between — a rewrite came back, the address was checked or edited, a warning was
 * overridden, the profile that fills the slots was saved — `decide` answers `conflict { reason:
 * 'stale' }` and decides nothing; the card is painted again.
 *
 * WHAT GOES IN, by kind (and the item's own fields: kind, ids, `fromVersion`, `failed`):
 * - an application (or its `rewritten` item): its version, state, channel and target, its warnings
 *   with their `overridden`, its contact's email and address (status, `checkedAt`, «Send anyway»);
 * - a follow-up: the same of the follow-up row and its contact;
 * - both: the profile version (the slots of the texts are filled with it);
 * - a reply: whether it is still pending; a proposal: its state.
 *
 * `seen` is a sha256 of the canonical JSON of that, hex. Pure over a `read`.
 */

import { createHash } from 'node:crypto'

import type { Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import type { Contact } from '../types.ts'
import type { Batch, ReviewItemRef } from './batch.ts'

/** A batch item as `GET /batch` gives it: the ref, and what its card shows as `seen`. */
export type SeenItem = ReviewItemRef & { readonly seen: string }

export interface SeenBatch extends Omit<Batch, 'items'> {
  readonly items: readonly SeenItem[]
}

const addressOf = (q: Queries, contactId: string | null): Pick<Contact, 'email' | 'address'> | null => {
  const found = contactId === null ? undefined : repo.getContact(q, contactId)
  return found === undefined ? null : { email: found.email, address: found.address }
}

function applicationShown(q: Queries, id: string): unknown {
  const app = repo.getApplication(q, id)
  if (app === undefined) return null
  const { version, state, channel, target, warnings } = app
  return { version, state, channel, target, warnings, contact: addressOf(q, target.contactId) }
}

function followupShown(q: Queries, id: string): unknown {
  const row = repo.getFollowup(q, id)
  if (row === undefined) return null
  const { version, state, channel, to, warnings } = row
  return { version, state, channel, to, warnings, contact: addressOf(q, row.contactId) }
}

function shown(q: Queries, item: ReviewItemRef): unknown {
  switch (item.kind) {
    case 'application':
      return applicationShown(q, item.applicationId)
    case 'rewritten':
      return item.target === 'application' ? applicationShown(q, item.id) : followupShown(q, item.id)
    case 'followup':
      return followupShown(q, item.followupId)
    case 'reply':
      return { pending: repo.pendingAsks(q).some((ask) => ask.eventId === item.eventId) }
    case 'proposal':
      return { state: repo.proposalState(q, item.proposalId) }
  }
}

/** The ref alone: an item that already carries its `seen` (a `SeenItem`) has the same fingerprint. */
const refOf = (item: ReviewItemRef): Readonly<Record<string, unknown>> => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'seen'))

/** The fingerprint of what `item`'s card shows now. */
export function seenOf(q: Queries, item: ReviewItemRef): string {
  const profileVersion = repo.latestProfileVersion(q)?.version ?? null
  const canonical = JSON.stringify({ item: refOf(item), profileVersion, shown: shown(q, item) })
  return createHash('sha256').update(canonical).digest('hex')
}

/** The batch with each item's `seen` (C2 puts it in `GET /batch`). */
export function withSeen(q: Queries, batch: Batch): SeenBatch {
  return { ...batch, items: batch.items.map((item) => ({ ...item, seen: seenOf(q, item) })) }
}
