import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Timers } from '@factotum/core'
import { createGroqProvider, ProviderError } from './groq.ts'

const KEY = 'gsk_CENTINELA_KEY'
const SPOKEN = 'CENTINELA_TEXT dictated words'

/** Timers that only fire when the test says so, and remember whether they were let go. */
function manualTimers() {
  const pending: { fn: () => void; disposed: boolean }[] = []
  const timers: Timers = {
    setInterval: () => ({ [Symbol.dispose]: () => undefined }),
    setTimeout: (fn) => {
      const entry = { fn, disposed: false }
      pending.push(entry)
      return { [Symbol.dispose]: () => void (entry.disposed = true) }
    },
  }
  return { timers, fireAll: () => pending.filter((p) => !p.disposed).forEach((p) => p.fn()), pending }
}

interface Seen {
  url: string
  init: RequestInit
}

function fetchAnswering(status: number, body: unknown, seen: Seen[] = []): typeof globalThis.fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
}

function provider(fetch: typeof globalThis.fetch, extra: { language?: string; timers?: Timers } = {}) {
  return createGroqProvider({
    apiKey: KEY,
    model: 'whisper-large-v3-turbo',
    language: extra.language,
    timers: extra.timers ?? manualTimers().timers,
    timeoutMs: 20_000,
    fetch,
  })
}

const AUDIO = new Uint8Array([1, 2, 3, 4])

async function failureOf(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof ProviderError, String(error))
    return error
  }
  assert.fail('it should have thrown')
}

test('the request: endpoint, key, a file NAMED by its container, the model, temperature 0', async () => {
  const seen: Seen[] = []
  const text = await provider(fetchAnswering(200, { text: ' hola ' }, seen)).transcribe(AUDIO, 'audio/webm', '')
  assert.equal(text, ' hola ')
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.url, 'https://api.groq.com/openai/v1/audio/transcriptions')
  assert.equal(seen[0]!.init.method, 'POST')
  assert.equal((seen[0]!.init.headers as Record<string, string>)['authorization'], `Bearer ${KEY}`)
  const form = seen[0]!.init.body as FormData
  const file = form.get('file') as File
  assert.equal(file.name, 'dictation.webm')
  assert.equal(file.size, AUDIO.byteLength)
  assert.equal(form.get('model'), 'whisper-large-v3-turbo')
  assert.equal(form.get('temperature'), '0')
  assert.equal(form.get('response_format'), 'json')
  // Absent unless configured, and no prompt when there are no terms (guardrail 10).
  assert.equal(form.get('language'), null)
  assert.equal(form.get('prompt'), null)
})

test('the m4a container travels as .m4a, the language and the prompt when there are some', async () => {
  const seen: Seen[] = []
  await provider(fetchAnswering(200, { text: 'x' }, seen), { language: 'es' }).transcribe(AUDIO, 'audio/mp4', 'Muguerza, Médica Sur')
  const form = seen[0]!.init.body as FormData
  assert.equal((form.get('file') as File).name, 'dictation.m4a')
  assert.equal(form.get('language'), 'es')
  assert.equal(form.get('prompt'), 'Muguerza, Médica Sur')
})

test('a type outside the list is refused without a request', async () => {
  const seen: Seen[] = []
  const error = await failureOf(provider(fetchAnswering(200, { text: 'x' }, seen)).transcribe(AUDIO, 'audio/aac', ''))
  assert.equal(error.code, 'failed')
  assert.equal(seen.length, 0)
})

test('the provider, translated: a bad key is not a broken microphone (criterion 12)', async () => {
  const cases: readonly [number, string][] = [
    [401, 'credential'],
    [403, 'credential'],
    [429, 'quota'],
    [400, 'failed'],
    [500, 'failed'],
    [503, 'failed'],
  ]
  for (const [status, code] of cases) {
    const error = await failureOf(provider(fetchAnswering(status, { error: { message: `echo ${KEY} ${SPOKEN}` } })).transcribe(AUDIO, 'audio/webm', ''))
    assert.equal(error.code, code, `${status}`)
    assert.match(error.message, /provider/)
  }
})

test('a network failure and an answer without text are the provider failing', async () => {
  const down = (async () => {
    throw new TypeError(`fetch failed for https://api.groq.com/?key=${KEY}`)
  }) as typeof globalThis.fetch
  const network = await failureOf(provider(down).transcribe(AUDIO, 'audio/webm', ''))
  assert.equal(network.code, 'failed')
  assert.match(network.message, /could not reach the transcription provider/)

  const odd = await failureOf(provider(fetchAnswering(200, { words: SPOKEN })).transcribe(AUDIO, 'audio/webm', ''))
  assert.equal(odd.code, 'failed')
  assert.match(odd.message, /unexpected/)

  const notJson = await failureOf(provider(fetchAnswering(200, '<html>')).transcribe(AUDIO, 'audio/webm', ''))
  assert.equal(notJson.code, 'failed')
})

test('a provider that never answers is cut by the KERNEL\'s clock, and says so (criterion 13)', async () => {
  const clock = manualTimers()
  const hanging = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })) as typeof globalThis.fetch
  const pending = provider(hanging, { timers: clock.timers }).transcribe(AUDIO, 'audio/webm', '')
  clock.fireAll()
  const error = await failureOf(pending)
  assert.equal(error.code, 'failed')
  assert.match(error.message, /took too long/)
})

test('the timer is let go when the answer arrives', async () => {
  const clock = manualTimers()
  await provider(fetchAnswering(200, { text: 'x' }), { timers: clock.timers }).transcribe(AUDIO, 'audio/webm', '')
  assert.equal(clock.pending.length, 1)
  assert.equal(clock.pending[0]!.disposed, true)
})

test('no message carries the key, nor anything the provider sent back (criterion 18)', async () => {
  const errors: ProviderError[] = []
  for (const status of [401, 429, 500]) {
    errors.push(await failureOf(provider(fetchAnswering(status, { error: { message: `${KEY} ${SPOKEN}` } })).transcribe(AUDIO, 'audio/webm', '')))
  }
  for (const error of errors) {
    assert.doesNotMatch(error.message, /CENTINELA/)
    assert.doesNotMatch(String(error.stack), /CENTINELA/)
  }
})
