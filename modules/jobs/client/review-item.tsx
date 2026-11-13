/**
 * One item of the batch (spec 2026-11-12-postulaciones, design D15 «Revisión»; requirements crit.
 * 28b, 29–34; mockup B v2).
 *
 * ON TOP, the company (large) · the role, and the labels: hours, channel, score, and one per warning —
 * red if it blocks, amber if it warns, the `detail` on hover. THEN, from 900 px, the letter (with its
 * subject and the «To:» line) and the CV side by side; below, the form answers with ✓/⚠, the owner's
 * notes folded, and «Gaps vs the ad».
 *
 * A BLOCKED ITEM (crit. 28b) lists its blocks above the buttons, each with its `detail` and its exits
 * (D6 «Cómo se resuelve», `exitsFor`). The address is NOT a block (v4, A2): it lives on the «To:» line.
 *
 * THE BOX «Tell the AI what to change» sends with ⏎ (⇧⏎ for a new line) and the screen moves on
 * without waiting (crit. 31). An instruction that reads as a rule offers «Save as a rule for all?»,
 * one click (crit. 33). A rewritten item's diff and its «Try again» are `rewritten.tsx`'s (R5a).
 */

import type { JSX, RefObject } from 'preact'
import { useState } from 'preact/hooks'
import type { ApplicationCard, Decision, FollowupCard, ItemResult, ReplyCard, ReviewItem, RewriteInfo, ViewProps } from './contract.ts'
import { Cv, FormAnswers, Gaps, Labels, Letter, Notes, ToLine } from './item-parts.tsx'
import { blockersOf, exitsFor, gapsOf, labelsOf, refusalOf, reviewableOf, safeHref, type Exit, type Reviewable } from './model.ts'
import { isRuleHint } from './rule-hint.ts'

/** What the card can ask of the screen. */
export interface ItemActions {
  /** Posts a decision on this item; resolves with whether it went through. An `instruct` moves on. */
  readonly decide: (decision: Omit<Decision, 'itemId' | 'seen'>) => Promise<boolean>
  /** «Send anyway», its second click (T-D5). */
  readonly sendAnyway: () => void
  /** «Retry» of a generation or a reprint (D10). */
  readonly retryJob: (applicationId: string, job: 'cv' | 'letter' | 'reprint') => Promise<void>
  /** To `/m/jobs/settings#<anchor>`. */
  readonly settings: (anchor: string) => void
  readonly skip: () => void
}

export interface ReviewItemProps {
  readonly props: ViewProps
  readonly item: ReviewItem
  readonly result: ItemResult | undefined
  readonly actions: ItemActions
  /** The instruction box, focused by `/`. */
  readonly box: RefObject<HTMLTextAreaElement>
  readonly busy: boolean
}

const GMAIL = 'https://mail.google.com/'

export function ReviewItemView({ props, item, result, actions, box, busy }: ReviewItemProps) {
  const [text, setText] = useState('')
  const subject = reviewableOf(item)
  const decided = result !== undefined
  const applicationId = applicationIdOf(item)

  const onExit = (exit: Exit): void => {
    switch (exit.kind) {
      case 'settings':
        return actions.settings(exit.anchor)
      case 'instruct':
        if (exit.text !== '') setText(exit.text)
        return box.current?.focus()
      case 'override':
        return void actions.decide({ kind: 'override', warningCodes: [exit.code] })
      case 'retry':
        if (applicationId !== null) void actions.retryJob(applicationId, exit.job)
        return undefined
      case 'switch-to-form':
        return void actions.decide({ kind: 'switch-to-form' })
      case 'switch-channel':
        return void actions.decide({ kind: 'switch-channel' })
      case 'skip':
        return actions.skip()
      case 'status':
        return undefined
    }
  }

  const toLine = (entity: 'application' | 'followup', card: { readonly to: string | null; readonly contact: ApplicationCard['contact'] }, formUrl: string | null) => (
    <ToLine
      entity={entity}
      to={card.to}
      contact={card.contact}
      formUrl={formUrl}
      decided={decided}
      busy={busy}
      onSendAnyway={actions.sendAnyway}
      onSwitch={() => void actions.decide({ kind: entity === 'followup' ? 'switch-channel' : 'switch-to-form' })}
    />
  )

  return (
    <article class="j-item">
      {item.kind === 'application' ? <Application props={props} app={item.application} toLine={toLine} rewrite={undefined} /> : null}
      {item.kind === 'rewritten' && item.target === 'application' ? (
        <Application props={props} app={item.application} toLine={toLine} rewrite={item.rewrite} />
      ) : null}
      {item.kind === 'followup' ? <Followup followup={item.followup} toLine={toLine} rewrite={undefined} /> : null}
      {item.kind === 'rewritten' && item.target === 'followup' ? <Followup followup={item.followup} toLine={toLine} rewrite={item.rewrite} /> : null}
      {item.kind === 'reply' ? <Reply reply={item.reply} /> : null}
      {item.kind === 'proposal' ? <p class="j-quiet">A CV keeper proposal: they arrive in phase 3.</p> : null}
      {subject === null || decided ? null : <Blocks subject={subject} onExit={onExit} busy={busy} />}
      {subject === null || decided ? null : (
        <InstructBox
          props={props}
          text={text}
          setText={setText}
          box={box}
          busy={busy}
          placeholder={item.kind === 'rewritten' ? 'Anything else? (or Approve)' : 'Tell the AI what to change'}
          onSend={async (instruction) => {
            if (await actions.decide({ kind: 'instruct', text: instruction })) setText('')
          }}
        />
      )}
    </article>
  )
}

function applicationIdOf(item: ReviewItem): string | null {
  if (item.kind === 'application' || (item.kind === 'rewritten' && item.target === 'application')) return item.application.id
  return null
}

type ToLineFor = (entity: 'application' | 'followup', card: { readonly to: string | null; readonly contact: ApplicationCard['contact'] }, formUrl: string | null) => JSX.Element

function Head({ company, role, rewrite }: { readonly company: string; readonly role: string; readonly rewrite: RewriteInfo | undefined }) {
  return (
    <header class="j-item-head">
      <h2 class="j-company">{company}</h2>
      <p class="j-role">{role}</p>
      {rewrite === undefined ? null : (
        <p class={`j-rewrite${rewrite.failed ? ' failed' : ''}`}>
          {rewrite.failed ? 'rewrite failed' : 'rewritten'}
          {rewrite.instruction === null ? '' : ` · “${rewrite.instruction}”`}
          {rewrite.failed && rewrite.reason !== null ? ` — ${rewrite.reason}` : ''}
        </p>
      )}
    </header>
  )
}

function Application({ props, app, toLine, rewrite }: { readonly props: ViewProps; readonly app: ApplicationCard; readonly toLine: ToLineFor; readonly rewrite: RewriteInfo | undefined }) {
  const ad = safeHref(app.adUrl)
  const letterTitle = app.channel === 'email' ? 'Email' : app.channel === 'linkedin' ? 'LinkedIn note' : 'Cover letter'
  const body = app.channel === 'linkedin' ? (app.linkedin ?? app.letter?.body ?? null) : (app.letter?.body ?? null)
  return (
    <>
      <Head company={app.company.name} role={app.role} rewrite={rewrite} />
      <Labels labels={labelsOf(app)} />
      {ad === null ? null : (
        <a class="j-ad" href={ad} target="_blank" rel="noopener noreferrer">
          Open the ad
        </a>
      )}
      <div class="j-columns">
        <div class="j-column">
          {app.channel === 'email' ? toLine('application', app, app.formUrl) : null}
          <Letter title={letterTitle} subject={app.letter?.subject ?? null} body={body} />
        </div>
        <div class="j-column">
          <Cv api={props.api} cv={app.cv} />
        </div>
      </div>
      <FormAnswers form={app.form} />
      <Gaps gaps={gapsOf(app.warnings)} />
      <Notes notes={app.notes} />
    </>
  )
}

function Followup({ followup, toLine, rewrite }: { readonly followup: FollowupCard; readonly toLine: ToLineFor; readonly rewrite: RewriteInfo | undefined }) {
  return (
    <>
      <Head company={followup.company.name} role={`Follow-up ${followup.n} · ${followup.role}`} rewrite={rewrite} />
      <Labels labels={labelsOf({ hours: null, channel: followup.channel, score: null, warnings: followup.warnings })} />
      {followup.channel === 'email' ? toLine('followup', followup, null) : null}
      <Letter title={followup.channel === 'email' ? 'Email' : 'LinkedIn note'} subject={followup.subject} body={followup.body} />
    </>
  )
}

function Reply({ reply }: { readonly reply: ReplyCard }) {
  const link = safeHref(reply.link, GMAIL)
  return (
    <>
      <Head company={reply.company.name} role={reply.subject} rewrite={undefined} />
      <p class="j-quiet">From {reply.from}</p>
      <p class="j-text">{reply.summary}</p>
      {link === null ? null : (
        <a class="btn sm" href={link} target="_blank" rel="noopener noreferrer">
          Open in Gmail
        </a>
      )}
    </>
  )
}

/** The blocks still standing, each with its `detail` and its exits (crit. 28b). */
function Blocks({ subject, onExit, busy }: { readonly subject: Reviewable; readonly onExit: (exit: Exit) => void; readonly busy: boolean }) {
  const blocks = blockersOf(subject.warnings)
  if (blocks.length === 0) return null
  const ctx = { entity: subject.entity, formUrl: subject.formUrl, jobs: subject.jobs }
  return (
    <section class="j-blocks" aria-label="What blocks Approve">
      <h3 class="j-doc-title">Blocked</h3>
      <ul>
        {blocks.map((warning, at) => (
          <li key={at} class="j-block">
            <p>
              <strong>{warning.code}</strong> · {warning.detail}
            </p>
            <div class="j-exits">
              {exitsFor(warning, ctx).map((exit, n) =>
                exit.kind === 'status' ? (
                  <span key={n} class="j-quiet">
                    {exit.label}
                  </span>
                ) : (
                  <button
                    key={n}
                    type="button"
                    class="btn sm"
                    disabled={busy || (exit.kind === 'switch-to-form' && !exit.enabled)}
                    onClick={() => onExit(exit)}
                  >
                    {exit.label}
                  </button>
                ),
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

interface InstructBoxProps {
  readonly props: ViewProps
  readonly text: string
  readonly setText: (text: string) => void
  readonly box: RefObject<HTMLTextAreaElement>
  readonly busy: boolean
  readonly placeholder: string
  readonly onSend: (instruction: string) => Promise<void>
}

function InstructBox({ props, text, setText, box, busy, placeholder, onSend }: InstructBoxProps) {
  const [rule, setRule] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  /** Why the rule was not saved, as the daemon said it. */
  const [ruleError, setRuleError] = useState<string | null>(null)
  const instruction = text.trim()
  const send = () => {
    if (instruction === '' || busy) return
    setRule('idle')
    void onSend(instruction)
  }
  const saveRule = async () => {
    if (rule === 'saving') return
    setRule('saving')
    setRuleError(null)
    try {
      await props.api.post('rules', { text: instruction, scope: 'all' })
      setRule('saved')
    } catch (cause) {
      setRuleError(refusalOf(cause).text)
      setRule('failed')
    }
  }
  return (
    <section class="j-ask">
      <div class="j-ask-row">
        <textarea
          ref={box}
          class="j-ask-box"
          rows={2}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          onInput={(event) => {
            setText(event.currentTarget.value)
            setRule('idle')
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) return
            event.preventDefault()
            send()
          }}
        />
        <button type="button" class="btn" disabled={busy || instruction === ''} onClick={send}>
          Send to AI ⏎
        </button>
      </div>
      {isRuleHint(instruction) ? (
        <p class="j-rule">
          {rule === 'saved' ? (
            'Saved as a rule for all.'
          ) : (
            <>
              {rule === 'failed' && ruleError !== null ? <span role="alert">Could not save it: {ruleError} </span> : null}
              <button type="button" class="btn sm quiet" disabled={rule === 'saving'} onClick={() => void saveRule()}>
                {rule === 'failed' ? 'Try again' : 'Save as a rule for all?'}
              </button>
            </>
          )}
        </p>
      ) : null}
    </section>
  )
}
