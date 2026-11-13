import assert from 'node:assert/strict'
import { test } from 'node:test'

import { appOf, insertApp, queueStore } from '../ai/test-queue.ts'
import type { Net, NetResult, Page } from '../scout/net.ts'
import * as repo from '../store/repo.ts'
import { NOW, valueOf } from '../test-state.ts'
import { capturedLog, tempBase } from '../test-support.ts'
import { ok, type Opportunity } from '../types.ts'
import { createAdRevalidator } from './ads.ts'

const page = (status: number, url: string): NetResult<Page> => ({ ok: true, value: { status, url, redirects: [], contentType: 'text/html', body: '' } })

async function storeWithAd(base: { readonly dir: string; readonly [Symbol.dispose]: () => void }, over: Partial<Opportunity> = {}) {
  const db = await queueStore(base)
  valueOf(
    db.tx((q) => {
      // A test-only write: the store has no writer for an opportunity's URL after import.
      q.run('UPDATE opportunities SET url = ? WHERE id = ?', 'https://acme.example/jobs/1', 'opp-1')
      const opp = repo.getOpportunity(q, 'opp-1') as Opportunity
      return repo.saveOpportunityCheck(q, { ...opp, ...over }, { kind: 'ad-checked' }, NOW)
    }),
  )
  return db
}

test('C1 ads: a vacancy in review with a stale look is revalidated in the background; a 404 closes it', async () => {
  using base = tempBase()
  const db = await storeWithAd(base)
  insertApp(db, { state: 'ready' })
  const asked: string[] = []
  const net: Net = { get: async (url) => (asked.push(url), page(404, url)) }
  const ads = createAdRevalidator({ db, net, now: () => NOW, log: capturedLog().log })

  ads.kick()
  ads.kick() // a walk is under way: nothing more
  await ads.idle()

  assert.deepEqual(asked, ['https://acme.example/jobs/1'])
  const app = appOf(db, 'app-1')
  assert.equal(app.state, 'in-review')
  assert.ok(app.warnings.some((w) => w.code === 'ad-closed'))

  ads.kick() // the look is fresh now
  await ads.idle()
  assert.equal(asked.length, 1)
  await ads.stop()
})

test('C1 ads: outreach, closed ads, fresh looks and applications out of review are left alone; after stop, nothing', async () => {
  using base = tempBase()
  const db = await storeWithAd(base, { checkedAt: NOW.toISOString() })
  insertApp(db, { state: 'in-review' })
  insertApp(db, { id: 'draft', state: 'draft' })
  const asked: string[] = []
  const net: Net = { get: async (url) => (asked.push(url), page(200, url)) }
  const ads = createAdRevalidator({ db, net, now: () => NOW, log: capturedLog().log })

  ads.kick()
  await ads.idle()
  assert.deepEqual(asked, [])

  await ads.stop()
  ads.kick()
  await ads.idle()
  assert.deepEqual(asked, [])
})

test('C1 ads: a walk that throws is logged, and the next kick walks again', async () => {
  using base = tempBase()
  const db = await storeWithAd(base)
  insertApp(db, { state: 'ready' })
  const log = capturedLog()
  let calls = 0
  const net: Net = {
    get: async (url) => {
      calls += 1
      if (calls === 1) throw new Error('boom')
      return page(200, url)
    },
  }
  const ads = createAdRevalidator({ db, net, now: () => NOW, log: log.log })

  ads.kick()
  await ads.idle()
  assert.ok(log.lines.some((line) => line.startsWith('error') && line.includes('boom')))
  ads.kick()
  await ads.idle()
  assert.equal(calls, 2)
  await ads.stop()
})
