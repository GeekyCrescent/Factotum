import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Logger, ReceivedFile, Timers } from '@factotum/core'
import { ProviderError, type GroqOptions, type Provider } from './groq.ts'
import { createDictation, type DictationDeps, type DictationState } from './service.ts'
import { NOT_CONFIGURED } from './shape.ts'

const KEY = 'gsk_CENTINELA_KEY'
const TERM = 'CENTINELA_TERM'
const SPOKEN = 'CENTINELA_TEXT'

const timers: Timers = {
  setInterval: () => ({ [Symbol.dispose]: () => undefined }),
  setTimeout: () => ({ [Symbol.dispose]: () => undefined }),
}

function capturingLog() {
  const lines: string[] = []
  const log: Logger = {
    info: (m) => void lines.push(`info ${m}`),
    warn: (m) => void lines.push(`warn ${m}`),
    error: (m) => void lines.push(`error ${m}`),
  }
  return { log, lines }
}

const FILE: ReceivedFile = { path: '/state/.incoming/abc.part', bytes: 4 }
const AUDIO = new Uint8Array([1, 2, 3, 4])

function deps(over: Partial<DictationDeps> = {}): DictationDeps & { lines: string[]; given: GroqOptions[]; calls: { type: string; prompt: string }[] } {
  const { log, lines } = capturingLog()
  const given: GroqOptions[] = []
  const calls: { type: string; prompt: string }[] = []
  const provider = (options: GroqOptions): Provider => {
    given.push(options)
    return {
      transcribe: async (_audio, type, prompt) => {
        calls.push({ type, prompt })
        return `  ${SPOKEN} hola  `
      },
    }
  }
  return {
    raw: { apiKeyFile: '/keys/groq' },
    log,
    timers,
    readKey: async () => `${KEY}\n`,
    readAudio: async () => AUDIO,
    provider,
    ...over,
    lines,
    given,
    calls,
  }
}

function on(state: DictationState) {
  assert.equal(state.kind, 'on')
  if (state.kind !== 'on') throw new Error('unreachable')
  return state
}

test('no block: off with NOT_CONFIGURED, and no warning — that is how a fresh clone looks (criterion 5)', async () => {
  const d = deps({ raw: undefined })
  assert.deepEqual(await createDictation(d), { kind: 'off', reason: NOT_CONFIGURED })
  assert.deepEqual(d.lines, [])
})

test('a broken block: off with its reason, ONE warning (criterion 4)', async () => {
  const d = deps({ raw: { apiKeyFile: 42 } })
  const state = await createDictation(d)
  assert.equal(state.kind, 'off')
  if (state.kind === 'off') assert.match(state.reason, /apiKeyFile/)
  assert.equal(d.lines.filter((l) => l.startsWith('warn')).length, 1)
})

test('a key that cannot be read or is empty: off, naming the FILE and never what is in it (criterion 5)', async () => {
  const cases: NonNullable<DictationDeps['readKey']>[] = [
    async () => {
      throw Object.assign(new Error(`ENOENT ${KEY}`), { code: 'ENOENT' })
    },
    async () => '  \n',
  ]
  for (const readKey of cases) {
    const d = deps({ readKey })
    const state = await createDictation(d)
    assert.equal(state.kind, 'off')
    if (state.kind === 'off') {
      assert.match(state.reason, /\/keys\/groq/)
      assert.doesNotMatch(state.reason, /CENTINELA/)
    }
    assert.equal(d.lines.length, 1)
    assert.doesNotMatch(d.lines.join('\n'), /CENTINELA/)
  }
})

test('createDictation NEVER throws — it runs inside start(), and a throw there disables sessions', async () => {
  const exploding = deps({
    readKey: () => {
      throw new Error('synchronous blow-up')
    },
  })
  assert.equal((await createDictation(exploding)).kind, 'off')
  const badProvider = deps({
    provider: () => {
      throw new Error('constructor blow-up')
    },
  })
  assert.equal((await createDictation(badProvider)).kind, 'off')
})

test('on: the provider gets the key trimmed, the model, the language and the kernel\'s timers', async () => {
  const d = deps({ raw: { apiKeyFile: '/keys/groq', language: 'es', model: 'm' } })
  on(await createDictation(d))
  assert.equal(d.given.length, 1)
  assert.equal(d.given[0]!.apiKey, KEY)
  assert.equal(d.given[0]!.model, 'm')
  assert.equal(d.given[0]!.language, 'es')
  assert.equal(d.given[0]!.timers, timers)
})

test('the key is read ONCE, at start, however many dictations follow (criterion 6)', async () => {
  let reads = 0
  const d = deps({
    readKey: async () => {
      reads += 1
      return KEY
    },
  })
  const state = on(await createDictation(d))
  for (let i = 0; i < 3; i += 1) await state.transcribe(FILE, 'audio/webm')
  assert.equal(reads, 1)
})

test('transcribe: the type without its parameters, the prompt, and the text normalised', async () => {
  const d = deps({ raw: { apiKeyFile: '/keys/groq', vocabulary: ['Muguerza', 'Médica Sur'] } })
  const state = on(await createDictation(d))
  assert.deepEqual(await state.transcribe(FILE, 'audio/webm;codecs=opus'), { kind: 'ok', text: `${SPOKEN} hola` })
  assert.deepEqual(d.calls, [{ type: 'audio/webm', prompt: 'Muguerza, Médica Sur' }])
})

test('a bad type is refused WITHOUT calling the provider (criterion 9)', async () => {
  const d = deps()
  const state = on(await createDictation(d))
  for (const type of [undefined, '', 'audio/aac']) {
    const result = await state.transcribe(FILE, type)
    assert.equal(result.kind, 'invalid')
  }
  assert.equal(d.calls.length, 0)
})

test('the provider failing comes back as its failure, not as a throw', async () => {
  const d = deps({
    provider: () => ({
      transcribe: async () => {
        throw new ProviderError('quota', "the transcription provider's quota is used up")
      },
    }),
  })
  const state = on(await createDictation(d))
  assert.deepEqual(await state.transcribe(FILE, 'audio/webm'), {
    kind: 'provider',
    failure: 'quota',
    message: "the transcription provider's quota is used up",
  })
})

test('the host failing to read the audio THROWS: it is the host, not the provider (D6)', async () => {
  const d = deps({
    readAudio: async () => {
      throw new Error('EACCES')
    },
  })
  const state = on(await createDictation(d))
  await assert.rejects(state.transcribe(FILE, 'audio/webm'))
})

test('vocabulary that does not fit: ONE warning with how many went, and none of the terms (criterion 15)', async () => {
  const vocabulary = Array.from({ length: 30 }, (_, i) => `${TERM}${String(i).padStart(2, '0')}${'x'.repeat(40)}`)
  const d = deps({ raw: { apiKeyFile: '/keys/groq', vocabulary } })
  on(await createDictation(d))
  const warnings = d.lines.filter((l) => l.startsWith('warn'))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /\d+ of 30/)
  assert.doesNotMatch(warnings[0]!, /CENTINELA/)
})

test('one log line per dictation, with bytes, outcome and time — and none of the content (criteria 18, 34)', async () => {
  const d = deps({ raw: { apiKeyFile: '/keys/groq', vocabulary: [TERM] } })
  const state = on(await createDictation(d))
  await state.transcribe(FILE, 'audio/webm')
  await state.transcribe(FILE, 'audio/aac')
  const requests = d.lines.filter((l) => l.includes('dictation:'))
  assert.equal(requests.length, 2)
  assert.match(requests[0]!, /4 bytes → ok in \d+ ms/)
  assert.match(requests[1]!, /4 bytes → invalid in \d+ ms/)
  assert.doesNotMatch(d.lines.join('\n'), /CENTINELA/)
})
