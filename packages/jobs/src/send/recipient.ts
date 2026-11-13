/**
 * Who a send goes to (design D9 step 2, «Implementación (revisión de E, 13-nov)»): THE CONTACT.
 *
 * The address guard of step 1 judges `Contact.address`, so the recipient is the contact's `email` —
 * never the copy stored beside the application (`target.to`) or the follow-up (`followups.to`). When
 * the copy differs, the contact was edited after the draft was made: nothing goes out
 * (`blocked { reason: 'address-changed' }`), at step 1 and again at step 2.
 */

import { approvalGate, type Gate } from '../state.ts'
import { isSendableAddress } from '../shape.ts'
import type { Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { fail, ok, type Contact, type Result } from '../types.ts'

/** The contact's email, when it is the one stored beside the send and an address SMTP can take. */
export function recipientOf(q: Queries, contactId: string | null, storedTo: string | null): Result<{ readonly contact: Contact; readonly to: string }> {
  const contact = contactId === null ? undefined : repo.getContact(q, contactId)
  const email = contact?.email?.trim() ?? ''
  if (contact === undefined || email === '') return fail('blocked', 'no-address')
  if (storedTo === null || storedTo.trim() !== email) return fail('blocked', 'address-changed')
  if (!isSendableAddress(email)) return fail('blocked', 'no-address')
  return ok({ contact, to: email })
}

/** Step 1's address guard (T-A11/T-F6, v5 X4) over the recipient: the same for «Approve», «Send again» and «Retry». */
export function addressGuard(q: Queries, contactId: string | null, storedTo: string | null, at: Date, sendAnyway: boolean): Result<Gate> {
  const recipient = recipientOf(q, contactId, storedTo)
  return recipient.ok ? approvalGate(recipient.value.contact.address, at, sendAnyway) : recipient
}
