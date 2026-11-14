/**
 * The `jobs` block of the config, and the only schema that knows its fields (design D13).
 *
 * THE MODULE CARRIES IT AS `z.unknown()` and `createJobs` parses it here, in `start()`: a bad block
 * switches off `jobs` with its reason, never the daemon (requirements crit. 1).
 *
 * `strictObject` AT EVERY LEVEL: `z.object` drops an unknown key without a word, so a mistyped
 * `"byhand"` would import a package the owner meant to keep by hand.
 *
 * THE PROFILE IS NOT HERE: it is data of the module (design D7); the config only says where things are.
 *
 * A REASON NEVER CARRIES A VALUE, only a path and a message of ours.
 */

import { z } from 'zod'
import { HOST_NAME_PATTERN, isAbsolutePath, isCalendarDate, isRelativePath, isSendableAddress, MAX_LINE_CHARS, MAX_PATH_CHARS } from './shape.ts'

/**
 * A COPY of `MODEL_NAME` (`packages/inbox/src/config.ts`, as `packages/tasks/src/config.ts` copies it):
 * this package does not import another's config. Never a leading `-`, so it cannot become a flag.
 */
export const MODEL_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/

/** A DNS name: labels of letters, digits and dashes, never a leading `-` (it would become a flag). */
const DNS_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}(?:\.[A-Za-z0-9][A-Za-z0-9-]{0,62})*$/
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/

/** design D13: what `scout.sources` may name. `ats` stands for the four ATS sources together. */
export const SCOUT_SOURCE_NAMES = ['seek', 'wwr', 'remoteok', 'remotive', 'yc', 'ats', 'watch', 'linkedin-alerts'] as const
const DEFAULT_SCOUT_SOURCES = ['seek', 'wwr', 'remoteok', 'remotive', 'yc', 'ats', 'linkedin-alerts'] as const
const DEFAULT_KEEPER_PATHS = ['01-projects', '02-learning', '03-life/carrera'] as const
const DEFAULT_KEEPER_EXCLUDE = ['03-life/carrera/cv-maestro.md', '03-life/carrera/postulaciones/'] as const
/** A5: the lock `vault-sync.sh` takes on omarchy; the default is right there. */
const DEFAULT_SYNC_LOCK = '/tmp/vault-sync-1000.lock'

/** Does `Intl` know this zone? It throws a RangeError for one it does not. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

const absolute = (what: string) =>
  z.string().max(MAX_PATH_CHARS).refine(isAbsolutePath, `${what} must be an absolute path without ".."`)
const relative = (what: string) =>
  z.string().max(MAX_PATH_CHARS).refine(isRelativePath, `${what} must be relative to vault.root, without ".."`)
const model = z.string().regex(MODEL_NAME, 'a model must match /^[a-z0-9][a-z0-9.-]{0,63}$/, like "sonnet"')
const dnsName = (what: string) => z.string().max(253).regex(DNS_NAME, `${what} must be a host name, like smtp.gmail.com`)
const clock = (what: string) => z.string().regex(CLOCK_TIME, `${what} is an hour of the day, HH:MM`)

const seedPackage = z.strictObject({
  file: relative('a package file'),
  holdUntil: z.string().refine(isCalendarDate, 'holdUntil is a real day, YYYY-MM-DD').optional(),
  /** v4 (C1): the owner sends this package by hand; the import records it, never sends it. */
  byHand: z.boolean({ error: 'byHand is true or false' }).optional(),
})

const vault = z.strictObject({
  root: absolute('vault.root'),
  cvMaster: relative('cvMaster'),
  guide: relative('guide'),
  seed: z.strictObject({
    companies: relative('seed.companies'),
    kit: relative('seed.kit'),
    cvs: relative('seed.cvs'),
    packages: z.array(seedPackage).max(20),
  }),
})

const mail = z.strictObject({
  address: z.string().max(MAX_LINE_CHARS).refine(isSendableAddress, 'mail.address must be an email address'),
  displayName: z.string().trim().min(1).max(MAX_LINE_CHARS),
  passwordFile: absolute('passwordFile'),
  imapHost: dnsName('imapHost').default('imap.gmail.com'),
  smtpHost: dnsName('smtpHost').default('smtp.gmail.com'),
  replyPollMinutes: z.number().int().min(1).max(1440).default(10),
  maxSendsPerDay: z.number().int().min(1).max(500).default(40),
})

const claude = z.strictObject({
  concurrency: z.number().int().min(1).max(8).default(2),
  models: z
    .strictObject({
      write: model.default('sonnet'),
      verify: model.default('sonnet'),
      classify: model.default('haiku'),
      extract: model.default('haiku'),
    })
    .prefault({}),
})

const watchEntry = z.strictObject({
  company: z.string().trim().min(1).max(MAX_LINE_CHARS),
  kind: z.enum(['amazon', 'json'], { error: 'a watch adapter is "amazon" or "json"' }).optional(),
  url: z.url({ protocol: /^https$/, error: 'a watch url is https' }).max(MAX_PATH_CHARS).optional(),
  query: z.string().trim().min(1).max(MAX_LINE_CHARS).optional(),
  windowMonths: z.array(z.number().int().min(1, 'a month is 1–12').max(12, 'a month is 1–12')).max(12).optional(),
})

const scout = z.strictObject({
  enabled: z.boolean().default(false),
  dailyAt: clock('scout.dailyAt').default('06:30'),
  politeMs: z.number().int().min(1000).max(60_000).default(5000),
  maxPages: z.number().int().min(1).max(50).default(10),
  strongMatch: z.number().int().min(0).max(100).default(85),
  sources: z
    .array(z.enum(SCOUT_SOURCE_NAMES, { error: 'not a scout source of D14' }))
    .max(SCOUT_SOURCE_NAMES.length)
    .default([...DEFAULT_SCOUT_SOURCES]),
  watch: z.array(watchEntry).max(20).default([]),
})

const keeper = z.strictObject({
  enabled: z.boolean().default(false),
  weekday: z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], { error: 'weekday is mon…sun' }).default('sun'),
  at: clock('keeper.at').default('20:00'),
  paths: z.array(relative('a keeper path')).max(20).default([...DEFAULT_KEEPER_PATHS]),
  exclude: z.array(relative('a keeper exclusion')).max(20).default([...DEFAULT_KEEPER_EXCLUDE]),
  syncLock: absolute('syncLock').default(DEFAULT_SYNC_LOCK),
})

export const hostConfigSchema = z.strictObject({
  mode: z.literal('host', { error: 'mode is "host" or "relay"' }).default('host'),
  timeZone: z.string().refine(isTimeZone, 'timeZone must be a zone Intl accepts, like "Australia/Sydney"').optional(),
  vault,
  mail,
  /** A2: the binary, not the launcher that adds chromium-flags.conf. */
  chromium: absolute('chromium'),
  poppler: z.strictObject({ pdfinfo: absolute('pdfinfo'), pdftoppm: absolute('pdftoppm') }),
  claude: claude.prefault({}),
  scout: scout.prefault({}),
  keeper: keeper.prefault({}),
})

/** In relay mode only `mode` and `relayTo` are valid: the module lives on another host. */
export const relayConfigSchema = z.strictObject({
  mode: z.literal('relay'),
  relayTo: z.string({ error: 'relay mode needs relayTo: the name of the host that keeps jobs' }).regex(HOST_NAME_PATTERN, 'relayTo is a machine name, like omarchy'),
})

export type HostConfig = z.infer<typeof hostConfigSchema>
export type RelayConfig = z.infer<typeof relayConfigSchema>
export type JobsConfig = HostConfig | RelayConfig

export type ParsedConfig =
  | { readonly ok: true; readonly config: JobsConfig; readonly timeZone: string }
  | { readonly ok: false; readonly reason: string }

function isRelay(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as { readonly mode?: unknown }).mode === 'relay'
}

export function parseJobsConfig(raw: unknown): ParsedConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'jobs: the block must be an object' }
  const parsed = isRelay(raw) ? relayConfigSchema.safeParse(raw) : hostConfigSchema.safeParse(raw)
  if (parsed.success) {
    const zone = parsed.data.mode === 'host' ? parsed.data.timeZone : undefined
    // The zone of the process by default, as tasks (S7).
    const timeZone = zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    return { ok: true, config: parsed.data, timeZone }
  }
  const issue = parsed.error.issues[0]
  const path = issue === undefined || issue.path.length === 0 ? 'jobs' : `jobs.${issue.path.join('.')}`
  return { ok: false, reason: `${path}: ${issue?.message ?? 'invalid'}` }
}
