/**
 * `GET /replies/unmatched` (design D12, D13; requirements crit. 56; tasks Q5): the «Unmatched replies»
 * waiting for «Assign to…» or «Ignore», newest first, and the applications «Assign to…» offers — every
 * one that sent something (a row in `sends`), not the test one, by company. Sender and subject only:
 * the body of an unmatched mail was never read.
 */

import type { Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import type { AssignOption, UnmatchedAnswer } from './types.ts'

function assignOptions(q: Queries): readonly AssignOption[] {
  return repo
    .replyWorld(q, [])
    .filter(({ application }) => !application.test)
    .map(({ application }) => ({
      id: application.id,
      company: repo.getCompany(q, application.companyId)?.name ?? '',
      role: repo.getOpportunity(q, application.opportunityId)?.title ?? '',
      state: application.state,
    }))
    .toSorted((a, b) => a.company.localeCompare(b.company) || a.role.localeCompare(b.role))
}

export function unmatchedAnswer(q: Queries): UnmatchedAnswer {
  const replies = repo.unmatchedReplies(q).map(({ eventId: _eventId, ...view }) => view)
  return { replies, applications: assignOptions(q) }
}
