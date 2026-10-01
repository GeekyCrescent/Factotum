import { test } from 'node:test'
import assert from 'node:assert/strict'
import { askTokenFrom, questionsTokenFrom, withoutAskToken } from './ask-token.ts'

const TOKEN = 'a'.repeat(21) + '-_' + 'Z'.repeat(20)

test('the token is read from the query (criterion 55)', () => {
  assert.equal(askTokenFrom(`?ask=${TOKEN}`), TOKEN)
})

test('no token, or one that is not the shape the engine issues, reads as none', () => {
  assert.equal(askTokenFrom(''), undefined)
  assert.equal(askTokenFrom('?ask='), undefined)
  assert.equal(askTokenFrom('?ask=short'), undefined)
  assert.equal(askTokenFrom(`?ask=${TOKEN}<script>`), undefined)
})

test('the token is REMOVED from the URL, and nothing else is (criterion 58)', () => {
  assert.equal(withoutAskToken('/m/sessions/019a', `?ask=${TOKEN}`), '/m/sessions/019a')
  assert.equal(withoutAskToken('/m/sessions/019a', `?ask=${TOKEN}&keep=1`), '/m/sessions/019a?keep=1')
})

test('a questions token comes with its batch, both in the shapes the engine issues (spec 2026-10-01-preguntas, D10)', () => {
  const token = 'Q'.repeat(43)
  const batch = '0123456789abcdef0123456789abcdef'
  assert.deepEqual(questionsTokenFrom(`?questions=${token}&batch=${batch}`), { token, batch })
  assert.equal(questionsTokenFrom(`?questions=${token}`), undefined)
  assert.equal(questionsTokenFrom(`?questions=short&batch=${batch}`), undefined)
  assert.equal(questionsTokenFrom(`?questions=${token}&batch=XYZ`), undefined)
  assert.equal(questionsTokenFrom(`?ask=${token}`), undefined)
})
