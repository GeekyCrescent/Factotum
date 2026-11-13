/**
 * The settings page's fields: a label over a one-line input or a `textarea` that grows with its text
 * (design D15 «Ajustes»). The `id` is the anchor a block's exit leads to (`settings#portfolio`).
 */

export interface FieldProps {
  readonly id?: string
  readonly label: string
  readonly value: string
  readonly onInput: (value: string) => void
  /** Under the field: how it is written. */
  readonly hint?: string | undefined
  /** The engine refused this field: why. */
  readonly error?: string | null | undefined
}

function Under({ hint, error }: Pick<FieldProps, 'hint' | 'error'>) {
  return (
    <>
      {hint === undefined ? null : <span class="j-quiet">{hint}</span>}
      {error === undefined || error === null ? null : (
        <span class="j-error" role="alert">
          {error}
        </span>
      )}
    </>
  )
}

export function LineField({ id, label, value, onInput, hint, error }: FieldProps) {
  return (
    <label class="j-field" id={id}>
      <span>{label}</span>
      <input class="j-input" value={value} aria-invalid={error === undefined || error === null ? undefined : true} onInput={(event) => onInput(event.currentTarget.value)} />
      <Under hint={hint} error={error} />
    </label>
  )
}

export function TextField({ id, label, value, onInput, hint, error }: FieldProps) {
  return (
    <label class="j-field" id={id}>
      <span>{label}</span>
      <textarea class="j-input" rows={3} value={value} aria-invalid={error === undefined || error === null ? undefined : true} onInput={(event) => onInput(event.currentTarget.value)} />
      <Under hint={hint} error={error} />
    </label>
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
