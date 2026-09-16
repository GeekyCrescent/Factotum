import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subscriptionSchema } from './schema.ts'

// The shape a real Chrome 153 produced against FCM (spec A5/A6): an 188-character endpoint,
// an 87-character p256dh and a 22-character auth, all base64url, plus `expirationTime: null`.
const real = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/' + 'a'.repeat(152),
  expirationTime: null,
  keys: { p256dh: 'B' + 'x'.repeat(86), auth: 'y'.repeat(22) },
}

test('a real browser subscription validates, and fields we do not store are dropped', () => {
  const parsed = subscriptionSchema.safeParse(real)
  assert.equal(parsed.success, true)
  assert.deepEqual(Object.keys(parsed.success ? parsed.data : {}).sort(), ['endpoint', 'keys'])
})

test('an http: endpoint is refused — there is no Web Push over plain HTTP', () => {
  const parsed = subscriptionSchema.safeParse({ ...real, endpoint: 'http://push.example/x' })
  assert.equal(parsed.success, false)
})

test('something that is not a URL is refused rather than throwing', () => {
  assert.equal(subscriptionSchema.safeParse({ ...real, endpoint: 'not a url' }).success, false)
})

test('empty keys are refused', () => {
  assert.equal(subscriptionSchema.safeParse({ ...real, keys: { p256dh: '', auth: 'y'.repeat(22) } }).success, false)
  assert.equal(subscriptionSchema.safeParse({ ...real, keys: { p256dh: 'B' + 'x'.repeat(86), auth: '' } }).success, false)
})

test('keys that are not base64url are refused — padding and `+/` included', () => {
  assert.equal(subscriptionSchema.safeParse({ ...real, keys: { ...real.keys, auth: 'abc+/==' } }).success, false)
})

test('absurd lengths are refused, so a POST cannot grow the file without bound', () => {
  assert.equal(subscriptionSchema.safeParse({ ...real, endpoint: 'https://push.example/' + 'a'.repeat(5000) }).success, false)
  assert.equal(subscriptionSchema.safeParse({ ...real, keys: { ...real.keys, p256dh: 'B'.repeat(500) } }).success, false)
})

test('a body with no keys at all is refused, naming the field', () => {
  const parsed = subscriptionSchema.safeParse({ endpoint: real.endpoint })
  assert.equal(parsed.success, false)
  assert.match(parsed.success ? '' : JSON.stringify(parsed.error.issues[0]?.path), /keys/)
})
