/**
 * Dictating into the composer (spec 2026-10-03-dictado-por-voz, D10): one tap records, another stops, and
 * the text lands at the END of the box without being sent.
 *
 * THE AUDIOCONTEXT IS BORN IN THE TAP, before any `await`. A context created after the permission dialog
 * can start `suspended`; the meter would then read flat and a real dictation would be thrown away as
 * silence. Measured on the owner's phone (A3): created in the gesture, it stays `running`.
 *
 * SILENCE IS STOPPED HERE, not on the host: over silence the provider invents a sentence ("Thank you.",
 * measured three times) and gives no sign it did. When the meter cannot be trusted, the recording is sent
 * anyway — the text never sends itself.
 *
 * The box is never touched on failure, and the microphone is let go on stop, on failure and on unmount.
 * A locked screen is out of scope (owner's decision): Android cuts the microphone there.
 */

import type { RefObject } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { Api } from './contract.ts'
import {
  afterRecording,
  appendDictation,
  BITRATE,
  CLIENT_WAIT_MS,
  dictationDetailOf,
  dictationErrorText,
  dictationOf,
  dictationProblemOf,
  formatClock,
  microphoneProblemOf,
  pickType,
  VOICE_SAMPLE_MS,
  VOICE_THRESHOLD,
  type DictationAvailability,
  type DictationProblem,
} from './dictation.ts'
import { Icon } from './icon.tsx'

export type DictationState = 'idle' | 'starting' | 'recording' | 'transcribing'

export interface DictationControls {
  readonly state: DictationState
  readonly seconds: number
  readonly notice: string | undefined
  /** Recording or transcribing: Send waits (criterion 29). */
  readonly busy: boolean
  readonly toggle: () => void
  /** Clears the notice; the composer calls it when a message went through. */
  readonly clear: () => void
}

interface Recording {
  readonly stream: MediaStream
  readonly recorder: MediaRecorder
  readonly context: AudioContext | undefined
  readonly chunks: Blob[]
  readonly type: string
  readonly startedAt: number
  readonly maxSeconds: number
  readonly maxBytes: number
  heardVoice: boolean
  meterReliable: boolean
  timers: number[]
}

const WAITED = Symbol('waited')

function newAudioContext(): AudioContext | undefined {
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (Context === undefined) return undefined
  try {
    const context = new Context()
    void context.resume().catch(() => undefined)
    return context
  } catch {
    return undefined
  }
}

function letGo(stream: MediaStream | undefined, context: AudioContext | undefined): void {
  for (const track of stream?.getTracks() ?? []) track.stop()
  if (context !== undefined && context.state !== 'closed') void context.close().catch(() => undefined)
}

async function askAvailability(api: Api): Promise<DictationAvailability> {
  try {
    return dictationOf({ reply: await api.get<unknown>('dictation') })
  } catch (error) {
    return dictationOf({ error })
  }
}

export function useDictation(args: {
  readonly api: Api
  /** Reads the text AS IT IS NOW, not as it was when the recording started (criterion 24). */
  readonly append: (transcript: string) => void
  readonly focus: () => void
}): DictationControls {
  const [state, setState] = useState<DictationState>('idle')
  const [seconds, setSeconds] = useState(0)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const latest = useRef(args)
  latest.current = args
  const availability = useRef<DictationAvailability | undefined>(undefined)
  const recording = useRef<Recording | undefined>(undefined)
  const unmounted = useRef(false)
  // Each transcription gets a number; an answer for an older one is ignored.
  const attempt = useRef(0)

  useEffect(() => {
    unmounted.current = false
    void askAvailability(args.api).then((found) => {
      // A tap may have asked again in the meantime; keep what it found if it is better.
      if (availability.current?.kind !== 'on') availability.current = found
    })
    return () => {
      // Changing conversation remounts the screen: let the microphone go and send nothing (criterion 30).
      unmounted.current = true
      attempt.current += 1
      const current = recording.current
      recording.current = undefined
      if (current === undefined) return
      for (const id of current.timers) window.clearInterval(id)
      if (current.recorder.state !== 'inactive') current.recorder.stop()
      letGo(current.stream, current.context)
    }
  }, [args.api])

  const fail = (problem: DictationProblem, detail?: string) => {
    if (unmounted.current) return
    setNotice(dictationErrorText(problem, detail))
    setState('idle')
  }

  const stop = () => {
    const current = recording.current
    if (current !== undefined && current.recorder.state === 'recording') current.recorder.stop()
  }

  const transcribe = async (blob: Blob, type: string) => {
    attempt.current += 1
    const mine = attempt.current
    setState('transcribing')
    let timer: number | undefined
    const waited = new Promise<typeof WAITED>((resolve) => {
      timer = window.setTimeout(() => resolve(WAITED), CLIENT_WAIT_MS)
    })
    try {
      const reply = await Promise.race([latest.current.api.upload<{ text?: unknown }>('dictation', blob, { type }), waited])
      if (mine !== attempt.current || unmounted.current) return
      if (reply === WAITED) return fail('timeout')
      const text = typeof reply.text === 'string' ? reply.text : ''
      latest.current.append(text)
      latest.current.focus()
      setState('idle')
    } catch (error) {
      if (mine !== attempt.current || unmounted.current) return
      fail(dictationProblemOf(error), dictationDetailOf(error))
    } finally {
      window.clearTimeout(timer)
    }
  }

  const finish = (current: Recording) => {
    for (const id of current.timers) window.clearInterval(id)
    letGo(current.stream, current.context)
    if (recording.current === current) recording.current = undefined
    if (unmounted.current) return
    const blob = new Blob(current.chunks, { type: current.type })
    const decision = afterRecording({
      durationMs: Date.now() - current.startedAt,
      heardVoice: current.heardVoice,
      meterReliable: current.meterReliable,
      bytes: blob.size,
      maxBytes: current.maxBytes,
    })
    if (decision === 'discard') return setState('idle')
    if (decision !== 'upload') return fail(decision)
    void transcribe(blob, current.type)
  }

  const begin = async (context: AudioContext | undefined) => {
    let found = availability.current
    if (found?.kind !== 'on') {
      // Asked again on this same tap: a restart must not leave the box saying "update" (criterion 19).
      found = await askAvailability(latest.current.api)
      availability.current = found
    }
    if (found.kind !== 'on') {
      letGo(undefined, context)
      return found.kind === 'off' ? fail('off', found.reason) : fail(found.kind)
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (error) {
      letGo(undefined, context)
      return fail(microphoneProblemOf(error))
    }
    if (unmounted.current) return letGo(stream, context)

    const mimeType = typeof MediaRecorder === 'undefined' ? undefined : pickType((type) => MediaRecorder.isTypeSupported(type))
    let recorder: MediaRecorder
    try {
      if (mimeType === undefined) throw new Error('unsupported')
      recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: BITRATE })
    } catch {
      letGo(stream, context)
      return fail('unsupported')
    }

    let analyser: AnalyserNode | undefined
    if (context !== undefined) {
      try {
        analyser = context.createAnalyser()
        analyser.fftSize = 1024
        context.createMediaStreamSource(stream).connect(analyser)
      } catch {
        analyser = undefined
      }
    }

    const current: Recording = {
      stream,
      recorder,
      context,
      chunks: [],
      type: recorder.mimeType || mimeType,
      startedAt: Date.now(),
      maxSeconds: found.maxSeconds,
      maxBytes: found.maxBytes,
      heardVoice: false,
      // Without a working meter nothing is known about silence, so nothing is thrown away (criterion 36).
      meterReliable: analyser !== undefined,
      timers: [],
    }
    recording.current = current

    if (analyser !== undefined && context !== undefined) {
      const samples = new Uint8Array(analyser.fftSize)
      const meter = analyser
      current.timers.push(
        window.setInterval(() => {
          if (context.state !== 'running') {
            current.meterReliable = false
            return
          }
          if (current.heardVoice) return
          meter.getByteTimeDomainData(samples)
          for (const value of samples) {
            if (Math.abs(value - 128) / 128 >= VOICE_THRESHOLD) {
              current.heardVoice = true
              break
            }
          }
        }, VOICE_SAMPLE_MS),
      )
    }
    current.timers.push(
      window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - current.startedAt) / 1000)
        setSeconds(elapsed)
        if (elapsed >= current.maxSeconds) stop()
      }, 1_000),
    )

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) current.chunks.push(event.data)
    }
    recorder.onstop = () => finish(current)
    recorder.start()
    setSeconds(0)
    setState('recording')
  }

  const toggle = () => {
    if (state === 'recording') return stop()
    if (state !== 'idle') return
    setNotice(undefined)
    if (navigator.mediaDevices?.getUserMedia === undefined) return fail('no-microphone')
    // In the tap, before anything awaits (riesgo 13).
    const context = newAudioContext()
    setState('starting')
    void begin(context).catch(() => {
      letGo(recording.current?.stream, context)
      recording.current = undefined
      fail('no-microphone')
    })
  }

  return { state, seconds, notice, busy: state !== 'idle', toggle, clear: () => setNotice(undefined) }
}

/**
 * Dictation for one composer: the transcript goes after the text AS IT IS WHEN IT ARRIVES — what was typed
 * while transcribing stays in front — and the caret goes to the end (criterion 24).
 */
export function useComposerDictation(
  api: Api,
  text: string,
  setText: (text: string) => void,
  textarea: RefObject<HTMLTextAreaElement>,
): DictationControls {
  const current = useRef(text)
  current.current = text
  return useDictation({
    api,
    append: (transcript) => setText(appendDictation(current.current, transcript)),
    // After Preact has painted the new text, or the caret lands before it.
    focus: () =>
      queueMicrotask(() => {
        const box = textarea.current
        if (box === null) return
        box.focus()
        box.setSelectionRange(box.value.length, box.value.length)
      }),
  })
}

const LABELS: Readonly<Record<DictationState, string>> = {
  idle: 'Dictate',
  starting: 'Starting the microphone…',
  recording: 'Stop dictating',
  transcribing: 'Transcribing…',
}

/** Beside `+`. Not disabled when the host has no dictation: a tap says why, as `+` does (criterion 27). */
export function DictateButton({ dictation }: { readonly dictation: DictationControls }) {
  const { state } = dictation
  const label = LABELS[state]
  return (
    <button
      type="button"
      class={`s-mic s-mic-${state}`}
      aria-label={label}
      title={label}
      aria-pressed={state === 'recording'}
      disabled={state === 'starting' || state === 'transcribing'}
      onClick={dictation.toggle}
    >
      {state === 'recording' ? (
        <>
          <Icon name="stop" size={16} />
          <span class="s-mic-clock" aria-hidden="true">
            {formatClock(dictation.seconds)}
          </span>
        </>
      ) : state === 'idle' ? (
        <Icon name="microphone" size={18} />
      ) : (
        <span class="s-mic-spin">
          <Icon name="circle-notch" size={18} />
        </span>
      )}
    </button>
  )
}

/** The dictation's one sentence, above the box, looking like the attach notice. */
export function DictationNotice({ dictation }: { readonly dictation: DictationControls }) {
  if (dictation.notice === undefined) return null
  return (
    <p class="s-attach-notice s-mic-notice" role="status">
      <Icon name="warning" size={14} />
      {dictation.notice}
    </p>
  )
}
