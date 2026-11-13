/**
 * The settings page's fields: a label over a one-line input or a `textarea` that grows with its text
 * (design D15 «Ajustes»). The `id` is the anchor a block's exit leads to (`settings#portfolio`).
 *
 * THE ENGINE'S REFUSAL IS OUTSIDE THE `<label>`: inside, it would become part of the field's name. It
 * sits under it and the field points at it (`aria-describedby`).
 */

import type { JSX } from 'preact'
import { useId } from 'preact/hooks'

export interface FieldProps {
  readonly id?: string | undefined
  readonly label: string
  readonly value: string
  readonly onInput: (value: string) => void
  /** Under the field: how it is written. */
  readonly hint?: string | undefined
  /** The engine refused this field: why. */
  readonly error?: string | null | undefined
}

const hasError = (error: FieldProps['error']): error is string => error !== undefined && error !== null

function Field({ id, label, hint, error, control }: Omit<FieldProps, 'value' | 'onInput'> & { readonly control: (describedBy: string | undefined) => JSX.Element }) {
  const errorId = useId()
  return (
    <div class="j-field" id={id}>
      <label class="j-field-label">
        <span>{label}</span>
        {control(hasError(error) ? errorId : undefined)}
        {hint === undefined ? null : <span class="j-quiet">{hint}</span>}
      </label>
      {hasError(error) ? (
        <p class="j-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function LineField({ id, label, value, onInput, hint, error }: FieldProps) {
  return (
    <Field
      id={id}
      label={label}
      hint={hint}
      error={error}
      control={(describedBy) => (
        <input class="j-input" value={value} aria-invalid={describedBy === undefined ? undefined : true} aria-describedby={describedBy} onInput={(event) => onInput(event.currentTarget.value)} />
      )}
    />
  )
}

export function TextField({ id, label, value, onInput, hint, error }: FieldProps) {
  return (
    <Field
      id={id}
      label={label}
      hint={hint}
      error={error}
      control={(describedBy) => (
        <textarea class="j-input" rows={3} value={value} aria-invalid={describedBy === undefined ? undefined : true} aria-describedby={describedBy} onInput={(event) => onInput(event.currentTarget.value)} />
      )}
    />
  )
}

export function CheckField({ label, checked, onChange }: { readonly label: string; readonly checked: boolean; readonly onChange: (checked: boolean) => void }) {
  return (
    <label class="j-check">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span>{label}</span>
    </label>
  )
}
