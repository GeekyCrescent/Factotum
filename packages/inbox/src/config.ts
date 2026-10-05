/**
 * The `inbox` block of the config, and the only schema that knows its fields (spec 2026-10-05, D3).
 *
 * THE MODULE CARRIES IT AS `z.unknown()` and `createInbox` parses it here, in `start()`: a bad block
 * switches off `inbox` with its reason, never the daemon nor `sessions` (CLAUDE.md §5, guardrail 7).
 *
 * `strictObject` AT EVERY LEVEL: `z.object` drops an unknown key without a word, so a mistyped
 * `"windowHour"` would run with the default and no warning (criterion 1).
 *
 * A REASON NEVER CARRIES A VALUE, only a path and zod's message — which, in zod 4, does not quote the
 * input. Somebody who pastes the password where its path goes must not find it in the log.
 */

import { z } from 'zod'

/**
 * A COPY of `SITE_ID_PATTERN` (`modules/sessions/config.ts`): this package cannot import a module.
 * An id names nothing on disk here, but it reaches the log and the digest file.
 */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/**
 * What a model name must look like to reach argv as `--model <name>`. Its own rule: the titler has
 * none (`titlesSchema.model` is `z.string().min(1)`). Never a leading `-`, so it cannot become a flag;
 * no space, no `[1m]`.
 */
export const MODEL_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/

export const DEFAULT_WINDOW_HOURS = 48
export const DEFAULT_KEEP_DAYS = 30

const idSchema = z.string().regex(ID_PATTERN, 'an id must match /^[a-z0-9][a-z0-9-]*$/')
const labelSchema = z.string().trim().min(1).max(40)
const readSchema = z.enum(['unread', 'all'])
/** Lower-cased once here, so `sourceOf` compares like with like. */
const addressSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/, 'must be one plain address, like you@example.com')

const sourceSchema = z.strictObject({
  id: idSchema,
  label: labelSchema,
  address: addressSchema,
  // A forwarded mail arrives unread whatever happened to it at its origin, so its "unread" means
  // nothing: `all` unless said otherwise (requirements S2, risk 3).
  read: readSchema.default('all'),
})

const accountSchema = z.strictObject({
  id: idSchema,
  label: labelSchema,
  // A NAME. The port is 993 with TLS and is not configurable (guardrail 6).
  host: z.string().regex(/^[a-z0-9.-]+$/i, 'host is a bare host name, like imap.gmail.com'),
  user: z.string().trim().min(1).max(320),
  passwordFile: z
    .string()
    .min(1)
    .refine((value) => value.startsWith('/'), 'passwordFile must be an absolute path (no ~)')
    .refine((value) => !value.split('/').includes('..'), 'passwordFile must not contain ".."'),
  read: readSchema.default('unread'),
  sources: z.array(sourceSchema).default([]),
})

export const inboxConfigSchema = z
  .strictObject({
    model: z.string().regex(MODEL_NAME, 'model must match /^[a-z0-9][a-z0-9.-]{0,63}$/, like "haiku"').default('haiku'),
    effort: z.enum(['low', 'medium', 'high']).optional(),
    windowHours: z.number().int().min(1).max(24 * 7).default(DEFAULT_WINDOW_HOURS),
    keepDays: z.number().int().min(1).max(365).default(DEFAULT_KEEP_DAYS),
    accounts: z.array(accountSchema).min(1, 'at least one account'),
  })
  .refine((value) => uniqueIds(value.accounts.map((account) => account.id)), {
    message: 'two accounts declare the same id',
    path: ['accounts'],
  })
  .refine((value) => uniqueIds(value.accounts.flatMap((account) => account.sources.map((source) => source.id))), {
    message: 'two sources declare the same id',
    path: ['accounts'],
  })

function uniqueIds(ids: readonly string[]): boolean {
  return new Set(ids).size === ids.length
}

export type InboxConfig = z.infer<typeof inboxConfigSchema>
export type AccountConfig = InboxConfig['accounts'][number]
export type SourceConfig = AccountConfig['sources'][number]
export type ReadRule = AccountConfig['read']

export type ParsedConfig = { readonly ok: true; readonly config: InboxConfig } | { readonly ok: false; readonly reason: string }

export function parseInboxConfig(raw: unknown): ParsedConfig {
  const parsed = inboxConfigSchema.safeParse(raw)
  if (parsed.success) return { ok: true, config: parsed.data }
  const issue = parsed.error.issues[0]
  const path = issue === undefined || issue.path.length === 0 ? 'inbox' : `inbox.${issue.path.join('.')}`
  return { ok: false, reason: `${path}: ${issue?.message ?? 'invalid'}` }
}
