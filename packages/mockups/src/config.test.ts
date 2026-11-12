import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseMockupsConfig } from './config.ts'

const HOME = '/Users/me'
const BASE = {
  docsSiteId: 'personal',
  vault: { projectsDir: '/Users/me/Obsidian/01-projects', mapFile: '/Users/me/Obsidian/06-maps/day-job/day-job.md' },
  workRoot: '/Users/me/BWR/Projects',
}

const reason = (raw: unknown): string => {
  const parsed = parseMockupsConfig(raw, HOME)
  return parsed.ok ? 'ok' : parsed.reason
}

test('a full block parses; crossWritesAllowed is false by default and model optional', () => {
  const parsed = parseMockupsConfig(BASE, HOME)
  assert.ok(parsed.ok)
  assert.equal(parsed.config.crossWritesAllowed, false)
  assert.equal(parsed.config.model, undefined)
  const full = parseMockupsConfig({ ...BASE, model: 'opus[1m]', crossWritesAllowed: true }, HOME)
  assert.ok(full.ok)
  assert.equal(full.config.model, 'opus[1m]')
})

test('~/ is expanded when the config is loaded', () => {
  const parsed = parseMockupsConfig({ ...BASE, workRoot: '~/BWR/Projects', vault: { projectsDir: '~/Obsidian/01-projects' } }, HOME)
  assert.ok(parsed.ok)
  assert.equal(parsed.config.workRoot, '/Users/me/BWR/Projects')
  assert.equal(parsed.config.vault.projectsDir, '/Users/me/Obsidian/01-projects')
  assert.equal(parsed.config.vault.mapFile, undefined)
})

test('crit. 2: an empty docsSiteId, a relative workRoot or projectsDir, a mapFile that is not .md', () => {
  assert.match(reason({ ...BASE, docsSiteId: '' }), /^mockups\.docsSiteId: /)
  assert.match(reason({ ...BASE, workRoot: 'BWR/Projects' }), /^mockups\.workRoot: .*absolute/)
  assert.match(reason({ ...BASE, vault: { projectsDir: 'projects' } }), /^mockups\.vault\.projectsDir: .*absolute/)
  assert.match(reason({ ...BASE, vault: { ...BASE.vault, mapFile: '/Users/me/map.txt' } }), /^mockups\.vault\.mapFile: .*\.md/)
})

test('an unknown key is refused (strictObject), and a model that could be a flag too', () => {
  assert.match(reason({ ...BASE, protect: true }), /^mockups: /)
  assert.match(reason({ ...BASE, model: '-p' }), /^mockups\.model: /)
  assert.match(reason(undefined), /^mockups: /)
})
