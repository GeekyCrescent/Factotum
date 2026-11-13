/**
 * A world to send in (tasks E1–E3): a store with one company, contact, opportunity and application
 * whose current artifact has a PDF on disk, a profile, a password file `0600`, and the REAL nodemailer
 * talking to the made-up SMTP server of `@factotum/mail/testing` over TLS verified against a CA made for
 * this run. Test-only, excluded from coverage (`src/test-*.ts`).
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { connectNodemailer, readPassword, sendMail, type ConnectSmtp, type SendInput, type SendResult } from '@factotum/mail'
import { startFakeSmtp, type FakeSmtpServer, type SmtpCut } from '@factotum/mail/testing'

import { loadProfileSeed } from './profile.ts'
import type { Enqueue, SenderDeps } from './send/send.ts'
import { openDb, type Db, type Queries } from './store/db.ts'
import * as repo from './store/repo.ts'
import { application, contact, send as sendRow, valueOf } from './test-state.ts'
import { capturedLog, manualClock, manualTimers, tempBase, type ManualClock, type ManualTimers, type TempBase } from './test-support.ts'
import { ok, type Address, type Application, type Followup, type Opportunity, type Profile, type Send } from './types.ts'

export const USER = 'owner.jobs@example.com'
export const PASSWORD = 'abcdefghijklmnop'
/** Not the owner's: a number made up for the tests. */
export const PHONE = '+61 400 000 001'
export const SUBJECT = 'Application — Data Analyst'
export const BODY = 'Dear Ada,\n\nI would like to apply.\n\n{signature}'
export const NOW_ISO = '2026-11-14T00:00:00.000Z'
export const TIME_ZONE = 'Australia/Sydney'
const note = { kind: 'imported' } as const

let tls: { ca: string; key: string; cert: string } | undefined

export function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** A throwaway CA and a certificate for localhost/127.0.0.1, once per process. */
function certificates(): { ca: string; key: string; cert: string } {
  if (tls !== undefined) return tls
  const dir = mkdtempSync(join(tmpdir(), 'jobs-send-tls-'))
  const run = (args: readonly string[]): void => void execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' })
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=jobs-test-ca',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign'])
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=localhost'])
  writeFileSync(join(dir, 'ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n')
  run(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.crt', '-days', '1', '-extfile', 'ext'])
  const read = (name: string): string => readFileSync(join(dir, name), 'utf8')
  tls = { ca: read('ca.crt'), key: read('srv.key'), cert: read('srv.crt') }
  return tls
}

export const testProfile = (phone = PHONE): Profile => {
  const seed = valueOf(loadProfileSeed())
  return { ...seed, identity: { ...seed.identity, name: 'Ada Applicant', email: 'ada.applicant@example.com', phone, linkedin: '' } }
}

const opportunity = (id: string): Opportunity => ({
  id,
  companyId: 'company-1',
  kind: 'vacancy',
  title: 'Data Analyst',
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
})

export const write = <T>(db: Db, fn: (q: Queries) => T): T => valueOf(db.tx((q) => ok(fn(q))))

export interface WorldOptions {
  readonly address?: Address
  readonly app?: Partial<Application>
  readonly cut?: SmtpCut
  /** Leave the PDF off the disk. */
  readonly noPdf?: boolean
  readonly letter?: { readonly subject: string | null; readonly body: string } | null
}

export interface World {
  readonly base: TempBase
  readonly db: Db
  readonly server: FakeSmtpServer
  readonly clock: ManualClock
  readonly timers: ManualTimers
  readonly lines: string[]
  readonly pdf: string
  readonly passwordFile: string
  readonly enqueued: { readonly contactId: string; readonly front: boolean }[]
  /** Every input sendMail was handed. */
  readonly inputs: SendInput[]
  readonly deps: SenderDeps
  readonly close: () => Promise<void>
}

/** null when openssl is missing (the test skips). */
export async function world(options: WorldOptions = {}): Promise<World | null> {
  if (!hasOpenssl()) return null
  const keys = certificates()
  const base = tempBase('jobs-send-')
  const server = await startFakeSmtp(keys, { user: USER, password: PASSWORD, ...(options.cut === undefined ? {} : { cut: options.cut }) })
  const clock = manualClock(NOW_ISO)
  const timers = manualTimers()
  const { log, lines } = capturedLog()
  const pdf = join(base.dir, 'cv-v1.pdf')
  if (options.noPdf !== true) writeFileSync(pdf, '%PDF-1.7\nnot really a CV\n')
  const passwordFile = join(base.dir, 'gmail-jobs')
  writeFileSync(passwordFile, `${PASSWORD}\n`, { mode: 0o600 })
  const db = valueOf(await openDb({ dir: join(base.dir, 'state'), now: clock.now }))
  seedStore(db, options, pdf)

  const connect: ConnectSmtp = (given) =>
    connectNodemailer({ ...given, host: '127.0.0.1', port: server.port, tls: { ...given.tls, ca: keys.ca, servername: 'localhost', rejectUnauthorized: true } })
  const inputs: SendInput[] = []
  const enqueued: { contactId: string; front: boolean }[] = []
  const enqueueCheck: Enqueue = (contactId, opts) => {
    enqueued.push({ contactId, front: opts.front })
  }
  const deps: SenderDeps = {
    db,
    now: clock.now,
    timers: timers.timers,
    timeZone: TIME_ZONE,
    mail: { address: USER, displayName: 'Ada Applicant', passwordFile, smtpHost: 'smtp.gmail.com', maxSendsPerDay: 40 },
    readPassword,
    sendMail: (input): Promise<SendResult> => {
      inputs.push(input)
      return sendMail(input, connect)
    },
    enqueueCheck,
    log,
  }
  return {
    base,
    db,
    server,
    clock,
    timers,
    lines,
    pdf,
    passwordFile,
    enqueued,
    inputs,
    deps,
    close: async () => {
      db.close()
      await server.close()
      base[Symbol.dispose]()
    },
  }
}

function seedStore(db: Db, options: WorldOptions, pdf: string): void {
  const now = new Date(NOW_ISO)
  write(db, (q) => {
    repo.insertProfileVersion(q, { version: 1, createdAt: NOW_ISO, profile: testProfile() }, { kind: 'profile-saved' }, now)
    const company = { id: 'company-1', name: 'Acme', nameKey: 'acme', domain: 'acme.example', website: 'https://acme.example', careersUrl: null, linkedin: null, sector: null, size: null, location: null, isHealthEmployer: false, healthSource: null, ats: null, record: '' }
    repo.insertCompany(q, company, note, now)
    const address = options.address ?? { status: 'verified', verifiedUrl: 'https://acme.example/contact', checkedAt: '2026-11-13T21:00:00.000Z', override: null }
    repo.insertContact(q, contact(address), note, now)
    addApplication(q, 'app-1', options.app ?? {})
    // Without `noPdf` the file is written above; with it, the artifact still names it (deleted from the disk).
    repo.insertArtifacts(q, 'app-1', artifacts(1, pdf, options.letter), now)
  })
}

export function artifacts(version: number, pdf: string | null, letter?: { readonly subject: string | null; readonly body: string } | null) {
  return {
    version,
    cv: null,
    pdf,
    png: null,
    contactHash: null,
    letter: letter === undefined ? { subject: SUBJECT, body: BODY } : letter,
    form: [],
    skills: null,
    linkedin: null,
    profileVersion: 1,
    rules: [],
    usage: null,
    origin: 'seed' as const,
  }
}

/** An application `<id>` to contact-1 with its own opportunity. */
export function addApplication(q: Queries, id: string, app: Partial<Application>): void {
  const now = new Date(NOW_ISO)
  repo.insertOpportunity(q, opportunity(`o-${id}`), `k-${id}`, note, now)
  repo.insertApplication(q, application({ id, opportunityId: `o-${id}`, ...app }), { seedKey: null }, note, now)
}

/** An application already `sent` by SMTP, with its follow-up 1 `ready` (to the same contact). */
export function sentWithFollowup(q: Queries, followup: Followup, initial: Partial<Send> = {}): void {
  const now = new Date(NOW_ISO)
  q.run("UPDATE applications SET state = 'sent' WHERE id = 'app-1'")
  q.run(
    `INSERT INTO sends (application_id, kind, channel, message_id, state, at, response, profile_version, attempts)
     VALUES ('app-1', 'initial', 'smtp', ?, ?, ?, '250 2.0.0 OK', 1, '[]')`,
    initial.messageId ?? '<initial@jobs.factotum.local>',
    initial.state ?? 'sent',
    initial.at ?? '2026-11-05T00:00:00.000Z',
  )
  repo.insertFollowup(q, followup, { kind: 'followup-proposed' }, now)
}

export const appOf = (db: Db, id = 'app-1'): Application => {
  const app = db.read((q) => repo.getApplication(q, id))
  if (app === undefined) throw new Error(`no application ${id}`)
  return app
}

export const eventsOf = (db: Db, id = 'app-1') => db.read((q) => repo.eventsOf(q, id))

/** A row of `sends` written by hand, for the cap's arithmetic. */
export const capRow = (overrides: Partial<Send>): Send => sendRow({ state: 'sent', ...overrides })

/** The text of a received message, quoted-printable undone (the signature's `·` is not ASCII). */
export function decoded(message: string): string {
  const joined = message.replace(/=\r\n/g, '')
  const bytes: number[] = []
  for (let i = 0; i < joined.length; i += 1) {
    const hex = joined.slice(i + 1, i + 3)
    if (joined[i] === '=' && /^[0-9A-F]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16))
      i += 2
    } else {
      bytes.push(...Buffer.from(joined[i] ?? '', 'utf8'))
    }
  }
  return Buffer.from(bytes).toString('utf8')
}
