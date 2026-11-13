/**
 * The rules, on the settings page (design D7, D15 «Ajustes»; requirements crit. 17): a list with the
 * text, the scope and whether it is on; «Edit», «Delete» (which switches it off: the row stays), and
 * «Turn on» for one switched off. A new rule is written at the foot. One request at a time.
 * What is posted is `rules-model.ts`'s.
 */

import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'
import type { Api, Rule, RuleEdit, RuleScope, RulesAnswer, SavedRule } from './contract.ts'
import { createLock } from './guard.ts'
import { refusalOf } from './model.ts'
import { editOf, MAX_RULE_CHARS, newRuleOf, RULE_SCOPES, scopeLabel, sortedRules } from './rules-model.ts'

export function Rules({ api }: { readonly api: Api }) {
  const [rules, setRules] = useState<readonly Rule[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const lock = useMemo(createLock, [])

  const load = useCallback(async () => {
    try {
      setRules((await api.get<RulesAnswer>('rules')).rules)
    } catch (cause) {
      setError(refusalOf(cause).text)
    }
  }, [api])
  useEffect(() => void load(), [load])

  /** Posts, reads the list again; resolves with whether it went through. */
  const post = async (path: string, body: unknown): Promise<boolean> =>
    (await lock.run(async () => {
      setBusy(true)
      setError(null)
      try {
        await api.post<SavedRule>(path, body)
        await load()
        return true
      } catch (cause) {
        setError(refusalOf(cause).text)
        return false
      } finally {
        setBusy(false)
      }
    })) ?? false

  const ruleUrl = (rule: Rule): string => `rules/${encodeURIComponent(rule.id)}`

  return (
    <section class="j-section" id="rules">
      <h2>Rules</h2>
      <p class="j-quiet">Standing instructions, sent with every draft and rewrite while they are on.</p>
      {error === null ? null : (
        <p class="j-error" role="alert">
          {error}
        </p>
      )}
      {rules === null ? null : (
        <ul class="j-rules">
          {sortedRules(rules).map((rule) =>
            editing === rule.id ? (
              <li key={rule.id} class="j-rule-row">
                <RuleForm
                  initial={rule}
                  busy={busy}
                  submit="Save"
                  onCancel={() => setEditing(null)}
                  onSubmit={async (text, scope) => {
                    const edit = editOf(rule, text, scope)
                    if (!edit.ok) return edit.why
                    if (edit.body === null || (await post(ruleUrl(rule), edit.body satisfies RuleEdit))) setEditing(null)
                    return null
                  }}
                />
              </li>
            ) : (
              <li key={rule.id} class={`j-rule-row${rule.enabled ? '' : ' off'}`}>
                <p class="j-text">{rule.text}</p>
                <p class="j-quiet">
                  {scopeLabel(rule.scope)} · {rule.enabled ? 'on' : 'off'}
                </p>
                <div class="j-exits">
                  <button type="button" class="btn sm" disabled={busy} onClick={() => setEditing(rule.id)}>
                    Edit
                  </button>
                  <button type="button" class="btn sm" disabled={busy} onClick={() => void post(ruleUrl(rule), { enabled: !rule.enabled } satisfies RuleEdit)}>
                    {rule.enabled ? 'Delete' : 'Turn on'}
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
      <RuleForm
        initial={null}
        busy={busy}
        submit="Add rule"
        onSubmit={async (text, scope) => {
          const rule = newRuleOf(text, scope)
          if (!rule.ok) return rule.why
          return (await post('rules', rule.body)) ? null : 'not saved'
        }}
      />
    </section>
  )
}

interface RuleFormProps {
  readonly initial: Rule | null
  readonly busy: boolean
  readonly submit: string
  /** Resolves with why it was not saved, or null; a new rule's form empties itself on null. */
  readonly onSubmit: (text: string, scope: RuleScope) => Promise<string | null>
  readonly onCancel?: () => void
}

function RuleForm({ initial, busy, submit, onSubmit, onCancel }: RuleFormProps) {
  const [text, setText] = useState(initial?.text ?? '')
  const [scope, setScope] = useState<RuleScope>(initial?.scope ?? 'all')
  const [why, setWhy] = useState<string | null>(null)
  return (
    <form
      class="j-rule-form"
      onSubmit={async (event) => {
        event.preventDefault()
        const refused = await onSubmit(text, scope)
        setWhy(refused === 'not saved' ? null : refused)
        if (refused === null && initial === null) setText('')
      }}
    >
      <label class="j-field">
        <span>{initial === null ? 'New rule' : 'Rule'}</span>
        <textarea class="j-input" rows={2} maxLength={MAX_RULE_CHARS} value={text} onInput={(event) => setText(event.currentTarget.value)} />
      </label>
      <label class="j-field j-field-narrow">
        <span>For</span>
        <select class="j-input" value={scope} onChange={(event) => setScope(event.currentTarget.value as RuleScope)}>
          {RULE_SCOPES.map((option) => (
            <option key={option.scope} value={option.scope}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <div class="j-exits">
        <button type="submit" class="btn sm primary" disabled={busy}>
          {submit}
        </button>
        {onCancel === undefined ? null : (
          <button type="button" class="btn sm quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {why === null ? null : (
        <p class="j-error" role="alert">
          {why}
        </p>
      )}
    </form>
  )
}
