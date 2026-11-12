/**
 * The zod of `mockups.json` (design D1). A file that does not pass is DAMAGED: the store copies it
 * aside and refuses to open (criterion 3). A reason never carries a value, only a path and a message.
 */

import { z } from 'zod'
import { STAGE_IDS, type MockupsFile } from '../types.ts'

const iso = z.string().min(1).max(64)
const option = z.strictObject({ id: z.string(), title: z.string(), blurb: z.string(), url: z.string().optional() })
const decision = z.strictObject({
  at: iso,
  action: z.enum(['approve', 'choose', 'redo']),
  version: z.number().int().min(0),
  optionId: z.string().optional(),
  comment: z.string().optional(),
})
const run = z.strictObject({
  id: z.string().min(1),
  kind: z.enum([...STAGE_IDS, 'change', 'redeploy']),
  siteId: z.string().min(1),
  sessionId: z.string().optional(),
  startedAt: iso,
  redo: z.strictObject({ comment: z.string(), fromVersion: z.number().int().min(0) }).optional(),
})
const stepShape = {
  status: z.enum(['locked', 'ready', 'running', 'stalled', 'waiting', 'done']),
  version: z.number().int().min(0),
  run: run.optional(),
  options: z.array(option).optional(),
  chosen: z.string().optional(),
  pendingComment: z.string().optional(),
  summary: z.string().optional(),
  history: z.array(decision),
}
const step = z.strictObject(stepShape)
const change = z.strictObject({
  ...stepShape,
  id: z.string().min(1),
  text: z.string(),
  previewUrl: z.string().optional(),
  phase: z.enum(['change', 'approved', 'redeploy']),
})

const mockup = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  client: z.string(),
  project: z.string().min(1),
  vaultDir: z.string().min(1),
  workDir: z.string().min(1),
  buildSiteId: z.string().nullable(),
  buildRefused: z.string().optional(),
  createdAt: iso,
  updatedAt: iso,
  stages: z.strictObject(Object.fromEntries(STAGE_IDS.map((id) => [id, step])) as Record<(typeof STAGE_IDS)[number], typeof step>),
  changes: z.array(change),
  inputs: z.array(
    z.strictObject({ name: z.string().min(1), kind: z.string(), bytes: z.number().int().min(0), private: z.boolean(), at: iso }),
  ),
  urls: z.strictObject({ preview: z.string().optional(), prod: z.string().optional() }),
  status: z.enum(['open', 'delivered', 'changing', 'archived']),
})

const fileSchema = z.strictObject({ version: z.literal(1), mockups: z.array(mockup) })

export type ParsedFile = { readonly ok: true; readonly file: MockupsFile } | { readonly ok: false; readonly reason: string }

export function parseFile(raw: unknown): ParsedFile {
  const parsed = fileSchema.safeParse(raw)
  if (parsed.success) return { ok: true, file: parsed.data as MockupsFile }
  const issue = parsed.error.issues[0]
  const path = issue === undefined || issue.path.length === 0 ? 'the file' : issue.path.map(String).join('.')
  return { ok: false, reason: `${path}: ${issue?.message ?? 'invalid'}` }
}
