/**
 * One mockup, by stages — direction B, «Documento» (K2): the document at reading width, the track as
 * five segments above it, and the decision in a margin beside it (on the phone, after the document,
 * reached from a bar at the thumb). Criteria 17, 25, 27, 29, 39.
 *
 * When it opens: the live runs are checked (`runs.ts`) and the work-dir looked up among the sessions
 * projects (`project.ts`), so what happened with the screen closed shows. While a stage runs or a
 * project request waits, it reads the mockup again every few seconds.
 */

import { useCallback, useEffect, useState } from 'preact/hooks'
import { STAGE_IDS, type Mockup, type StageId } from '../types.ts'
import type { ViewProps } from './contract.ts'
import { DocView } from './doc-view.tsx'
import { Gate } from './gate.tsx'
import { Glyph } from './glyph.tsx'
import { Icon } from './icon.tsx'
import { Inputs } from './inputs.tsx'
import { messageOf, noticeOf, redoStage, startStage, type LaunchOutcome, type Notice } from './launch.ts'
import { afterDecision, nowStage, stageActions, statusLine } from './model.ts'
import { pollRequest, reconcileProject, requestProject, type ProjectState } from './project.ts'
import { checkLiveRuns } from './runs.ts'
import { StagePanel } from './stage.tsx'

const LABEL: Readonly<Record<StageId, string>> = { brief: 'Brief', concepts: 'Concepts', plan: 'Plan', build: 'Build', deliver: 'Deliver' }
const REFRESH_MS = 5_000

type Loaded = { readonly kind: 'loading' } | { readonly kind: 'ok'; readonly mockup: Mockup } | { readonly kind: 'failed'; readonly message: string }

export function Pipeline({ props, id, open }: { readonly props: ViewProps; readonly id: string; readonly open: StageId | undefined }) {
  const { api, host } = props
  const sessions = props.peerModule('sessions', host)
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | undefined>(undefined)
  const [project, setProject] = useState<ProjectState | undefined>(undefined)
  const [moved, setMoved] = useState<StageId | undefined>(undefined)
  const path = `mockups/${encodeURIComponent(id)}`

  const reload = useCallback(async (): Promise<Mockup | undefined> => {
    try {
      const mockup = await api.get<Mockup>(path)
      setLoaded({ kind: 'ok', mockup })
      return mockup
    } catch (cause) {
      setLoaded({ kind: 'failed', message: messageOf(cause) })
      return undefined
    }
  }, [api, path])

  // On open: read, check the live runs, look the work-dir up (D5, D7).
  useEffect(() => {
    let alive = true
    void (async () => {
      const mockup = await reload()
      if (mockup === undefined || !alive) return
      if ((await checkLiveRuns({ mockups: api, sessions }, mockup)) > 0 && alive) await reload()
      if (mockup.buildSiteId === null && mockup.buildRefused === undefined) {
        const state = await reconcileProject({ mockups: api, sessions }, mockup)
        if (!alive) return
        setProject(state)
        if (state.kind === 'found') await reload()
      }
    })()
    return () => {
      alive = false
    }
  }, [api, sessions, reload])

  const mockup = loaded.kind === 'ok' ? loaded.mockup : undefined
  const running = mockup !== undefined && STAGE_IDS.some((s) => mockup.stages[s].status === 'running')
  const waitingRequest = project?.kind === 'waiting' ? project.requestId : undefined

  useEffect(() => {
    if (!running && waitingRequest === undefined) return
    const timer = setInterval(() => {
      void reload()
      if (waitingRequest !== undefined && mockup !== undefined) {
        void pollRequest({ mockups: api, sessions }, mockup, waitingRequest).then((state) => {
          setProject(state)
          if (state.kind === 'found') void reload()
        })
      }
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [running, waitingRequest, reload, api, sessions, mockup])

  if (loaded.kind === 'loading') return <div class="mk-skeleton mk-pad" aria-busy="true" />
  if (loaded.kind === 'failed' || mockup === undefined) return <p class="mk-notice mk-err mk-pad">{loaded.kind === 'failed' ? loaded.message : 'Not found.'}</p>

  const stage = open ?? nowStage(mockup)
  const step = mockup.stages[stage]
  const actions = stageActions(mockup, stage, { sessions: sessions !== undefined, now: new Date() })
  const apis = { mockups: api, sessions, host }

  const run = async (act: () => Promise<LaunchOutcome>): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    const outcome = await act()
    setNotice(noticeOf(outcome))
    await reload()
    setBusy(false)
  }
  // Approve or choose; then, with a 200, the next stage's launch from here (D5; criteria 27, 28).
  const decide = async (decision: { readonly action: 'approve' } | { readonly action: 'choose'; readonly optionId: string }): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    try {
      await api.post(`${path}/decision`, { step: stage, ...decision })
    } catch (cause) {
      setNotice({ text: messageOf(cause) })
      await reload()
      setBusy(false)
      return
    }
    setMoved(stage)
    const next = afterDecision(stage)
    if (next !== undefined) {
      props.navigate(`${mockup.id}/${next}`, { replace: true })
      setNotice(noticeOf(await startStage(apis, mockup.id, next)))
    }
    await reload()
    setBusy(false)
  }
  const abandon = async (): Promise<void> => {
    if (step.run === undefined) return
    setBusy(true)
    await api.post(`runs/${encodeURIComponent(step.run.id)}/abandon`, { reason: 'abandoned by the owner' }).catch((cause: unknown) => setNotice({ text: messageOf(cause) }))
    await reload()
    setBusy(false)
  }
  const retry = async (): Promise<void> => {
    const current = step.run
    if (current === undefined) return
    setBusy(true)
    try {
      await api.post(`runs/${encodeURIComponent(current.id)}/abandon`, { reason: 'retried by the owner' })
    } catch (cause) {
      setNotice({ text: messageOf(cause) })
      setBusy(false)
      return
    }
    // A redo's retry goes through the redo again, with its comment (D6).
    await run(() => (current.redo === undefined ? startStage(apis, mockup.id, stage) : redoStage(apis, mockup.id, stage, current.redo.comment)))
  }
  const openSession = (sessionId: string): void => props.openModule('sessions', encodeURIComponent(sessionId), host === undefined ? {} : { host })

  const margin =
    step.status === 'waiting' ? (
      <Gate
        label={LABEL[stage]}
        step={step}
        actions={actions}
        busy={busy}
        dictationApi={sessions}
        onApprove={() => void decide({ action: 'approve' })}
        onChoose={(optionId) => void decide({ action: 'choose', optionId })}
        onRedo={(comment) => void run(() => redoStage(apis, mockup.id, stage, comment))}
      />
    ) : (
      <StagePanel
        stage={stage}
        label={LABEL[stage]}
        step={step}
        actions={actions}
        busy={busy}
        onStart={() => void run(() => startStage(apis, mockup.id, stage))}
        onRetry={() => void retry()}
        onAbandon={() => void abandon()}
        onOpenSession={openSession}
      />
    )

  return (
    <div class="mk-screen">
      <header class="mk-bar">
        <button type="button" class="btn quiet mk-icon-btn" aria-label="Back to the mockups" onClick={() => props.navigate('')}>
          <Icon name="caret-left" size={18} />
        </button>
        <h2 class="mk-title">{mockup.name}</h2>
        <span class="mk-sub">{mockup.client}</span>
        <span class="mk-grow" />
        {actions.openSession === undefined ? null : (
          <button type="button" class="btn sm quiet" onClick={() => openSession(actions.openSession ?? '')}>
            <Icon name="terminal-window" size={14} /> Open session
          </button>
        )}
      </header>

      <ol class="mk-track" aria-label="Stages">
        {STAGE_IDS.map((id) => (
          <li key={id} class={`mk-st mk-st-${mockup.stages[id].status}${id === stage ? ' mk-open' : ''}${id === moved ? ' mk-moved' : ''}`}>
            <button type="button" class="mk-st-btn" aria-current={id === stage ? 'step' : undefined} onClick={() => props.navigate(`${mockup.id}/${id}`, { replace: true })}>
              <span class="mk-seg" aria-hidden="true" />
              <span class="mk-lab">
                <Glyph status={mockup.stages[id].status} />
                <span class="mk-st-name">{LABEL[id]}</span>
                <span class="mk-st-text">{statusLine(mockup.stages[id])}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>

      {notice === undefined ? null : (
        <p class="mk-notice mk-pad-x">
          <span>{notice.text}</span>
          {notice.sessionId === undefined ? null : (
            <button type="button" class="btn sm" onClick={() => openSession(notice.sessionId ?? '')}>
              <Icon name="terminal-window" size={14} /> Open that session
            </button>
          )}
        </p>
      )}

      <div class="mk-body">
        <div class="mk-page">
          <div class="mk-inner">
            {step.version > 0 ? <DocView api={api} mockupId={mockup.id} stage={stage} version={step.version} /> : <p class="mk-empty">{LABEL[stage]} has no document yet.</p>}
          </div>
        </div>
        <aside class="mk-margin">
          {margin}
          <Inputs api={api} dictationApi={sessions} mockup={mockup} onChanged={(m) => setLoaded({ kind: 'ok', mockup: m })} />
          <BuildProject state={project} mockup={mockup} onRequest={() => void requestProject({ mockups: api, sessions }, mockup).then(setProject)} />
        </aside>
      </div>

      {step.status === 'waiting' ? (
        <div class="mk-thumb">
          <a class="btn primary mk-big" href="#mk-gate">
            Decide
          </a>
        </div>
      ) : null}
    </div>
  )
}

function BuildProject({ state, mockup, onRequest }: { readonly state: ProjectState | undefined; readonly mockup: Mockup; readonly onRequest: () => void }) {
  const line = ((): string => {
    if (mockup.buildSiteId !== null) return `The work folder is the sessions project ${mockup.buildSiteId}.`
    if (mockup.buildRefused !== undefined) return `No build project: ${mockup.buildRefused}. The vault stages go on.`
    switch (state?.kind) {
      case 'waiting':
        return 'Waiting for project approval on your phone.'
      case 'again':
        return `The request did not go through: ${state.reason}.`
      case 'refused':
        return `No build project: ${state.reason}. The vault stages go on.`
      case 'no-sessions':
        return 'sessions is not running on this host.'
      case 'error':
        return `The projects of sessions could not be read: ${state.reason}.`
      default:
        return 'The work folder is not a sessions project yet. The build needs it; the brief does not.'
    }
  })()
  const canAsk = mockup.buildSiteId === null && mockup.buildRefused === undefined && (state?.kind === 'none' || state?.kind === 'again')
  return (
    <section class="mk-project">
      <h3 class="mk-h3">Build project</h3>
      <p class="mk-small">{line}</p>
      {canAsk ? (
        <button type="button" class="btn sm" onClick={onRequest}>
          {state?.kind === 'again' ? 'Request again' : 'Request the project'}
        </button>
      ) : null}
    </section>
  )
}
