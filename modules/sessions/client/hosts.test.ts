import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EngineSetupView } from '../types.ts'
import type { HostView } from './contract.ts'
import { groupByHost, hostKey, initialLaunchChoice } from './hosts.ts'

const LINUX: HostView = { name: 'omarchy', self: true, reachable: true, lastSeenAt: null }
const MAC: HostView = { name: 'mac', self: false, reachable: true, lastSeenAt: '2026-10-08T10:00:00.000Z' }
const MAC_DOWN: HostView = { ...MAC, reachable: false }

test('hostKey: the serving host is undefined, a peer is its name, and no name stays undefined', () => {
  assert.equal(hostKey('omarchy', [LINUX, MAC]), undefined)
  assert.equal(hostKey('mac', [LINUX, MAC]), 'mac')
  assert.equal(hostKey(undefined, [LINUX, MAC]), undefined)
  // Before GET /hosts answers there is no telling which is ours: the name stays a name.
  assert.equal(hostKey('omarchy', []), 'omarchy')
})

test('groupByHost: the serving host first under undefined, each peer with its own data', () => {
  const byHost = new Map<string | undefined, string>([
    [undefined, 'linux projects'],
    ['mac', 'mac projects'],
  ])
  assert.deepEqual(groupByHost([MAC, LINUX], byHost), [
    { key: undefined, name: 'omarchy', reachable: true, lastSeenAt: null, data: 'linux projects' },
    { key: 'mac', name: 'mac', reachable: true, lastSeenAt: '2026-10-08T10:00:00.000Z', data: 'mac projects' },
  ])
})

test('groupByHost with a host down: it is still a group, unreachable, with its last seen and no data', () => {
  const byHost = new Map<string | undefined, string>([[undefined, 'linux projects']])
  assert.deepEqual(groupByHost([LINUX, MAC_DOWN], byHost), [
    { key: undefined, name: 'omarchy', reachable: true, lastSeenAt: null, data: 'linux projects' },
    { key: 'mac', name: 'mac', reachable: false, lastSeenAt: '2026-10-08T10:00:00.000Z', data: undefined },
  ])
})

test('groupByHost before GET /hosts answers, or with no peers: one group, the serving host', () => {
  const byHost = new Map<string | undefined, string>([[undefined, 'projects']])
  assert.deepEqual(groupByHost([], byHost), [{ key: undefined, name: undefined, reachable: true, lastSeenAt: null, data: 'projects' }])
  assert.deepEqual(groupByHost([LINUX], byHost), [{ key: undefined, name: 'omarchy', reachable: true, lastSeenAt: null, data: 'projects' }])
})

function setup(sites: readonly [string, 'ok' | 'missing'][], entries: readonly [string, string | undefined][]): EngineSetupView {
  return {
    sites: sites.map(([id, status]) => ({ id, path: `/p/${id}`, isRepo: true, name: id, color: undefined, status })),
    catalog: entries.map(([id, disabledReason]) => ({ id, label: id, disabledReason })),
  }
}

test('initialLaunchChoice: the first usable project and entry, as LaunchComposer picks them today', () => {
  const linux = setup([['gone', 'missing'], ['vault', 'ok'], ['web', 'ok']], [['off', 'no key'], ['claude', undefined]])
  assert.deepEqual(initialLaunchChoice(linux, undefined), { siteId: 'vault', entryId: 'claude' })
  assert.deepEqual(initialLaunchChoice(setup([], []), undefined), { siteId: '', entryId: '' })
})

test('initialLaunchChoice: the wanted project if THIS host has it usable, else ignored', () => {
  const linux = setup([['vault', 'ok'], ['web', 'ok'], ['gone', 'missing']], [['claude', undefined]])
  const mac = setup([['matilde', 'ok'], ['web', 'ok']], [['claude-mac', undefined]])
  assert.deepEqual(initialLaunchChoice(linux, 'web'), { siteId: 'web', entryId: 'claude' })
  assert.deepEqual(initialLaunchChoice(mac, 'web'), { siteId: 'web', entryId: 'claude-mac' })
  // Always from the setup it is given: a project of the other host, or a missing one, is not chosen.
  assert.deepEqual(initialLaunchChoice(mac, 'vault'), { siteId: 'matilde', entryId: 'claude-mac' })
  assert.deepEqual(initialLaunchChoice(linux, 'gone'), { siteId: 'vault', entryId: 'claude' })
})
