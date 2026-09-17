import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SubscriptionStore, SUBSCRIPTIONS_FILE, type Subscription } from './store.ts'

const sub = (endpoint: string, auth = 'auth-a'): Subscription => ({
  endpoint,
  keys: { p256dh: 'BPp256dh', auth },
})

async function dir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'factotum-subs-'))
}

test('an empty directory opens as zero subscriptions and no warning', async () => {
  const { store, warning } = await SubscriptionStore.open(await dir())
  assert.equal(store.count(), 0)
  assert.equal(warning, undefined)
})

test('an upsert survives a restart, and the file is owner-only', async () => {
  const push = await dir()
  const previous = process.umask(0o000)
  try {
    const { store } = await SubscriptionStore.open(push)
    await store.upsert(sub('https://fcm.googleapis.com/fcm/send/one'))
  } finally {
    process.umask(previous)
  }

  const { store: reopened } = await SubscriptionStore.open(push)
  assert.equal(reopened.count(), 1)
  assert.equal(reopened.has('https://fcm.googleapis.com/fcm/send/one'), true)
  assert.equal((await stat(join(push, SUBSCRIPTIONS_FILE))).mode & 0o777, 0o600)
})

test('the same endpoint twice UPDATES instead of duplicating (criterion 6)', async () => {
  const { store } = await SubscriptionStore.open(await dir())
  await store.upsert(sub('https://push.example/a', 'old'))
  await store.upsert(sub('https://push.example/a', 'new'))

  assert.equal(store.count(), 1)
  assert.equal(store.all()[0]?.keys.auth, 'new')
})

test('endpoints are compared RAW: two that differ only in the query are two subscriptions', async () => {
  // `new URL(x).href` can reorder or re-encode. An endpoint is a capability URL handed to us by
  // the push service, and the only safe comparison is the exact string it gave us.
  const { store } = await SubscriptionStore.open(await dir())
  await store.upsert(sub('https://push.example/a?x=1'))
  await store.upsert(sub('https://push.example/a?x=2'))

  assert.equal(store.count(), 2)
  assert.equal(await store.remove('https://push.example/a?x=1'), true)
  assert.equal(store.has('https://push.example/a?x=2'), true)
})

test('remove reports whether there was anything to remove, and persists', async () => {
  const push = await dir()
  const { store } = await SubscriptionStore.open(push)
  await store.upsert(sub('https://push.example/a'))

  assert.equal(await store.remove('https://push.example/missing'), false)
  assert.equal(await store.remove('https://push.example/a'), true)
  assert.equal((await SubscriptionStore.open(push)).store.count(), 0)
})

test('TWO CONCURRENT REMOVALS BOTH PERSIST — what allSettled does with two dead subscriptions', async () => {
  // Without serialisation each removal reads the list, drops one, and writes: the second
  // write resurrects what the first removed. This is the exact shape of criterion 7.
  const push = await dir()
  const { store } = await SubscriptionStore.open(push)
  await store.upsert(sub('https://push.example/a'))
  await store.upsert(sub('https://push.example/b'))
  await store.upsert(sub('https://push.example/c'))

  await Promise.all([store.remove('https://push.example/a'), store.remove('https://push.example/b')])

  const { store: reopened } = await SubscriptionStore.open(push)
  assert.deepEqual(reopened.all().map((s) => s.endpoint), ['https://push.example/c'])
})

test('a corrupt file degrades to zero with a warning that names the file', async () => {
  // Subscriptions are derived state: every device can subscribe again. So an unreadable file
  // costs a re-subscribe, not the daemon.
  const push = await dir()
  await writeFile(join(push, SUBSCRIPTIONS_FILE), '[{"endpoint": trunc', 'utf8')

  const { store, warning } = await SubscriptionStore.open(push)

  assert.equal(store.count(), 0)
  assert.match(warning ?? '', /subscriptions\.json/)
})

test('entries that are not subscriptions are dropped on load, the rest survive', async () => {
  const push = await dir()
  await writeFile(
    join(push, SUBSCRIPTIONS_FILE),
    JSON.stringify([sub('https://push.example/ok'), { endpoint: 42 }, 'nonsense']),
    'utf8',
  )

  const { store, warning } = await SubscriptionStore.open(push)
  assert.equal(store.count(), 1)
  assert.match(warning ?? '', /2/)
})

test('clear empties the store and the file (factotum push reset, criterion 57)', async () => {
  const push = await dir()
  const { store } = await SubscriptionStore.open(push)
  await store.upsert(sub('https://push.example/a'))
  await store.upsert(sub('https://push.example/b'))

  await store.clear()

  assert.equal(store.count(), 0)
  assert.deepEqual(JSON.parse(await readFile(join(push, SUBSCRIPTIONS_FILE), 'utf8')), [])
})

test('all() hands out a copy: a caller cannot mutate the store from outside', async () => {
  const { store } = await SubscriptionStore.open(await dir())
  await store.upsert(sub('https://push.example/a'))

  const list = store.all() as Subscription[]
  list.pop()

  assert.equal(store.count(), 1)
})
