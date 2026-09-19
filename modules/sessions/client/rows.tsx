/**
 * The session's log: messages, tool calls with their results, and long runs of reading folded into
 * one row that opens on a tap (criteria 16, 17). `fold.ts` decides; this only paints.
 *
 * A FAILURE gets its own line for the message, so the tool's name and argument are never cut to
 * make room for the error (criterion 17).
 */

import { useState } from 'preact/hooks'
import type { SessionEvent } from '../types.ts'
import { fold, type Call, type Row } from './fold.ts'
import { stateLabel, toolArg } from './format.ts'
import { Icon } from './icon.tsx'
import type { SessionIcon } from './icons.ts'

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

export function Log({ events, running }: { readonly events: readonly SessionEvent[]; readonly running: boolean }) {
  return (
    <ol class="s-log">
      {fold(events).map((row, index) =>
        // A session starts running: saying so first is noise. Running again later is a resume.
        row.kind === 'state' && row.state === 'running' && index === 0 ? null : (
          <LogRow key={row.seq} row={row} running={running} />
        ),
      )}
    </ol>
  )
}

function LogRow({ row, running }: { readonly row: Row; readonly running: boolean }) {
  switch (row.kind) {
    case 'message':
      return (
        <li class={row.role === 'user' ? 's-row s-user' : 's-row'}>
          <span class="s-gut" />
          <div class="s-msg">{row.text}</div>
        </li>
      )
    case 'call':
      return <CallRow call={row} running={running} />
    case 'fold':
      return <FoldRow calls={row.calls} names={row.names} running={running} />
    case 'state':
      return (
        <li class="s-end">
          <span>
            {row.state === 'running' ? 'Resumed' : stateLabel(row.state)}
            {row.reason === undefined ? '' : `: ${row.reason}`}
          </span>
        </li>
      )
  }
}

function CallRow({ call, running }: { readonly call: Call; readonly running: boolean }) {
  const failed = call.result?.ok === false
  const waiting = call.result === undefined && running
  const glyph: SessionIcon = failed ? 'x-circle' : waiting ? 'circle-notch' : (GLYPHS[call.name] ?? 'stack')
  const state = failed ? ' s-fail' : waiting ? ' s-pend' : ''
  return (
    <li class={`s-row${state}`}>
      <span class="s-gut">
        <Icon name={glyph} size={16} />
      </span>
      <div class="s-tool">
        <span class="s-name">{call.name}</span>
        <span class="s-arg mono">{toolArg(call.input)}</span>
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
          <Icon name="check-circle" size={16} />
        </span>
        <span>
          <span class="s-count num">{calls.length} reads</span> <span class="dim-3">{names.join(', ')}</span>
        </span>
        <Icon name={open ? 'caret-down' : 'caret-right'} size={14} />
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
