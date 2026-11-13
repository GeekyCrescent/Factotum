/**
 * The test application (design D3 «La postulación de prueba», T-A32; tasks C1, v6 H3): before the
 * first real email to a company, the owner sends one to his own address.
 *
 * NO HTTP ROUTE. The dev command `factotum jobs test-application --to <addr>` (C3) opens `jobs.db`
 * beside the daemon and calls this — never `createJobs`, never `start`, so NEVER the startup write
 * (from a second process it would mark a send in flight as doubtful). Its CV is only QUEUED here: the
 * daemon's pump picks it up on its next tick (≤ 60 s).
 *
 * WHAT IT WRITES, in one `tx`: the company «Factotum test» (no domain, no website: its check ends at
 * once, T-D4, and the way out is «Send anyway»), a contact `unverified` with `to` (T-D1), an `outreach`
 * opportunity, the application `test: true` on `email` with a fixed letter that carries
 * `{signature}`, `test-created`, and T-A1 (its CV queued) — the table from there on, as any other.
 */

import type { Logger } from '@factotum/core'
import { uuidv7 } from '@factotum/sessions'

import { createQueue } from '../ai/queue.ts'
import { isSendableAddress } from '../shape.ts'
import { addressTransition, newApplication } from '../state.ts'
import type { Db, Queries } from '../store/db.ts'
import { APP_STATES, fail, ok, type Application, type Artifacts, type Contact, type Opportunity, type Result } from '../types.ts'
import * as repo from '../store/repo.ts'

export const TEST_COMPANY = 'Factotum test'
const TEST_NAME_KEY = 'factotum-test'
export const TEST_SUBJECT = 'Factotum jobs — test'
const TEST_BODY = 'This is a test of the job applications module of factotum, sent to myself before the first real one.\n\n{signature}'
const CREATED = { kind: 'test-created' } as const

export interface TestApplicationContext {
  readonly now: () => Date
  readonly newId?: () => string
  /**
   * T-A1 inside this `tx`. By default a queue that is never pumped writes the row (the daemon's pump
   * runs it); the facade passes its own.
   */
  readonly enqueueCv?: (q: Queries, applicationId: string) => Result<void>
}

const SILENT: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

/** The queue's `enqueueCv`, on a queue that is never pumped: it only writes `work` and `gen_requests`. */
function writerOf(db: Db, now: () => Date): (q: Queries, applicationId: string) => Result<void> {
  const queue = createQueue({ db, now, concurrency: 1, handlers: {}, log: SILENT, lint: () => [], relintOne: () => ok(undefined), pdfExists: () => false })
  return queue.enqueueCv
}

const OPEN_STATES = APP_STATES.filter((state) => state !== 'closed')

function ensureCompany(q: Queries, id: () => string, now: Date): string {
  const known = repo.companyByNameKey(q, TEST_NAME_KEY)
  if (known !== undefined) return known.id
  const company: repo.NewCompany = {
    id: id(),
    name: TEST_COMPANY,
    nameKey: TEST_NAME_KEY,
    domain: null,
    website: null,
    careersUrl: null,
    linkedin: null,
    sector: null,
    size: null,
    location: null,
    isHealthEmployer: false,
    healthSource: null,
    ats: null,
    record: '',
  }
  repo.insertCompany(q, company, CREATED, now)
  return company.id
}

function opportunityOf(id: string, companyId: string): Opportunity {
  return {
    id,
    companyId,
    kind: 'outreach',
    title: 'Test application',
    goalId: null,
    url: null,
    postedAt: null,
    closesAt: null,
    startsAt: null,
    duration: null,
    hours: null,
    salary: null,
    requirements: '',
    score: null,
    breakdown: null,
    profileVersion: null,
    source: 'seed',
    sourceRef: null,
    remote: null,
    status: 'open',
    discardReason: null,
    checkedAt: null,
  }
}

function letterVersion(profileVersion: number): Artifacts {
  return {
    version: 1,
    cv: null,
    pdf: null,
    png: null,
    contactHash: null,
    letter: { subject: TEST_SUBJECT, body: TEST_BODY },
    form: [],
    skills: null,
    linkedin: null,
    profileVersion,
    rules: [],
    usage: null,
    origin: 'seed',
  }
}

function write(q: Queries, to: string, ctx: TestApplicationContext, enqueueCv: (q: Queries, id: string) => Result<void>): Result<Application> {
  const open = repo.applicationsByState(q, OPEN_STATES).find((app) => app.test)
  if (open !== undefined) return fail('conflict', `test application ${open.id} is still open: close it first`)
  const now = ctx.now()
  const id = ctx.newId ?? (() => uuidv7(now.getTime()))
  const companyId = ensureCompany(q, id, now)
  const blank: Contact = { id: id(), companyId, name: null, role: null, email: null, sourceUrl: null, address: null }
  const contact = addressTransition(blank, { type: 'create', email: to, seen: null }, now) // T-D1
  if (!contact.ok) return contact
  repo.insertContact(q, contact.value, CREATED, now)
  const opportunity = opportunityOf(id(), companyId)
  repo.insertOpportunity(q, opportunity, `test|${opportunity.id}`, CREATED, now)
  const fresh = newApplication(
    {
      id: id(),
      opportunityId: opportunity.id,
      companyId,
      channel: 'email',
      target: { contactId: contact.value.id, to, url: null, contactName: null, instruction: null },
      cvBase: null,
      holdUntil: null,
      notes: '',
      test: true,
    },
    now,
  )
  const app: Application = { ...fresh, version: 1 }
  repo.insertApplication(q, app, { seedKey: null }, CREATED, now)
  repo.insertArtifacts(q, app.id, letterVersion(repo.latestProfileVersion(q)?.version ?? 0), now)
  const queued = enqueueCv(q, app.id) // T-A1
  if (!queued.ok) return queued
  return ok(repo.getApplication(q, app.id) ?? app)
}

/** T-A32. `invalid` for a `to` the rule of `to` refuses; `conflict` while another test application is open. */
export function createTestApplication(db: Db, ctx: TestApplicationContext, input: { readonly to: string }): Result<Application> {
  const raw: unknown = input?.to
  const to = typeof raw === 'string' ? raw.trim() : ''
  if (!isSendableAddress(to)) return fail('invalid', 'to must be one email address', 'to')
  const enqueueCv = ctx.enqueueCv ?? writerOf(db, ctx.now)
  return db.tx((q) => write(q, to, ctx, enqueueCv))
}
