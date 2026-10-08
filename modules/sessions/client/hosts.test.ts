import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EngineSetupView } from '../types.ts'
import type { HostView } from './contract.ts'
import { groupByHost, hostKey, hostStatus, initialLaunchChoice, isUnreachable, launchPath, launchRest, rememberedLaunchHost, runOnChoices } from './hosts.ts'

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

// --- The drawer's heading per host (tasks E4b, criterion 10) ---------------------------------------

const AT = Date.parse('2026-10-08T10:00:00.000Z')

test('hostStatus: a reachable host is available; a host down says when it was last seen, or that it never was', () => {
  assert.equal(hostStatus({ reachable: true, lastSeenAt: null }, AT), 'available')
  assert.equal(hostStatus({ reachable: false, lastSeenAt: '2026-10-08T09:55:00.000Z' }, AT), 'unreachable · last seen 5m ago')
  assert.equal(hostStatus({ reachable: false, lastSeenAt: '2026-10-08T09:59:50.000Z' }, AT), 'unreachable · last seen just now')
  assert.equal(hostStatus({ reachable: false, lastSeenAt: null }, AT), 'unreachable · never seen')
})

test('isUnreachable: only a peer that GET /hosts says is down; the serving host and an unknown name never are', () => {
  assert.equal(isUnreachable('mac', [LINUX, MAC_DOWN]), true)
  assert.equal(isUnreachable('mac', [LINUX, MAC]), false)
  assert.equal(isUnreachable(undefined, [LINUX, MAC_DOWN]), false)
  assert.equal(isUnreachable('mac', []), false)
})

// --- The launch screen of a host (tasks E5a, E5b, criterion 12) ------------------------------------

test('launchRest: `new`, `new/<siteId>` with the project to preselect, and anything else is not the launcher', () => {
  assert.deepEqual(launchRest('new'), { siteId: undefined })
  assert.deepEqual(launchRest('new/vault'), { siteId: 'vault' })
  assert.deepEqual(launchRest('new/my%20site'), { siteId: 'my site' })
  assert.equal(launchRest(''), undefined)
  assert.equal(launchRest('projects'), undefined)
  assert.equal(launchRest('019a-session'), undefined)
  assert.equal(launchRest('new/a/b'), undefined)
  assert.equal(launchRest('new/'), undefined)
  // A broken escape is no project, not a thrown URIError.
  assert.deepEqual(launchRest('new/%E0'), { siteId: undefined })
})

test('launchPath is what launchRest reads back', () => {
  assert.equal(launchPath(undefined), 'new')
  assert.equal(launchPath(''), 'new')
  assert.equal(launchPath('my site'), 'new/my%20site')
  assert.deepEqual(launchRest(launchPath('my site')), { siteId: 'my site' })
})

test('runOnChoices: the serving host and every REACHABLE peer; nothing to choose with fewer than two', () => {
  assert.deepEqual(runOnChoices([LINUX, MAC], undefined), [
    { key: undefined, name: 'omarchy' },
    { key: 'mac', name: 'mac' },
  ])
  assert.deepEqual(runOnChoices([LINUX, MAC_DOWN], undefined), [])
  assert.deepEqual(runOnChoices([LINUX], undefined), [])
  assert.deepEqual(runOnChoices([], undefined), [])
})

test('runOnChoices keeps the screen’s own host even while it is down, so the select has its value', () => {
  assert.deepEqual(runOnChoices([LINUX, MAC_DOWN], 'mac'), [
    { key: undefined, name: 'omarchy' },
    { key: 'mac', name: 'mac' },
  ])
})

test('rememberedLaunchHost: the peer chosen last on this device while it is reachable; else stay on the serving host', () => {
  assert.equal(rememberedLaunchHost('mac', [LINUX, MAC]), 'mac')
  assert.equal(rememberedLaunchHost('mac', [LINUX, MAC_DOWN]), undefined)
  assert.equal(rememberedLaunchHost('omarchy', [LINUX, MAC]), undefined, 'the serving host is where New already is')
  assert.equal(rememberedLaunchHost('gone', [LINUX, MAC]), undefined, 'a host no longer declared')
  assert.equal(rememberedLaunchHost(undefined, [LINUX, MAC]), undefined)
})
