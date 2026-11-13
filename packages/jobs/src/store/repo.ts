/**
 * Typed queries over `jobs.db` (design D2): plain functions that take the query handle `q`.
 *
 * ROWS COME BACK FROZEN, all the way down, as the domain shapes of `types.ts`; nothing is changed in
 * place. A change is a new object from `state.ts`, written back here.
 *
 * EVERY FUNCTION THAT WRITES STATE APPENDS ITS EVENT, through `appendEvent`, on the same `q` — and so
 * in the same `tx` (requirements crit. 6). The event is an ARGUMENT, never optional: a writer cannot
 * forget it. Two writes are not entity state and carry none: `meta` (clocks such as `lastReplyPoll`)
 * and the requeue of `work` at startup.
 *
 * THE TRANSITION IS NOT DECIDED HERE: `state.ts` decides, this file stores. The one exception is the
 * startup write (`recoverOnStart`), which applies T-S4/T-A16/T-F8 and T-D6 itself because nothing
 * else runs at that moment.
 *
 * THIS FILE IS THE BARREL: the queries live in `repo/`, one module per entity, and every importer
 * keeps `import * as repo from './store/repo.ts'` or its named imports.
 */

export { applicationBySeedKey, applicationsByState, getApplication, insertApplication, saveApplication } from './repo/applications.ts'
export { getArtifacts, insertArtifacts } from './repo/artifacts.ts'
export { batchCandidateContacts, restartedContacts, seedCheckContacts } from './repo/checks.ts'
export {
  companyByNameKey,
  companyRecord,
  contactsOfCompany,
  getCompany,
  getContact,
  insertCompany,
  insertContact,
  saveContact,
  type NewCompany,
} from './repo/companies.ts'
export { appendEvent, applicationsWithDeferredReplies, eventsOf, pendingDeferredReplies, type EventInput, type EventSpec } from './repo/events.ts'
export { followupsOf, followupsOfContact, getFollowup, insertFollowup, saveFollowup } from './repo/followups.ts'
export { deleteMeta, getMeta, setMeta } from './repo/meta.ts'
export { getOpportunity, insertOpportunity, opportunityIdByDedupeKey, saveOpportunityCheck } from './repo/opportunities.ts'
export { getRule, insertProfileVersion, insertRule, latestProfileVersion, listRules, profileVersionOf, updateRule } from './repo/profile.ts'
export { recoverOnStart, type Recovered, type Skipped } from './repo/recover.ts'
export * from './repo/review.ts'
export { heldDraftsDue, seedDraftsWithoutCv } from './repo/seed.ts'
export { sendingBefore, smtpSendTimesSince } from './repo/sends.ts'
export {
  dueWork,
  genRequestsOf,
  getWork,
  insertWork,
  saveWork,
  setGenRequest,
  workByState,
  WORK_KINDS,
  type GenRequest,
  type GenRequestKind,
  type Lane,
  type Work,
  type WorkKind,
  type WorkState,
} from './repo/work.ts'
