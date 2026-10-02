/**
 * The session's log: messages, tool calls with their results, and long runs of reading folded into
 * one row that opens on a tap (criteria 16, 17), and each turn's started/finished in one quiet row
 * that opens too. `fold.ts` and `activity.ts` decide; this only paints.
 *
 * A FAILURE gets its own line for the message, so the tool's name and argument are never cut to
 * make room for the error (criterion 17).
 */

import { useEffect, useState } from 'preact/hooks'
import type { Activity, Shown } from './activity.ts'
import { splitRefs, uploadUrl, type Piece } from './attachments.ts'
import { inlineRefs } from './refs.ts'
import type { Call, QuestionsRow, ServiceRow, SubagentRow } from './fold.ts'
import { describeRow, questionsLabel } from './questions.ts'
import { clock, toolArg } from './format.ts'
import { outcome } from './subagents.ts'
import { serviceOutcome } from './services.ts'
import { Icon } from './icon.tsx'
import type { SessionIcon } from './icons.ts'
import { Markdown } from './markdown.tsx'

const GLYPHS: Readonly<Record<string, SessionIcon>> = {
  Read: 'file-text',
  Grep: 'magnifying-glass',
  Glob: 'magnifying-glass',
  LS: 'magnifying-glass',
  Edit: 'pencil-simple',
  MultiEdit: 'pencil-simple',
  NotebookEdit: 'pencil-simple',
  Write: 'file-plus',
  Bash: 'terminal',
}

/**
 * `rows`: the log already folded (`activity(fold(events))`), because the screen needs the same rows to
 * know which subagents are open. `asking`: the session waits on an ask, so its call without a result is
 * waiting for the owner.
 */
export function Log({
  rows,
  running,
  asking,
  onOpenQuestions,
  onOpenService,
}: {
  readonly rows: readonly Shown[]
  readonly running: boolean
  readonly asking: boolean
  /** Opens the sheet of a batch still waiting, by its public id. */
  readonly onOpenQuestions?: (batchId: string) => void
  /** Opens a service's sheet, by its id (spec 2026-10-02, D15). */
  readonly onOpenService?: (serviceId: string) => void
}) {
  return (
    <ol class="s-log">
      {rows.map((row) => (
        <LogRow key={row.seq} row={row} running={running} asking={asking} onOpenQuestions={onOpenQuestions} onOpenService={onOpenService} />
      ))}
    </ol>
  )
}

function LogRow({
  row,
  running,
  asking,
  onOpenQuestions,
  onOpenService,
}: {
  readonly row: Shown
  readonly running: boolean
  readonly asking: boolean
  readonly onOpenQuestions: ((batchId: string) => void) | undefined
  readonly onOpenService: ((serviceId: string) => void) | undefined
}) {
  switch (row.kind) {
    case 'message':
      // The owner's words: a bubble on the right, as typed. The agent's: the page itself, as Markdown.
      return row.role === 'user' ? (
        <li class="s-user">
          <OwnerMessage text={row.text} />
        </li>
      ) : (
        <li class="s-row s-said">
          <span class="s-gut" />
          <div class="s-said-body">
            <div class="s-msg s-md">
              <Markdown text={row.text} />
            </div>
            <div class="s-msg-acts">
              <CopyButton text={row.text} />
            </div>
          </div>
        </li>
      )
    case 'call':
      return <CallRow call={row} running={running} asking={asking} />
    case 'fold':
      return <FoldRow calls={row.calls} names={row.names} running={running} />
    case 'activity':
      return <ActivityRow row={row} />
    case 'subagent':
      // Open in the turn that runs: its place is the line under the log, not a row in it.
      return row.end === undefined && running ? null : <SubagentRowView row={row} running={running} />
    case 'questions':
      return <QuestionsRowView row={row} running={running} onOpen={onOpenQuestions} />
    case 'service':
      return <ServiceRowView row={row} onOpen={onOpenService} />
  }
}

/**
 * A background service the agent started (spec 2026-10-02-servicios-en-segundo-plano, D15): where it was
 * launched, what it is, and how it stands — `running` with its time until its `ended` arrives, whatever the
 * session does. The whole row opens its sheet. Plain text: the command is the agent's.
 */
function ServiceRowView({ row, onOpen }: { readonly row: ServiceRow; readonly onOpen: ((serviceId: string) => void) | undefined }) {
  // The log repaints only when an event arrives; a live row keeps its own clock, like the lines under it.
  const [now, setNow] = useState(Date.now())
  const alive = row.end === undefined
  useEffect(() => {
    if (!alive) return undefined
    const timer = setInterval(() => setNow(Date.now()), ROW_TICK_MS)
    return () => clearInterval(timer)
  }, [alive])
  const { text, tone } = serviceOutcome(row, now)
  const what = (
    <>
      <span class="s-name">{row.by === undefined ? 'Service' : `${row.by} › service`}</span>
      <span class={row.description === undefined ? 's-arg mono' : 's-arg'}>{row.description ?? row.command}</span>
      <span class="s-sub-end">{text}</span>
    </>
  )
  return (
    <li class={`s-row s-sub s-svc s-sub-${tone}`}>
      <span class="s-gut">
        <Icon name={tone === 'failed' ? 'x-circle' : tone === 'running' ? 'circle-notch' : 'terminal'} size={16} />
      </span>
      {onOpen === undefined ? (
        <div class="s-tool">{what}</div>
      ) : (
        <button type="button" class="s-tool s-svc-open" onClick={() => onOpen(row.id)}>
          {what}
        </button>
      )}
    </li>
  )
}

/**
 * A batch of questions the agent asked (spec 2026-10-01-preguntas-con-opciones, D13): who asked, how it
 * ended, and once answered, each question with what the owner said. Plain text, never Markdown: it is
 * the agent's (guardrail 4).
 */
function QuestionsRowView({
  row,
  running,
  onOpen,
}: {
  readonly row: QuestionsRow
  readonly running: boolean
  readonly onOpen: ((batchId: string) => void) | undefined
}) {
  const view = describeRow(row, running)
  const opens = view.tone === 'waiting' && onOpen !== undefined
  return (
    <li class={`s-row s-qrow s-qrow-${view.tone}`}>
      <span class="s-gut">
        <Icon name={view.tone === 'waiting' ? 'hand' : 'list'} size={16} />
      </span>
      <div class="s-tool">
        <span class="s-name">{row.by === undefined ? 'Asked you' : `${row.by} › asked you`}</span>
        <span class="s-arg">{questionsLabel(row.questions.length)}</span>
        {/* Waiting: the status IS the way in, so the sheet opens from the log too. */}
        {opens ? (
          <button type="button" class="s-sub-end s-qrow-open" onClick={() => onOpen(row.id)}>
            {view.status}
          </button>
        ) : (
          <span class="s-sub-end">{view.status}</span>
        )}
        {view.lines.length === 0 ? (
          view.tone === 'waiting' ? null : (
            <ul class="s-qrow-asked">
              {row.questions.map((q) => (
                <li key={q.id}>{q.text}</li>
              ))}
            </ul>
          )
        ) : (
          <ul class="s-qrow-answers">
            {view.lines.map((line) => (
              <li key={line.question}>
                <span class="s-qrow-q">{line.question}</span>
                <span class="s-qrow-arrow" aria-hidden="true">
                  {' → '}
                </span>
                <span class={line.unanswered ? 's-qrow-a dim-3' : 's-qrow-a'}>{line.answer}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  )
}

/**
 * A subagent the agent launched, once it is over: what it was, how it ended, and its report, in line
 * like a call's result (spec 2026-10-01-subagentes-visibles, D6). What it did inside is not here.
 */
function SubagentRowView({ row, running }: { readonly row: SubagentRow; readonly running: boolean }) {
  const { text, tone } = outcome(row, running)
  const summary = row.end?.kind === 'ended' ? row.end.summary : ''
  return (
    <li class={`s-row s-sub s-sub-${tone}`}>
      <span class="s-gut">
        <Icon name={tone === 'failed' ? 'x-circle' : 'stack'} size={16} />
      </span>
      <div class="s-tool">
        <span class="s-name">{row.agent}</span>
        <span class="s-arg">
          {row.description}
          {row.background ? ' · background' : ''}
        </span>
        <span class="s-sub-end">{text}</span>
        {summary === '' ? null : <span class="s-res">{summary}</span>}
      </div>
    </li>
  )
}

/**
 * The owner's words as typed, with every attached file shown as what it is instead of its path — a
 * thumbnail for a picture, a chip for anything else (spec 2026-10-01, D11). The text is still the
 * record: this only reads the `@<path>` lines back out of it.
 */
function OwnerMessage({ text }: { readonly text: string }) {
  const pieces = splitRefs(text)
  if (!pieces.some((piece) => piece.kind === 'ref')) {
    return (
      <div class="s-msg">
        <InlineText text={text} />
      </div>
    )
  }
  const words = pieces.filter((piece) => piece.kind === 'text')
  const files = pieces.filter((piece): piece is Extract<Piece, { kind: 'ref' }> => piece.kind === 'ref')
  return (
    <div class="s-user-body">
      {words.map((piece, i) => (
        <div key={i} class="s-msg">
          <InlineText text={piece.text} />
        </div>
      ))}
      <ul class="s-sent-files" aria-label="Attached files">
        {files.map((file, i) => (
          <li key={`${file.uploadId}-${i}`}>
            <SentFile uploadId={file.uploadId} name={file.name} image={file.image} />
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The owner's words with each `@` reference to a project file shown as a small chip, in the flow of
 * the sentence (spec 2026-10-01-referencias-y-tab, D10). Only what the `@` list writes is a reference
 * (`inlineRefs`); everything else, `@factotum/core` included, stays the text it was. No click: opening
 * a file is out of scope.
 */
function InlineText({ text }: { readonly text: string }) {
  const pieces = inlineRefs(text)
  if (!pieces.some((piece) => piece.kind === 'ref')) return <>{text}</>
  return (
    <>
      {pieces.map((piece, i) =>
        piece.kind === 'text' ? (
          piece.text
        ) : (
          <span key={i} class="s-ref" title={piece.raw}>
            <Icon name={piece.dir ? 'folder-simple' : 'file-text'} size={14} />
            {piece.dir ? `${piece.name}/` : piece.name}
          </span>
        ),
      )}
    </>
  )
}

/**
 * A picture tries to paint; if it cannot — deleted, no network, a `.png` that is not one and so is
 * served as a download — it becomes the plain chip. The chip NEVER SAYS WHY: an `<img>` cannot tell a
 * 404 from a 503, so it does not pretend to (criterion 31).
 */
function SentFile({ uploadId, name, image }: { readonly uploadId: string; readonly name: string; readonly image: boolean }) {
  const [broken, setBroken] = useState(false)
  const href = uploadUrl(uploadId, name)
  if (image && !broken) {
    return (
      <a class="s-sent-thumb" href={href} target="_blank" rel="noopener">
        <img src={href} alt={name} loading="lazy" onError={() => setBroken(true)} />
      </a>
    )
  }
  return (
    <a class="s-sent-file" href={href} target="_blank" rel="noopener" download={name}>
      <Icon name="file-text" size={16} />
      <span>{name}</span>
    </a>
  )
}

/** How often a live service row moves its time. */
const ROW_TICK_MS = 1_000

/** How long "Copied" stays before it goes back to "Copy". */
const COPIED_MS = 1_500

/**
 * The agent's message as it wrote it — the Markdown source, which pastes cleanly anywhere. The
 * Clipboard API where there is one (a secure context: the tailnet's HTTPS, or loopback); a hidden
 * textarea and `execCommand` where there is not.
 */
function CopyButton({ text }: { readonly text: string }) {
  const [done, setDone] = useState<'copied' | 'failed' | undefined>(undefined)
  useEffect(() => {
    if (done === undefined) return undefined
    const timer = setTimeout(() => setDone(undefined), COPIED_MS)
    return () => clearTimeout(timer)
  }, [done])
  const copy = async () => {
    try {
      if (navigator.clipboard !== undefined) await navigator.clipboard.writeText(text)
      else copyByHand(text)
      setDone('copied')
    } catch {
      setDone('failed')
    }
  }
  return (
    <button type="button" class="s-msg-act" onClick={() => void copy()}>
      <Icon name={done === 'copied' ? 'check' : 'copy'} size={14} />
      {done === 'copied' ? 'Copied' : done === 'failed' ? 'Could not copy' : 'Copy'}
    </button>
  )
}

function copyByHand(text: string): void {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const ok = document.execCommand('copy')
  area.remove()
  if (!ok) throw new Error('copy refused')
}

/** A turn's history, closed to one quiet line: how it ended and when. */
function ActivityRow({ row }: { readonly row: Activity }) {
  const [open, setOpen] = useState(false)
  const when = clock(row.at)
  return (
    <li class={`s-activity s-activity-${row.tone}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'caret-down' : 'caret-right'} size={12} />
        {row.summary}
        {when === '' ? '' : ` · ${when}`}
      </button>
      {open ? (
        <ol>
          {row.entries.map((entry, i) => (
            <li key={i}>
              <span class="num">{clock(entry.at)}</span>
              {entry.label}
              {entry.reason === undefined ? '' : `: ${entry.reason}`}
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  )
}

function CallRow({ call, running, asking = false }: { readonly call: Call; readonly running: boolean; readonly asking?: boolean }) {
  const failed = call.result?.ok === false
  const waiting = call.result === undefined && running
  const onOwner = waiting && asking
  const glyph: SessionIcon = failed ? 'x-circle' : onOwner ? 'hand' : waiting ? 'circle-notch' : (GLYPHS[call.name] ?? 'stack')
  const state = failed ? ' s-fail' : onOwner ? ' s-asked' : waiting ? ' s-pend' : call.result?.ok === true ? ' s-ok' : ''
  return (
    <li class={`s-row${state}`}>
      <span class="s-gut">
        <Icon name={glyph} size={16} />
      </span>
      <div class="s-tool">
        {/* A gate decision about a subagent's tool says whose it was (spec 2026-10-01-subagentes, criterion 34). */}
        <span class="s-name">{call.by === undefined ? call.name : `${call.by} › ${call.name}`}</span>
        <span class="s-arg mono">{toolArg(call.input)}</span>
        {onOwner ? <span class="s-res">waiting for you</span> : null}
        {call.result === undefined || call.result.summary === '' ? null : <span class="s-res">{call.result.summary}</span>}
      </div>
    </li>
  )
}

function FoldRow({ calls, names, running }: { readonly calls: readonly Call[]; readonly names: readonly string[]; readonly running: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <li class="s-folded">
      <button type="button" class="s-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class="s-gut">
          <Icon name="stack" size={16} />
        </span>
        <span>
          <span class="s-count num">{calls.length} tool calls</span> · {names.join(', ')}
        </span>
        <span class="s-fold-end">
          all ok
          <Icon name={open ? 'caret-down' : 'caret-right'} size={14} />
        </span>
      </button>
      {open ? (
        <ol class="s-log">
          {calls.map((call) => (
            <CallRow key={call.seq} call={call} running={running} />
          ))}
        </ol>
      ) : null}
    </li>
  )
}
