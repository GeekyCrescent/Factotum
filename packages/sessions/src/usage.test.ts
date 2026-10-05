import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Invoke } from './catalog.ts'
import type { SessionMeta } from './store.ts'
import type { Announced, EventInput, SessionEvent } from './types.ts'
import { countSession } from './usage.ts'

const SINCE = '2026-10-01T00:00:00.000Z'
const BEFORE = '2026-09-20T00:00:00.000Z'
const LATER = '2026-10-02T00:00:00.000Z'

const announced: Announced = {
  skills: ['create-spec', 'ecc:plan'],
  agents: ['spec-validator'],
  commands: ['clear', 'review'],
  version: undefined,
  since: SINCE,
}

const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  id: 's1',
  siteId: 'a',
  entryId: 'free',
  state: 'finished',
  startedAt: BEFORE,
  endedAt: LATER,
  reason: undefined,
  turns: 1,
  agentPid: undefined,
  sitePath: undefined,
  agent: undefined,
  prompt: undefined,
  title: undefined,
  autoTitle: undefined,
  archivedAt: undefined,
  ...over,
})

const at = (event: EventInput, when = LATER): SessionEvent => ({ ...event, seq: 0, at: when })
const say = (text: string, role: 'user' | 'assistant' = 'user', when = LATER): SessionEvent => at({ kind: 'message', role, text }, when)

const none = (): Invoke | undefined => undefined
const count = (over: { meta?: SessionMeta; events?: readonly SessionEvent[]; invokeOf?: (id: string) => Invoke | undefined } = {}) =>
  countSession({ meta: over.meta ?? meta(), events: over.events ?? [], since: SINCE, announced, invokeOf: over.invokeOf ?? none })

test('a user message starting with /name of a skill counts for the owner', () => {
  assert.deepEqual(count({ events: [say('/create-spec the idea')] }), [{ name: 'create-spec', who: 'owner', at: LATER }])
})

test('a user message starting with /name of a command counts for the owner', () => {
  assert.deepEqual(count({ events: [say('/review')] }), [{ name: 'review', who: 'owner', at: LATER }])
})

test('the first token ends at any blank, a newline included', () => {
  assert.equal(count({ events: [say('/create-spec\nmore')] }).length, 1)
})

test('a name with a colon is read whole', () => {
  assert.equal(count({ events: [say('/ecc:plan x')] })[0]?.name, 'ecc:plan')
})

test('a user message that does not start with / does not count', () => {
  assert.deepEqual(count({ events: [say('use /create-spec please')] }), [])
})

test('a daemon notice with role user does not count', () => {
  assert.deepEqual(count({ events: [say('freshness not checked: the repository could not be read')] }), [])
})

test('an assistant message starting with / does not count', () => {
  assert.deepEqual(count({ events: [say('/create-spec', 'assistant')] }), [])
})

test('a / name that is not announced, or not a valid name, does not count', () => {
  assert.deepEqual(count({ events: [say('/unknown'), say('//create-spec'), say('/ create-spec'), say('/')] }), [])
})

test('an agent name typed after / does not count: only skills and commands', () => {
  assert.deepEqual(count({ events: [say('/spec-validator')] }), [])
})

test('meta.agent counts once for the owner, at startedAt', () => {
  const found = count({ meta: meta({ agent: 'spec-validator', startedAt: LATER }) })
  assert.deepEqual(found, [{ name: 'spec-validator', who: 'owner', at: LATER }])
})

test('meta.agent started before since does not count', () => {
  assert.deepEqual(count({ meta: meta({ agent: 'spec-validator', startedAt: BEFORE }) }), [])
})

test('a command entry counts once for the owner, at startedAt', () => {
  const found = count({ meta: meta({ entryId: 'spec', startedAt: LATER }), invokeOf: () => ({ kind: 'command', name: 'create-spec' }) })
  assert.deepEqual(found, [{ name: 'create-spec', who: 'owner', at: LATER }])
})

test('an entry that is not a command counts nothing', () => {
  assert.deepEqual(count({ meta: meta({ startedAt: LATER }), invokeOf: () => ({ kind: 'none' }) }), [])
  assert.deepEqual(count({ meta: meta({ startedAt: LATER }), invokeOf: () => ({ kind: 'subagent', name: 'spec-validator' }) }), [])
})

test('a Skill tool call counts for the agent', () => {
  const found = count({ events: [at({ kind: 'tool', name: 'Skill', input: { skill: 'create-spec', args: 'x' } })] })
  assert.deepEqual(found, [{ name: 'create-spec', who: 'agent', at: LATER }])
})

test('a Skill tool call naming a command counts for the agent', () => {
  assert.equal(count({ events: [at({ kind: 'tool', name: 'Skill', input: { skill: 'review' } })] })[0]?.name, 'review')
})

test('a Skill call with a name that is not announced does not count', () => {
  assert.deepEqual(count({ events: [at({ kind: 'tool', name: 'Skill', input: { skill: 'made-up' } })] }), [])
})

test('a Skill call whose skill is not a string, or another tool, does not count', () => {
  assert.deepEqual(
    count({
      events: [
        at({ kind: 'tool', name: 'Skill', input: { skill: 7 } }),
        at({ kind: 'tool', name: 'Skill', input: null }),
        at({ kind: 'tool', name: 'Bash', input: { skill: 'create-spec' } }),
      ],
    }),
    [],
  )
})

test('a started subagent counts for the agent', () => {
  const found = count({ events: [at({ kind: 'subagent', phase: 'started', task: 't', agent: 'spec-validator', description: 'd', background: false })] })
  assert.deepEqual(found, [{ name: 'spec-validator', who: 'agent', at: LATER }])
})

test('a subagent that only ended, or is not an announced agent, does not count', () => {
  const ended = at({ kind: 'subagent', phase: 'ended', task: 't', ok: true, status: 'completed', summary: 'done' })
  const other = at({ kind: 'subagent', phase: 'started', task: 't', agent: 'general-purpose', description: 'd', background: false })
  assert.deepEqual(count({ events: [ended, other] }), [])
})

test('an event before since does not count', () => {
  const found = count({ events: [say('/create-spec', 'user', BEFORE), at({ kind: 'tool', name: 'Skill', input: { skill: 'review' } }, BEFORE)] })
  assert.deepEqual(found, [])
})

test('an event exactly at since counts', () => {
  assert.equal(count({ events: [say('/create-spec', 'user', SINCE)] }).length, 1)
})

test('only names and numbers leave: no prompt text in the result', () => {
  const found = count({ events: [say('/create-spec secret prompt words')] })
  assert.ok(!JSON.stringify(found).includes('secret'))
})
