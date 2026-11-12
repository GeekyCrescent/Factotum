/**
 * `submit_stage`: how a stage's session tells the module it is done (design D3), served on the
 * sessions' MCP server through the link (D1).
 *
 * THE CHECKS, IN THIS ORDER, each refusing WITHOUT TOUCHING ANYTHING with a text the agent can act on:
 * 1. the run exists and is alive (`running` or `stalled`);
 * 2. the site and, once linked, the session are the run's; not linked yet, it links now (crit. 18);
 * 3. the files the stage table requires are named, exist, are not empty, and every file named has
 *    its REAL path inside `vaultDir` or `workDir`.
 * Checks 4–6 (options, URLs, the guard) arrive with the stages that need them (cuts 2 and 3).
 *
 * Accepted: `acceptSubmit` and, with a gate, ONE push with a fixed body — nothing of the summary nor
 * of the documents leaves the private network (criterion 26). NEVER THROWS, and the log carries ids.
 */

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Logger, Notifier } from '@factotum/core'
import { acceptSubmit, findRun, linkSession } from './ops.ts'
import { inside, real } from './paths.ts'
import { parseSubmit, SUMMARY_MAX_CHARS, type SubmitInput } from './shape.ts'
import { RUN_SPECS } from './stages.ts'
import type { MockupsStore } from './store/store.ts'
import type { AgentTool, AgentToolImpl, AgentToolResult, Mockup, Run, StageId } from './types.ts'

export const SUBMIT_STAGE = 'submit_stage'

const TOOL: AgentTool = {
  name: SUBMIT_STAGE,
  description:
    'Hand a finished mockup stage to the owner. Call it once, at the end, with the runId from your instructions and the files you wrote. ' +
    'If it refuses, fix what it says and call again; when it accepts, end your turn.',
  inputSchema: {
    type: 'object',
    properties: {
      runId: { type: 'string', description: 'The runId from your instructions.' },
      files: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'The files you wrote, relative to the mockup folder or the work folder.' },
      summary: { type: 'string', maxLength: SUMMARY_MAX_CHARS, description: 'One or two sentences for the owner on what you did.' },
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, title: { type: 'string' }, blurb: { type: 'string' }, url: { type: 'string' } },
          required: ['id', 'title', 'blurb'],
          additionalProperties: false,
        },
        description: 'Only for stages that offer options.',
      },
      previewUrl: { type: 'string', description: 'Only for stages that deploy a preview.' },
      prodUrl: { type: 'string', description: 'Only for the stage that deploys to production.' },
    },
    required: ['runId', 'files', 'summary'],
    additionalProperties: false,
  },
}

export interface SubmitDeps {
  readonly store: MockupsStore
  readonly now: () => Date
  readonly log: Logger
  readonly notify: Notifier
  readonly caseInsensitive: boolean
}

const text = (body: string, isError: boolean): AgentToolResult => ({ content: [{ type: 'text', text: body }], ...(isError ? { isError: true as const } : {}) })
const refuse = (body: string): AgentToolResult => text(body, true)

interface Live {
  readonly mockup: Mockup
  readonly stage: StageId
  readonly run: Run
}

function findLive(mockups: readonly Mockup[], runId: string): Live | undefined {
  for (const m of mockups) {
    const found = findRun(m, runId)
    if (found !== undefined && (found.step.status === 'running' || found.step.status === 'stalled')) return { mockup: m, stage: found.stage, run: found.run }
  }
  return undefined
}

/** Check 3. `undefined`: every file is there, inside, and not empty. */
async function checkFiles(live: Live, input: SubmitInput, caseInsensitive: boolean): Promise<string | undefined> {
  const { vaultDir, workDir } = live.mockup
  for (const required of RUN_SPECS[live.stage].files) {
    if (!input.files.includes(required)) return `files must include ${required}, the document this stage writes.`
  }
  for (const file of input.files) {
    const candidates = isAbsolute(file) ? [file] : [join(vaultDir, file), join(workDir, file)]
    let found: string | undefined
    for (const candidate of candidates) {
      try {
        if ((await stat(candidate)).isFile()) {
          found = candidate
          break
        }
      } catch {
        // Not there; the next folder, or "does not exist".
      }
    }
    if (found === undefined) return `${file} does not exist in ${vaultDir} nor in ${workDir}. Write it there and call again.`
    const realPath = await real(found)
    if (!inside(vaultDir, realPath, caseInsensitive) && !inside(workDir, realPath, caseInsensitive)) {
      return `${file} is outside the mockup folders (${vaultDir}, ${workDir}). Write it inside them.`
    }
    if ((await readFile(found, 'utf8')).trim() === '') return `${file} is empty. Write the document and call again.`
  }
  return undefined
}

async function submit(deps: SubmitDeps, sessionId: string, siteId: string, raw: unknown): Promise<AgentToolResult> {
  const shaped = parseSubmit(raw)
  if (!shaped.ok) return refuse(`Not submitted: ${shaped.field} ${shaped.reason}. Fix it and call again.`)
  const input = shaped.value

  const live = findLive(deps.store.current().mockups, input.runId)
  if (live === undefined) return refuse(`There is no live run ${input.runId}. Use the runId from your instructions; if the owner retried the stage, this session is no longer the one doing it.`)
  if (live.run.siteId !== siteId) return refuse('This session runs in another project than the stage it is submitting. Submit from the session the stage launched.')
  if (live.run.sessionId !== undefined && live.run.sessionId !== sessionId) return refuse('That run belongs to another session. Submit from the session the stage launched.')

  const problem = await checkFiles(live, input, deps.caseInsensitive)
  if (problem !== undefined) return refuse(`Not submitted: ${problem}`)

  const now = deps.now()
  const result = await deps.store.change((file) => {
    const current = file.mockups.find((m) => m.id === live.mockup.id)
    if (current === undefined) return { ok: false, error: { code: 'not-found', reason: 'the mockup is gone' } }
    const linked = linkSession(current, input.runId, sessionId, now)
    if (!linked.ok) return linked
    const accepted = acceptSubmit(linked.value, input.runId, { sessionId, summary: input.summary, ...(input.options === undefined ? {} : { options: input.options }) }, now)
    if (!accepted.ok) return accepted
    const mockups = file.mockups.map((m) => (m.id === current.id ? accepted.value : m))
    return { ok: true, value: { file: { ...file, mockups }, mockup: accepted.value } }
  })
  if (!result.ok) {
    deps.log.warn(`mockup ${live.mockup.id}: ${live.stage} run ${input.runId} could not be accepted (${result.error.code})`)
    return refuse(`Not submitted: ${result.error.reason}.`)
  }
  const step = result.value.mockup.stages[live.stage]
  deps.log.info(`mockup ${live.mockup.id}: ${live.stage} run ${input.runId} submitted, version ${step.version}, ${step.status}`)
  if (step.status === 'waiting' && deps.notify.canReach()) {
    // The name is the owner's choice (requirements §5); the body is FIXED, and nothing else goes.
    await deps.notify.send({
      title: `${live.mockup.name}: ${live.stage} ready`,
      body: 'Tap to review.',
      path: `/m/mockups/${live.mockup.id}/${live.stage}`,
      tag: `mockups-gate-${live.mockup.id}-${live.stage}`,
    })
  }
  return text(step.status === 'waiting' ? 'Submitted. The owner will review it. End your turn now.' : 'Submitted. End your turn now.', false)
}

/** The family's implementation: what `mockups` fills the link with, LAST in `start` (D1). */
export function createSubmitTool(deps: SubmitDeps): AgentToolImpl {
  return {
    tools: () => [TOOL],
    call: async (input) => {
      if (input.name !== SUBMIT_STAGE) return refuse(`The mockups module has no tool called ${input.name}.`)
      try {
        return await submit(deps, input.sessionId, input.siteId, input.raw)
      } catch {
        deps.log.error('submit_stage failed unexpectedly')
        return refuse('The mockups module could not take the submission right now. Tell the owner in your reply.')
      }
    },
  }
}
