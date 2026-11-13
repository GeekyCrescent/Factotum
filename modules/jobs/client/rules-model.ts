/**
 * The rules list of the settings page, as data (design D7; requirements crit. 17). Pure.
 *
 * A rule has text (1–300), a scope (`all` or a channel) and a state. «Delete» switches it off — the
 * row stays, so what was generated with it keeps its id — and a rule switched off can be turned on.
 */

import type { Channel, NewRule, Rule, RuleEdit, RuleScope } from './contract.ts'

export const MAX_RULE_CHARS = 300

const CHANNEL_LABELS: Readonly<Record<Channel, string>> = { email: 'Email', form: 'Form', platform: 'Platform', linkedin: 'LinkedIn' }

export const RULE_SCOPES: readonly { readonly scope: RuleScope; readonly label: string }[] = [
  { scope: 'all', label: 'All' },
  ...(Object.keys(CHANNEL_LABELS) as Channel[]).map((scope) => ({ scope, label: CHANNEL_LABELS[scope] })),
]

export const scopeLabel = (scope: RuleScope): string => (scope === 'all' ? 'All' : CHANNEL_LABELS[scope])

type Checked<T> = { readonly ok: true; readonly body: T } | { readonly ok: false; readonly why: string }

function textOf(text: string): Checked<string> {
  const words = text.trim()
  if (words === '') return { ok: false, why: 'A rule needs its words' }
  if (words.length > MAX_RULE_CHARS) return { ok: false, why: `A rule is at most ${MAX_RULE_CHARS} characters` }
  return { ok: true, body: words }
}

export function newRuleOf(text: string, scope: RuleScope): Checked<NewRule> {
  const checked = textOf(text)
  return checked.ok ? { ok: true, body: { text: checked.body, scope } } : checked
}

/** What `POST /rules/:ruleId` carries: the fields that changed; `null` when none did. */
export function editOf(rule: Rule, text: string, scope: RuleScope): Checked<RuleEdit | null> {
  const checked = textOf(text)
  if (!checked.ok) return checked
  const edit: RuleEdit = { ...(checked.body === rule.text ? {} : { text: checked.body }), ...(scope === rule.scope ? {} : { scope }) }
  return { ok: true, body: Object.keys(edit).length === 0 ? null : edit }
}

/** On first, newest first; then those switched off. */
export function sortedRules(rules: readonly Rule[]): readonly Rule[] {
  return [...rules].sort((a, b) => (a.enabled === b.enabled ? b.updatedAt.localeCompare(a.updatedAt) : a.enabled ? -1 : 1))
}
