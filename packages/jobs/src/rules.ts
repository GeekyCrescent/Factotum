/**
 * The owner's standing instructions (design D7): `{ text, scope }` in `rules`, sent to every
 * generation and rewrite prompt as «Standing instructions from the owner» while enabled.
 *
 * «DELETE» SWITCHES A RULE OFF, never removes the row: what was generated with it keeps its id.
 *
 * `afterSave` runs inside the same `tx` and a `!ok` rolls the change back, as in `profile.ts`.
 */

import { uuidv7 } from '@factotum/sessions'
import { z } from 'zod'
import type { AfterSave, Saved } from './profile.ts'
import type { Db, Queries } from './store/db.ts'
import { getRule, insertRule, listRules, updateRule } from './store/repo.ts'
import { MAX_RULE_CHARS, shape } from './shape.ts'
import { CHANNELS, fail, ok, type Channel, type Result, type Rule, type RuleScope } from './types.ts'

const text = z.string().trim().min(1, 'a rule has text').max(MAX_RULE_CHARS, `a rule is at most ${MAX_RULE_CHARS} characters`)
const scope = z.enum(['all', ...CHANNELS], { error: 'a scope is "all" or a channel' })

const newRuleSchema = z.strictObject({ text, scope, enabled: z.boolean().optional() })
const editRuleSchema = z
  .strictObject({ text: text.optional(), scope: scope.optional(), enabled: z.boolean().optional() })
  .refine((edit) => Object.keys(edit).length > 0, 'an edit changes at least one field')

interface RuleFields {
  readonly text?: string
  readonly scope?: RuleScope
  readonly enabled?: boolean
}

export interface RuleContext<T> {
  readonly now: () => Date
  readonly newId?: () => string
  readonly afterSave?: AfterSave<Rule, T>
}

function finish<T>(q: Queries, saved: Rule, afterSave: AfterSave<Rule, T> | undefined): Result<Saved<Rule, T>> {
  if (afterSave === undefined) return ok({ saved, hook: undefined as T })
  const hook = afterSave(q, saved)
  return hook.ok ? ok({ saved, hook: hook.value }) : hook
}

function edit<T>(db: Db, id: string, fields: RuleFields, ctx: RuleContext<T>, data: Readonly<Record<string, unknown>> = {}): Result<Saved<Rule, T>> {
  return db.tx((q) => {
    const current = getRule(q, id)
    if (current === undefined) return fail('not-found', 'no such rule')
    const now = ctx.now()
    const saved: Rule = { ...current, ...fields, updatedAt: now.toISOString() }
    updateRule(q, saved, { kind: 'rule-saved', data }, now)
    return finish(q, saved, ctx.afterSave)
  })
}

/** Creates a rule, or edits rule `id` with the fields given. */
export function saveRule<T = undefined>(db: Db, input: unknown, ctx: RuleContext<T>, id?: string): Result<Saved<Rule, T>> {
  if (id !== undefined) {
    const parsed = shape<RuleFields>(editRuleSchema, input)
    return parsed.ok ? edit(db, id, parsed.value, ctx) : parsed
  }
  const parsed = shape<{ readonly text: string; readonly scope: RuleScope; readonly enabled?: boolean }>(newRuleSchema, input)
  if (!parsed.ok) return parsed
  return db.tx((q) => {
    const now = ctx.now()
    const at = now.toISOString()
    const saved: Rule = { id: ctx.newId?.() ?? uuidv7(now.getTime()), text: parsed.value.text, scope: parsed.value.scope, enabled: parsed.value.enabled ?? true, createdAt: at, updatedAt: at }
    insertRule(q, saved, { kind: 'rule-saved' }, now)
    return finish(q, saved, ctx.afterSave)
  })
}

/** «Delete»: the rule is switched off. */
export const deleteRule = <T = undefined>(db: Db, id: string, ctx: RuleContext<T>): Result<Saved<Rule, T>> =>
  edit(db, id, { enabled: false }, ctx, { deleted: true })

/** The rules a prompt for `channel` gets. */
export const enabledRules = (q: Queries, channel: Channel): readonly Rule[] =>
  listRules(q).filter((rule) => rule.enabled && (rule.scope === 'all' || rule.scope === channel))
