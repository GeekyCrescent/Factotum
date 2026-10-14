/**
 * «Run agent» (design D9; criteria 30, 30b, 31, 31b): a sheet that launches a session of the sessions
 * module on the card's project, with the card as its prompt.
 *
 * ON THE CARD'S HOST, whichever app shows the board: the project's stored host goes through
 * `toClientHost` (criterion 30b). With THE FREE-PROMPT ENTRY of that host's catalog, never a command
 * nor a subagent; if the host has none, or is an older build that does not say `kind`, the button is
 * off and the sheet says so (criterion 30).
 *
 * ON SUCCESS, in this order: the session is linked and the card moves to In progress in one write,
 * then the app opens the session (criterion 31). On `busy`, `stale` or a rejection the card does not
 * change. A launch on another host that came back unanswered MAY have started: the sheet says so and
 * suggests «Link a session»; nothing is retried by itself (criterion 31b).
 */

import { useEffect, useState } from 'preact/hooks'
import type { Task } from '../types.ts'
import { agentPrompt, freePromptEntry, launchProblem, projectState, type LaunchProblem, type SetupView } from './agent-model.ts'
import type { Edge } from './edge.ts'
import { Icon } from './icon.tsx'
import { messageOf } from './model.ts'
import { Sheet } from './sheet.tsx'
import { toClientHost, toStoredHost } from './where.ts'

type Loaded = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly setup: SetupView } | { readonly kind: 'failed'; readonly message: string }

export function RunAgentSheet({
  task,
  edge,
  act,
  onClose,
}: {
  readonly task: Task
  readonly edge: Edge
  readonly act: (path: string, body?: unknown) => Promise<boolean>
  readonly onClose: () => void
}) {
  const project = task.project
  const where = edge.where
  const host = project === null || where === undefined ? undefined : toClientHost(project.host, where)
  const sessions = edge.peerModule('sessions', host)
  const known = host === undefined || edge.hosts.some((h) => h.name === host)
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' })
  const [prompt, setPrompt] = useState(() => agentPrompt(task))
  const [launching, setLaunching] = useState(false)
  const [problem, setProblem] = useState<LaunchProblem | undefined>(undefined)

  useEffect(() => {
    if (sessions === undefined || !known) return
    let alive = true
    sessions
      .get<SetupView>('setup')
      .then((setup) => alive && setLoaded({ kind: 'ready', setup }))
      .catch((cause: unknown) => alive && setLoaded({ kind: 'failed', message: messageOf(cause) }))
    return () => {
      alive = false
    }
  }, [sessions, known])

  const hostLabel = host ?? where?.selfName ?? 'this host'
  const blocked = ((): string | undefined => {
    if (project === null) return 'This card has no project.'
    if (where === undefined) return 'Waiting for the list of hosts…'
    if (sessions === undefined) return 'The sessions module is not running on this Factotum.'
    if (!known) return `${hostLabel} is not one of this app's hosts.`
    if (loaded.kind === 'loading') return 'Reading the projects of that host…'
    if (loaded.kind === 'failed') return `${hostLabel} did not answer: ${loaded.message}`
    const state = projectState(loaded.setup, project.siteId)
    if (state === 'unknown') return `${project.siteId} is not a project on ${hostLabel}.`
    if (state === 'missing') return `${project.siteId} is missing on ${hostLabel}: its folder is not there.`
    if (freePromptEntry(loaded.setup.catalog) === undefined) return 'This host has no free-prompt entry.'
    return undefined
  })()

  const launch = async (force: boolean): Promise<void> => {
    if (project === null || where === undefined || sessions === undefined || loaded.kind !== 'ready') return
    const entryId = freePromptEntry(loaded.setup.catalog)
    if (entryId === undefined || prompt.trim() === '') return
    setLaunching(true)
    setProblem(undefined)
    try {
      const { sessionId } = await sessions.post<{ sessionId: string }>('sessions', { siteId: project.siteId, entryId, text: prompt.trim(), force })
      // Linked and In progress in ONE write, then the session (criterion 31).
      await act(`tasks/${encodeURIComponent(task.id)}/sessions`, { host: toStoredHost(host, where), sessionId })
      edge.openModule('sessions', encodeURIComponent(sessionId), { host: host ?? null })
    } catch (cause) {
      setProblem(launchProblem(cause, host))
    }
    setLaunching(false)
  }

  const foot = (
    <button type="button" class="btn primary" disabled={blocked !== undefined || launching || prompt.trim() === ''} onClick={() => void launch(false)}>
      <Icon name="terminal-window" size={18} />
      {launching ? 'Launching…' : 'Run agent'}
    </button>
  )

  return (
    <Sheet id="t-run-title" title="Run agent" onClose={onClose} foot={foot}>
      <div class="t-run">
        {project === null ? null : (
          <p class="t-run-where dim-2">
            {project.siteId} on {hostLabel}
          </p>
        )}
        {blocked === undefined ? null : <p class="t-run-blocked">{blocked}</p>}
        <label class="t-run-prompt">
          <span>Prompt</span>
          <textarea rows={7} value={prompt} maxLength={20_000} onInput={(event) => setPrompt((event.target as HTMLTextAreaElement).value)} />
        </label>
        {problem === undefined ? null : <Problem problem={problem} hostLabel={hostLabel} edge={edge} host={host} relaunch={() => void launch(true)} />}
      </div>
    </Sheet>
  )
}

function Problem({
  problem,
  hostLabel,
  edge,
  host,
  relaunch,
}: {
  readonly problem: LaunchProblem
  readonly hostLabel: string
  readonly edge: Edge
  readonly host: string | undefined
  readonly relaunch: () => void
}) {
  if (problem.kind === 'busy') {
    return (
      <div class="notice ask" role="alert">
        <div class="head">That project is busy</div>
        <p>Another session is running there. The card did not change.</p>
        <div class="acts">
          <button type="button" class="btn sm" onClick={() => edge.openModule('sessions', encodeURIComponent(problem.sessionId), { host: host ?? null })}>
            Open it
          </button>
        </div>
      </div>
    )
  }
  if (problem.kind === 'stale') {
    return (
      <div class="notice ask" role="alert">
        <div class="head">The project is not up to date</div>
        <p>{problem.detail}</p>
        <div class="acts">
          <button type="button" class="btn sm" onClick={relaunch}>
            Run anyway
          </button>
        </div>
      </div>
    )
  }
  if (problem.kind === 'unanswered') {
    return (
      <div class="notice ask" role="alert">
        <div class="head">No answer from {hostLabel}</div>
        <p>It may have started on {hostLabel} — check its history, then use Link a session. The card did not change.</p>
      </div>
    )
  }
  return (
    <div class="notice err" role="alert">
      <div class="head">It did not start</div>
      <p>{problem.message}</p>
    </div>
  )
}
