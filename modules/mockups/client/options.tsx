/**
 * The options of a choosing gate (design D6; criteria 24, 28): one card each, with its title and its
 * line. A card is picked first and confirmed with one big button, so a thumb that lands on the wrong
 * card on the phone never chooses. An option with a `url` (plan's directions) opens it in a new tab.
 */

import { useEffect, useState } from 'preact/hooks'
import type { StageOption } from '../types.ts'
import { Icon } from './icon.tsx'

export function Options({
  options,
  busy,
  enabled,
  onChoose,
}: {
  readonly options: readonly StageOption[]
  readonly busy: boolean
  readonly enabled: boolean
  readonly onChoose: (optionId: string) => void
}) {
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const ids = options.map((option) => option.id).join(' ')
  useEffect(() => setPicked(undefined), [ids])
  const chosen = options.find((option) => option.id === picked)
  return (
    <div class="mk-options">
      <ul class="mk-option-list" aria-label="Options">
        {options.map((option) => (
          <li key={option.id} class={`mk-option${option.id === picked ? ' mk-picked' : ''}`}>
            <button type="button" class="mk-option-btn" aria-pressed={option.id === picked} disabled={busy || !enabled} onClick={() => setPicked(option.id)}>
              <span class="mk-option-title">
                <span class="mk-option-mark" aria-hidden="true" />
                {option.title}
              </span>
              <span class="mk-small">{option.blurb}</span>
            </button>
            {option.url === undefined ? null : (
              <a class="btn sm mk-option-open" href={option.url} target="_blank" rel="noopener noreferrer">
                <Icon name="arrow-square-out" size={14} /> Open
              </a>
            )}
          </li>
        ))}
      </ul>
      <button type="button" class="btn primary mk-big" disabled={busy || !enabled || chosen === undefined} onClick={() => chosen !== undefined && onChoose(chosen.id)}>
        {chosen === undefined ? 'Pick one to choose it' : `Choose «${chosen.title}»`}
      </button>
    </div>
  )
}
