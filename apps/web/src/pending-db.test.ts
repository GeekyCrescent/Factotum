import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LAUNCH_KEY, DEVICE_KEY, launchHostOf, launchRecord } from './pending-db.ts'

// The IndexedDB itself is not in the runner: that writing the launch host leaves `sameMachine` as it
// was is checked by hand in E8 (spec 2026-10-07-dos-hosts, tasks E5b). What is pure is here.

test('the launch host has ITS OWN KEY in the settings store, never the device record sw.js reads (design D12)', () => {
  assert.equal(LAUNCH_KEY, 'launch')
  assert.equal(DEVICE_KEY, 'device')
  assert.notEqual(LAUNCH_KEY, DEVICE_KEY)
  // Nothing of the device's in what is written: a put of it can never carry a `sameMachine`.
  assert.deepEqual(launchRecord('mac'), { host: 'mac' })
  assert.equal('sameMachine' in launchRecord('mac'), false)
})

test('launchHostOf reads back what launchRecord wrote, and anything else as nothing', () => {
  assert.equal(launchHostOf(launchRecord('mac')), 'mac')
  assert.equal(launchHostOf(undefined), undefined)
  assert.equal(launchHostOf(null), undefined)
  assert.equal(launchHostOf('mac'), undefined)
  assert.equal(launchHostOf({ host: '' }), undefined)
  assert.equal(launchHostOf({ host: 7 }), undefined)
  assert.equal(launchHostOf({ sameMachine: true }), undefined)
})
