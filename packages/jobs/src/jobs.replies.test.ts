/**
 * Q7 (verify) and Q6 (the log test, R68 part 2) — the replies end to end, THROUGH THE FACADE: a store
 * with three applications sent (Acme by its thread, Beta by its domain, one more for the ATS), the
 * fake IMAP (the client double of `@factotum/mail`) holding four mails — a reply in Acme's thread, one
 * from Beta's domain, one from an ATS, and one that matches nothing — and fake-claude classifying.
 * The real clock, reader, matcher, classifier, queue and apply; the profile in an absence.
 */

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { NotificationMessage, Notifier } from '@factotum/core'
import type { ConnectImap } from '@factotum/mail'
import { imapDouble, type FakeMail } from '@factotum/mail/testing'

import type { Jobs } from './facade/types.ts'
import { openDb, type Db } from './store/db.ts'
import * as repo from './store/repo.ts'
import { depsOf, NOW, rigIn, started, type Rig } from './test-jobs.ts'
import { application, ADDRESSES, contact, send, valueOf } from './test-state.ts'
import { eventually, tempBase } from './test-support.ts'
import { ok, type Opportunity } from './types.ts'

const SENT_AT = '2026-11-10T00:00:00.000Z'
const BODIES = ['Can we talk on Monday about the role?', 'Thanks for applying to Beta.', 'Your Greenhouse application', 'Never read: the offer body'] as const
const ADDRESSES_IN_MAIL = ['ada@acme.example', 'jo@beta.example', 'no-reply@greenhouse-mail.io', 'hr@unknown.example'] as const
const NAMES = ['Ada Lovelace', 'Jo Beta'] as const
const SUBJECTS = ['Re: Graduate engineer', 'Your application at Beta', 'Application received', 'Offer of employment'] as const

const mails: readonly FakeMail[] = [
  {
    uid: 21,
    internalDate: new Date('2026-11-12T05:00:00.000Z'),
    from: { name: NAMES[0], address: ADDRESSES_IN_MAIL[0] },
    subject: SUBJECTS[0],
    messageId: '<thread@acme.example>',
    headers: 'In-Reply-To: <acme@jobs.factotum.local>\r\nReferences: <acme@jobs.factotum.local>\r\n\r\n',
    parts: { '1': BODIES[0] },
  },
  { uid: 22, internalDate: new Date('2026-11-12T06:00:00.000Z'), from: { name: NAMES[1], address: ADDRESSES_IN_MAIL[1] }, subject: SUBJECTS[1], messageId: '<domain@beta.example>', parts: { '1': BODIES[1] } },
  { uid: 23, internalDate: new Date('2026-11-12T07:00:00.000Z'), from: { address: ADDRESSES_IN_MAIL[2] }, subject: SUBJECTS[2], messageId: '<ats@greenhouse-mail.io>', parts: { '1': BODIES[2] } },
  { uid: 24, internalDate: new Date('2026-11-12T08:00:00.000Z'), from: { address: ADDRESSES_IN_MAIL[3] }, subject: SUBJECTS[3], messageId: '<offer@unknown.example>', parts: { '1': BODIES[3] } },
]

function withUidValidity(connect: ConnectImap): ConnectImap {
  return (options) => {
    const client = connect(options)
    return { ...client, mailboxOpen: async (path, o) => ({ ...((await client.mailboxOpen(path, o)) as object), uidValidity: 7n }) }
  }
}

const company = (id: string, name: string, domain: string | null): repo.NewCompany => ({
  id,
  name,
  nameKey: name.toLowerCase(),
  domain,
  website: domain === null ? null : `https://${domain}`,
  careersUrl: null,
  linkedin: null,
  sector: null,
  size: null,
  location: null,
  isHealthEmployer: false,
  healthSource: null,
  ats: null,
  record: '',
})

const opportunity = (id: string, companyId: string, title: string): Opportunity => ({
  id,
  companyId,
  kind: 'vacancy',
  title,
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
  profileVersion: 1,
  source: 'seed',
  sourceRef: null,
  remote: null,
  status: 'open',
  discardReason: null,
  checkedAt: null,
})

/** Three applications sent four days ago: Acme (its thread), Beta (its domain), Gamma (no domain: the ATS one). */
async function seedSent(rig: Rig): Promise<void> {
  const db: Db = valueOf(await openDb({ dir: rig.stateDir, now: () => NOW }))
  try {
    valueOf(
      db.tx((q) => {
        const note = { kind: 'imported' } as const
        const apps = [
          ['acme', 'Acme', 'acme.example', 'Graduate engineer'],
          ['beta', 'Beta', 'beta.example', 'Data analyst'],
          ['gamma', 'Gamma', null, 'Platform engineer'],
        ] as const
        for (const [id, name, domain, title] of apps) {
          repo.insertCompany(q, company(`c-${id}`, name, domain), note, NOW)
          repo.insertOpportunity(q, opportunity(`o-${id}`, `c-${id}`, title), `${id}|role`, note, NOW)
          if (id === 'acme') repo.insertContact(q, contact(ADDRESSES.verifiedToday, { id: 'contact-acme', companyId: 'c-acme' }), note, NOW)
          const target = { contactId: id === 'acme' ? 'contact-acme' : null, to: null, url: null, contactName: null, instruction: null }
          const sends = [send({ state: 'sent', at: SENT_AT, messageId: `<${id}@jobs.factotum.local>` })]
          repo.insertApplication(q, application({ id: `a-${id}`, companyId: `c-${id}`, opportunityId: `o-${id}`, state: 'sent', target, sends }), { seedKey: null }, note, NOW)
        }
        return ok(undefined)
      }),
    )
  } finally {
    db.close()
  }
}

interface Run {
  readonly jobs: Jobs
  readonly pushes: NotificationMessage[]
  readonly log: readonly string[]
  readonly connects: () => number
}

/** First start: the profile, then an absence over NOW. Second start: the sent applications and the four mails. */
async function runWithMails(dir: string): Promise<Run> {
  const rig = rigIn(dir)
  const first = await started(depsOf(rig))
  const profile = first.profile().profile
  valueOf(first.saveProfile({ ...profile, absences: [{ from: '2026-11-01', to: '2026-12-31', label: 'Away' }] }))
  await first.stop()
  await seedSent(rig)
  // Every classification: an interview, for the first candidate it was given.
  writeFileSync(join(rig.stateDir, 'run', 'fake-claude.answer'), JSON.stringify({ class: 'interview', application: 'a0', summary: 'Asks for a call.' }))

  const pushes: NotificationMessage[] = []
  const notify: Notifier = { canReach: () => true, send: async (message) => void pushes.push(message) }
  const double = imapDouble(mails)
  const deps = depsOf(rig, { connect: withUidValidity(double.connect), notify })
  const jobs = await started(deps)
  return { jobs, pushes, log: deps.captured.lines, connects: () => double.calls.filter((c) => c.method === 'connect').length }
}

const replyEvents = (jobs: Jobs, ids: readonly string[]): number =>
  ids.flatMap((id) => valueOf(jobs.application(id)).events).filter((e) => e.kind === 'reply').length

test('Q7: four mails (thread, domain, ATS, unmatched) through the facade → 3 `reply` events and 1 «Unmatched reply» — read during an absence', async () => {
  using base = tempBase()
  const { jobs, pushes, connects } = await runWithMails(base.dir)
  try {
    const ids = ['a-acme', 'a-beta', 'a-gamma']
    await eventually(() => replyEvents(jobs, ids) === 3, 'three replies applied', 30_000)

    assert.equal(connects(), 1, 'the first round read the mailbox, absence or not')
    const unmatched = jobs.unmatchedReplies()
    assert.deepEqual(unmatched.replies.map((r) => [r.from, r.subject, r.class]), [['hr@unknown.example', 'Offer of employment', null]])
    assert.deepEqual(unmatched.applications.map((a) => a.company), ['Acme', 'Beta', 'Gamma'])
    const acme = valueOf(jobs.application('a-acme'))
    assert.equal(acme.application.state, 'replied')
    // The ATS reply lands on Acme too (fake-claude names the first candidate); the thread's is rule 1.
    assert.equal(acme.events.find((e) => e.kind === 'reply' && e.data.rule === 1)?.at, '2026-11-12T05:00:00.000Z', 'the date of the mail')
    assert.equal(valueOf(jobs.application('a-beta')).application.state, 'replied', 'by its domain')
    await eventually(() => pushes.length === 3, 'one push per interview')
    assert.ok(pushes.every((p) => p.body === 'Tap to open.' && p.path.startsWith('/m/jobs/a/a-') && p.title.startsWith('Interview: ')))

    // «Ignore» takes it off the list; a second time is not-found.
    valueOf(jobs.assignReply(unmatched.replies[0]!.key, null))
    assert.deepEqual(jobs.unmatchedReplies().replies, [])
    assert.equal(jobs.assignReply(unmatched.replies[0]!.key, null).ok, false)
    assert.equal(jobs.health().warnings.some((w) => w.startsWith('Mail reading failing')), false)
  } finally {
    await jobs.stop()
  }
})

test('Q6 (R68, part 2): a processed reply leaves no body, subject nor address in the log', async () => {
  using base = tempBase()
  const { jobs, log } = await runWithMails(base.dir)
  try {
    await eventually(() => replyEvents(jobs, ['a-acme', 'a-beta', 'a-gamma']) === 3, 'three replies applied', 30_000)
    await eventually(() => jobs.unmatchedReplies().replies.length === 1, 'the unmatched one recorded')
  } finally {
    await jobs.stop()
  }
  const all = log.join('\n')
  for (const secret of [...BODIES, ...SUBJECTS, ...ADDRESSES_IN_MAIL, ...NAMES, 'Asks for a call.', 'alex@example.test']) {
    assert.equal(all.toLowerCase().includes(secret.toLowerCase()), false, `«${secret}» is in the log:\n${all}`)
  }
})
