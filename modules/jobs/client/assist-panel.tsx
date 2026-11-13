/**
 * The assist panel (spec 2026-11-12-postulaciones, design D9 «El panel de asistencia», D15; crit. 47,
 * 48, 50): a sheet that opens after approving a `form`, `platform` or `linkedin` application — or an
 * email with a LinkedIn note — and before the review moves on. «Open ad», «Copy» per text, the skills
 * to tick and not to tick, «Download CV» and «Mark as sent». What it holds is `assist-model.ts`'s,
 * taken from the card as it was approved: a poll that repaints the batch does not change it.
 *
 * «MARK AS SENT» goes through the review's one lock (`onMark`), as any decision does.
 */

import { useEffect, useState } from 'preact/hooks'
import { copyButton, type AssistCopy, type AssistView, type CopyState } from './assist-model.ts'
import type { Api } from './contract.ts'
import { Icon, Sheet } from './sheet.tsx'

/** How long «Copied» stays on a button. */
const COPIED_MS = 1_500

export interface AssistPanelProps {
  readonly api: Api
  readonly view: AssistView
  readonly busy: boolean
  /** Posts «Mark as sent»; resolves with the refusal's text, or null when it went through. */
  readonly onMark: () => Promise<string | null>
  readonly onClose: () => void
}

export function AssistPanel({ api, view, busy, onMark, onClose }: AssistPanelProps) {
  const [error, setError] = useState<string | null>(null)
  const mark = async () => {
    setError(null)
    const refused = await onMark()
    if (refused === null) onClose()
    else setError(refused)
  }
  return (
    <Sheet id="j-assist-title" title={view.title} onClose={onClose}>
      {view.instruction === null ? null : <p class="j-assist-instruction">{view.instruction}</p>}
      {view.links.length === 0 ? null : (
        <div class="j-exits">
          {view.links.map((link) => (
            <a key={link.href} class="btn sm" href={link.href} target="_blank" rel="noopener noreferrer">
              {link.label}
            </a>
          ))}
        </div>
      )}
      <ul class="j-copies">
        {view.copies.map((copy, at) => (
          <CopyRow key={at} copy={copy} />
        ))}
      </ul>
      {view.skills === null ? null : <Skills skills={view.skills} />}
      <div class="j-assist-foot">
        {view.pdf === null ? null : (
          <a class="btn" href={api.url(view.pdf)} download>
            Download CV (PDF)
          </a>
        )}
        {view.mark === null ? (
          <button type="button" class="btn primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button type="button" class="btn quiet" onClick={onClose}>
              Later
            </button>
            <button type="button" class="btn primary" disabled={busy} onClick={() => void mark()}>
              Mark as sent
            </button>
          </>
        )}
      </div>
      {error === null ? null : (
        <p class="j-error" role="alert">
          Could not mark it: {error}
        </p>
      )}
    </Sheet>
  )
}

function CopyRow({ copy }: { readonly copy: AssistCopy }) {
  const [done, setDone] = useState<CopyState>('idle')
  const button = copyButton(done, copy.label)
  useEffect(() => {
    if (!button.resets) return
    const timer = setTimeout(() => setDone('idle'), COPIED_MS)
    return () => clearTimeout(timer)
  }, [button.resets, done])
  const onCopy = async () => {
    try {
      if (navigator.clipboard === undefined) copyByHand(copy.text)
      else await navigator.clipboard.writeText(copy.text)
      setDone('copied')
    } catch {
      setDone('failed')
    }
  }
  return (
    <li class="j-copy">
      <div class="j-copy-head">
        <p class="j-question">{copy.label}</p>
        <button type="button" class="btn sm" aria-label={button.label} onClick={() => void onCopy()}>
          <Icon name="copy" size={14} />
          {button.text}
        </button>
        <span class="sr-only" role="status">
          {button.announce}
        </span>
      </div>
      <p class="j-text">{copy.text}</p>
      {copy.hint === null ? null : <p class="j-quiet">Note: {copy.hint}</p>}
    </li>
  )
}

function Skills({ skills }: { readonly skills: NonNullable<AssistView['skills']> }) {
  return (
    <section class="j-skills">
      {skills.tick.length === 0 ? null : (
        <div>
          <p class="j-question">Tick</p>
          <ul class="j-labels">
            {skills.tick.map((skill) => (
              <li key={skill} class="j-label">
                ✓ {skill}
              </li>
            ))}
          </ul>
        </div>
      )}
      {skills.doNotTick.length === 0 ? null : (
        <div>
          <p class="j-question">Do not tick</p>
          <ul class="j-labels">
            {skills.doNotTick.map((skill) => (
              <li key={skill} class="j-label red">
                ✗ {skill}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/** Where the Clipboard API is missing (an old browser, plain http): a hidden textarea and the copy command. */
function copyByHand(text: string): void {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  const copied = document.execCommand('copy')
  area.remove()
  if (!copied) throw new Error('copy refused')
}
