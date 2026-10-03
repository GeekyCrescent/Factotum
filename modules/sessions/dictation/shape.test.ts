import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUDIO_TYPES, baseType, DICTATION_MAX_BYTES, MAX_PROMPT_CHARS, normalizeTranscript, PROVIDER_TIMEOUT_MS } from './shape.ts'

test('baseType drops the parameters a browser adds to the container', () => {
  assert.equal(baseType('audio/webm;codecs=opus'), 'audio/webm')
  assert.equal(baseType('audio/webm; codecs="opus"'), 'audio/webm')
  assert.equal(baseType('audio/mp4'), 'audio/mp4')
})

test('baseType is case-insensitive, as MIME types are', () => {
  assert.equal(baseType('Audio/WebM;codecs=opus'), 'audio/webm')
})

test('baseType refuses what the provider would refuse, before anybody pays for a request (criterion 9)', () => {
  assert.equal(baseType(undefined), undefined)
  assert.equal(baseType(''), undefined)
  assert.equal(baseType('audio/aac'), undefined)
  assert.equal(baseType('application/octet-stream'), undefined)
  assert.equal(baseType('text/plain;audio/webm'), undefined)
})

test('every accepted type names an extension the provider accepts (measured: A1)', () => {
  const accepted = new Set(['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'opus', 'wav', 'webm'])
  for (const extension of Object.values(AUDIO_TYPES)) assert.ok(accepted.has(extension), extension)
})

test('normalizeTranscript trims, and a transcript of only punctuation is no transcript (criterion 14)', () => {
  assert.equal(normalizeTranscript('  Hola, ¿qué tal?  '), 'Hola, ¿qué tal?')
  assert.equal(normalizeTranscript(' ... '), '')
  assert.equal(normalizeTranscript('¿?¡!,.;:—-…'), '')
  assert.equal(normalizeTranscript('\n\t'), '')
  assert.equal(normalizeTranscript(''), '')
})

test('the ceilings keep the order the design depends on', () => {
  // The provider gives up before the screen does, so the owner reads a reason and not a timeout.
  assert.ok(PROVIDER_TIMEOUT_MS < 25_000)
  // Whisper truncates silently from ~550 characters (Jarvis D1).
  assert.ok(MAX_PROMPT_CHARS < 550)
  assert.ok(DICTATION_MAX_BYTES <= 32 * 1024 * 1024)
})
