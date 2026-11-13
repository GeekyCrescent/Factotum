/**
 * The settings page, `/m/jobs/settings` (spec 2026-11-12-postulaciones, design D7, D15 «Ajustes»;
 * requirements crit. 14–17, 9). ONE LONG PAGE: the profile's sections, each text in a `textarea`
 * that grows; «Save» posts a new version and says «Saved as version 4». Below, the rules
 * (`rules.tsx`) and «Import the package» (`import-panel.tsx`).
 *
 * A BLOCK'S EXIT LANDS HERE: `settings#portfolio` scrolls to that field once the profile is read.
 * What the form means is `settings-model.ts`'s; the engine is the judge, and its `400 { field }` is
 * shown beside the field it names.
 */

import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'
import type { ProfileVersion, SavedProfile, ViewProps } from './contract.ts'
import { CheckField, LineField, TextField } from './fields.tsx'
import { createLock, runOrSay } from './guard.ts'
import { ImportPanel } from './import-panel.tsx'
import { refusalOf } from './model.ts'
import { Rules } from './rules.tsx'
import { afterSave, anchorOfField, fieldOf, formOf, profileOf, savedLine, type GoalForm, type ProfileForm } from './settings-model.ts'

/** A change to the form: the fields, or how to make them from the form as it is now. */
type Change = Partial<ProfileForm> | ((now: ProfileForm) => Partial<ProfileForm>)

type Saving = { readonly kind: 'idle' } | { readonly kind: 'saved'; readonly line: string } | { readonly kind: 'refused'; readonly anchor: string; readonly why: string }

const IDENTITY: readonly { readonly key: keyof ProfileForm['identity']; readonly id: string; readonly label: string; readonly hint?: string }[] = [
  { key: 'name', id: 'name', label: 'Name' },
  { key: 'email', id: 'email', label: 'Email' },
  { key: 'phone', id: 'phone', label: 'Phone', hint: 'Without it nothing becomes ready, and the package is not imported.' },
  { key: 'linkedin', id: 'linkedin', label: 'LinkedIn' },
  { key: 'city', id: 'city', label: 'City' },
  { key: 'suburb', id: 'suburb', label: 'Suburb' },
  { key: 'timezone', id: 'timezone', label: 'Time zone while travelling' },
  { key: 'portfolioUrl', id: 'portfolio', label: 'Portfolio link' },
  { key: 'cvAvailabilityLine', id: 'cvAvailabilityLine', label: 'Availability line on the CV', hint: 'One line, printed under your contact.' },
]

const scrollTo = (anchor: string): void => document.getElementById(anchor)?.scrollIntoView({ block: 'center' })

export function Settings({ props, anchor }: { readonly props: ViewProps; readonly anchor: string | null }) {
  const { api } = props
  const [base, setBase] = useState<ProfileVersion | null>(null)
  const [form, setForm] = useState<ProfileForm | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState<Saving>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  const lock = useMemo(createLock, [])

  useEffect(() => {
    api
      .get<ProfileVersion>('profile')
      .then((version) => {
        setBase(version)
        setForm(formOf(version.profile))
      })
      .catch((cause: unknown) => setLoadError(refusalOf(cause).text))
  }, [api])

  // The exit of a block lands on its field once the page has it.
  useEffect(() => {
    if (form !== null && anchor !== null) scrollTo(anchor)
  }, [form === null, anchor])

  /** Each change applies to the form as it is NOW (a functional update): two keystrokes in one frame both land. */
  const edit = useCallback((change: Change): void => {
    setForm((now) => (now === null ? now : { ...now, ...(typeof change === 'function' ? change(now) : change) }))
    setSaving({ kind: 'idle' })
  }, [])

  const save = async (): Promise<void> => {
    if (form === null || base === null) return
    const posted = form
    const outcome = profileOf(posted, base.profile)
    if (!outcome.ok) {
      setSaving({ kind: 'refused', anchor: anchorOfField(outcome.field), why: outcome.why })
      scrollTo(anchorOfField(outcome.field))
      return
    }
    await runOrSay(lock, async () => {
      setBusy(true)
      try {
        const saved = await api.post<SavedProfile>('profile', outcome.profile)
        setBase(saved)
        // What was typed during the save stays (`afterSave`); it is saved with the next «Save».
        setForm((now) => afterSave(now, posted, saved.profile))
        setSaving({ kind: 'saved', line: savedLine(saved) })
      } catch (cause) {
        const field = fieldOf(cause)
        const at = field === null ? 'identity' : anchorOfField(field)
        setSaving({ kind: 'refused', anchor: at, why: refusalOf(cause).text })
        if (field !== null) scrollTo(at)
      } finally {
        setBusy(false)
      }
    }, (why) => setSaving({ kind: 'refused', anchor: 'identity', why }))
  }

  const errorAt = (id: string): string | null => (saving.kind === 'refused' && saving.anchor === id ? saving.why : null)

  return (
    <div class="j-screen">
      <header class="j-review-bar">
        <p class="j-crumb">Jobs › Settings</p>
      </header>
      <main class="j-settings">
        {loadError === null ? null : (
          <div class="notice err" role="alert">
            <p>Could not read the profile: {loadError}</p>
          </div>
        )}
        {form === null || base === null ? (
          loadError === null ? <p class="j-loading">Loading…</p> : null
        ) : (
          <ProfileSections form={form} edit={edit} errorAt={errorAt} />
        )}
        {form === null ? null : (
          <div class="j-save-bar">
            <p class={`j-save-line${saving.kind === 'refused' ? ' err' : ''}`} role="status">
              {saving.kind === 'saved' ? saving.line : saving.kind === 'refused' ? `Not saved: ${saving.why}` : base === null ? '' : `Version ${base.version}`}
            </p>
            <button type="button" class="btn primary" disabled={busy} onClick={() => void save()}>
              Save
            </button>
          </div>
        )}
        <Rules api={api} />
        <ImportPanel api={api} />
      </main>
    </div>
  )
}

interface SectionsProps {
  readonly form: ProfileForm
  readonly edit: (change: Change) => void
  readonly errorAt: (id: string) => string | null
}

function ProfileSections({ form, edit, errorAt }: SectionsProps) {
  const text = (key: 'situation' | 'availability' | 'level' | 'redLinesText' | 'preferencesText') => (value: string) => edit({ [key]: value })
  return (
    <>
      <section class="j-section" id="identity">
        <h2>Identity</h2>
        {IDENTITY.map((field) => (
          <LineField
            key={field.key}
            id={field.id}
            label={field.label}
            value={form.identity[field.key]}
            hint={field.hint}
            error={errorAt(field.id)}
            onInput={(value) => edit((now) => ({ identity: { ...now.identity, [field.key]: value } }))}
          />
        ))}
        <LineField id="rate" label="Rate you expect" value={form.rateExpectation} hint="Empty: a neutral sentence instead of a number." error={errorAt('rate')} onInput={(value) => edit({ rateExpectation: value })} />
      </section>
      <section class="j-section">
        <h2>Situation and availability</h2>
        <TextField id="situation" label="Situation and work rights" value={form.situation} error={errorAt('situation')} onInput={text('situation')} />
        <TextField id="availability" label="Availability" value={form.availability} error={errorAt('availability')} onInput={text('availability')} />
        <TextField id="absences" label="Absences" value={form.absences} hint="One per line: 2026-11-26 → 2027-01-10 Away from Sydney" error={errorAt('absences')} onInput={(value) => edit({ absences: value })} />
      </section>
      <Goals form={form} edit={edit} errorAt={errorAt} />
      <section class="j-section">
        <h2>Level, red lines, preferences</h2>
        <TextField id="level" label="Level" value={form.level} error={errorAt('level')} onInput={text('level')} />
        <TextField id="redLines" label="Red lines" value={form.redLinesText} error={errorAt('redLines')} onInput={text('redLinesText')} />
        <TextField label="Title words that rule a job out" value={form.titleWords} hint="One per line." onInput={(value) => edit({ titleWords: value })} />
        <TextField label="Requirement words that rule a job out" value={form.requirementWords} hint="One per line." onInput={(value) => edit({ requirementWords: value })} />
        <CheckField label="Nothing unpaid" checked={form.unpaid} onChange={(unpaid) => edit({ unpaid })} />
        <CheckField label="Nothing equity-only" checked={form.equityOnly} onChange={(equityOnly) => edit({ equityOnly })} />
        <TextField id="preferences" label="Preferences" value={form.preferencesText} error={errorAt('preferences')} onInput={text('preferencesText')} />
        <TextField id="forbiddenStacks" label="Stacks never to claim" value={form.forbiddenStacks} hint="One per line." error={errorAt('forbiddenStacks')} onInput={(value) => edit({ forbiddenStacks: value })} />
        <TextField id="confidential" label="Names never written" value={form.confidential} hint="One per line." error={errorAt('confidential')} onInput={(value) => edit({ confidential: value })} />
      </section>
      <section class="j-section" id="batchSize">
        <h2>Batches and weights</h2>
        <LineField label="Batch size" value={form.batchSize} hint="1 to 20." error={errorAt('batchSize')} onInput={(value) => edit({ batchSize: value })} />
        <div class="j-weights" id="weights">
          {Object.entries(form.weights).map(([key, value]) => (
            <LineField key={key} label={`Weight: ${key}`} value={value} onInput={(next) => edit((now) => ({ weights: { ...now.weights, [key]: next } }))} />
          ))}
        </div>
        {errorAt('weights') === null ? null : (
          <p class="j-error" role="alert">
            {errorAt('weights')}
          </p>
        )}
      </section>
      <section class="j-section" id="followup">
        <h2>Follow-up templates</h2>
        <p class="j-quiet">Only {'{greetingName}'}, {'{role}'}, {'{company}'}, {'{sentDate}'} and {'{signature}'} (not in the LinkedIn one).</p>
        {errorAt('followup') === null ? null : (
          <p class="j-error" role="alert">
            {errorAt('followup')}
          </p>
        )}
        <LineField label="Subject (no thread to reply to)" value={form.followup.subject} onInput={(subject) => edit((now) => ({ followup: { ...now.followup, subject } }))} />
        <TextField label="First follow-up" value={form.followup.first} onInput={(first) => edit((now) => ({ followup: { ...now.followup, first } }))} />
        <TextField label="Second follow-up" value={form.followup.second} onInput={(second) => edit((now) => ({ followup: { ...now.followup, second } }))} />
        <TextField label="LinkedIn follow-up" value={form.followup.linkedin} onInput={(linkedin) => edit((now) => ({ followup: { ...now.followup, linkedin } }))} />
      </section>
    </>
  )
}

function Goals({ form, edit, errorAt }: SectionsProps) {
  const set = (at: number, change: Partial<GoalForm>) => edit((now) => ({ goals: now.goals.map((goal, n) => (n === at ? { ...goal, ...change } : goal)) }))
  return (
    <section class="j-section" id="goals">
      <h2>Goals</h2>
      {errorAt('goals') === null ? null : (
        <p class="j-error" role="alert">
          {errorAt('goals')}
        </p>
      )}
      {form.goals.map((goal, at) => (
        <fieldset key={at} class="j-goal">
          <legend>{goal.label}</legend>
          <CheckField label="On" checked={goal.enabled} onChange={(enabled) => set(at, { enabled })} />
          <LineField label="Label" value={goal.label} onInput={(label) => set(at, { label })} />
          <TextField label="What it looks for" value={goal.text} onInput={(value) => set(at, { text: value })} />
          <LineField label="Pay floor" value={goal.payFloor} hint="Like «45 AUD per hour», or empty." onInput={(payFloor) => set(at, { payFloor })} />
          <LineField label="Sources" value={goal.sources} hint="Comma-separated." onInput={(sources) => set(at, { sources })} />
        </fieldset>
      ))}
    </section>
  )
}
