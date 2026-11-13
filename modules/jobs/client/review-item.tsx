/**
 * One item of the batch (design D15). The whole card arrives with R4b; this is its head.
 */

import type { RefObject } from 'preact'
import type { Decision, ItemResult, ReviewItem, ViewProps } from './contract.ts'

/** What the card can ask of the screen. */
export interface ItemActions {
  /** Posts a decision on this item; resolves with whether it went through. An `instruct` moves on. */
  readonly decide: (decision: Omit<Decision, 'itemId'>) => Promise<boolean>
  /** «Send anyway», its second click (T-D5). */
  readonly sendAnyway: () => void
  /** «Retry» of a generation or a reprint (D10). */
  readonly retryJob: (applicationId: string, job: 'cv' | 'letter' | 'reprint') => Promise<void>
  /** To `/m/jobs/settings#<anchor>`. */
  readonly settings: (anchor: string) => void
  readonly skip: () => void
}

export interface ReviewItemProps {
  readonly props: ViewProps
  readonly item: ReviewItem
  readonly result: ItemResult | undefined
  readonly actions: ItemActions
  /** The instruction box, focused by `/`. */
  readonly box: RefObject<HTMLTextAreaElement>
  readonly busy: boolean
}

function titleOf(item: ReviewItem): { readonly company: string; readonly role: string } {
  switch (item.kind) {
    case 'application':
      return { company: item.application.company.name, role: item.application.role }
    case 'followup':
      return { company: item.followup.company.name, role: `Follow-up ${item.followup.n} · ${item.followup.role}` }
    case 'rewritten':
      return item.target === 'application'
        ? { company: item.application.company.name, role: item.application.role }
        : { company: item.followup.company.name, role: `Follow-up ${item.followup.n} · ${item.followup.role}` }
    case 'reply':
      return { company: item.reply.company.name, role: item.reply.subject }
    case 'proposal':
      return { company: 'CV keeper', role: 'A proposal' }
  }
}

export function ReviewItemView({ item }: ReviewItemProps) {
  const { company, role } = titleOf(item)
  return (
    <article class="j-item">
      <h2 class="j-company">{company}</h2>
      <p class="j-role">{role}</p>
    </article>
  )
}
