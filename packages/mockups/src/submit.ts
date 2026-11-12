/**
 * `submit_stage`: how a stage's session tells the module it is done (design D3), served on the
 * sessions' MCP server through the link (D1).
 *
 * THE CHECKS, IN THIS ORDER, each refusing WITHOUT TOUCHING ANYTHING with a text the agent can act on:
 * 1. the run exists and is alive (`running` or `stalled`);
 * 2. the site and, once linked, the session are the run's; not linked yet, it links now (crit. 18);
 * 3. the files the stage table requires are named, exist, are not empty, and every file named has
 *    its REAL path inside `vaultDir` or `workDir`.
 * 4. a stage with options gets 2 or 3, with distinct ids (and, in plan, each with its `url`); a stage
 *    without options gets none.
 * 5. every URL (an option's, `previewUrl`, `prodUrl`) is `https://<something>.vercel.app` (A3);
 * 6. a stage that publishes passes the real-data guard (`guard.ts`, criterion 35), which fails closed.
 *
 * Accepted: `acceptSubmit` and, with a gate, ONE push with a fixed body — nothing of the summary nor
 * of the documents leaves the private network (criterion 26). NEVER THROWS, and the log carries ids.
 */

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Logger, Notifier } from '@factotum/core'
import { guard, GUARD_LIMITS, type GuardLimits } from './guard.ts'
import { acceptSubmit, findRun, linkSession } from './ops.ts'
import { inside, real } from './paths.ts'
import { parseSubmit, SUMMARY_MAX_CHARS, type SubmitInput } from './shape.ts'
import { RUN_SPECS } from './stages.ts'
import { codeOf, type MockupsStore } from './store/store.ts'
import type { AgentTool, AgentToolImpl, AgentToolResult, Mockup, Run, RunKind, StageId } from './types.ts'

export const SUBMIT_STAGE = 'submit_stage'
/** The guard BEFORE publishing (crit. 35): the session asks it after a protected deploy, before opening it. */
export const CHECK_REAL_DATA = 'check_real_data'

const TAKE_DOWN =
  'Do not turn the protection off. If you already deployed, take that deployment down now with `vercel remove <url> --yes`, ' +
  'replace the copy with invented data of the same shape, and deploy again.'

const CHECK_TOOL: AgentTool = {
  name: CHECK_REAL_DATA,
  description:
    'Before a deploy is opened to the public: checks that nothing in directions/ or mockup-app/ is a copy of a real-data input. ' +
    'Call it with the runId from your instructions after deploying (still protected) and before turning the protection off.',
  inputSchema: {
    type: 'object',
    properties: { runId: { type: 'string', description: 'The runId from your instructions.' } },
    required: ['runId'],
    additionalProperties: false,
  },
}

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
  /** The seam for the tests of the guard's caps. */
  readonly guardLimits?: GuardLimits
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

/** Checks 1–2: the live run this session may speak for, or why not. */
function ownRun(deps: SubmitDeps, sessionId: string, siteId: string, runId: string): Live | string {
  const live = findLive(deps.store.current().mockups, runId)
  if (live === undefined) return `There is no live run ${runId}. Use the runId from your instructions; if the owner retried the stage, this session is no longer the one doing it.`
  if (live.run.siteId !== siteId) return 'This session runs in another project than the stage it is submitting. Submit from the session the stage launched.'
  if (live.run.sessionId !== undefined && live.run.sessionId !== sessionId) return 'That run belongs to another session. Submit from the session the stage launched.'
  return live
}

/** `check_real_data`: the guard on the run's work-dir, changing nothing. */
async function checkRealData(deps: SubmitDeps, sessionId: string, siteId: string, raw: unknown): Promise<AgentToolResult> {
  const runId = typeof raw === 'object' && raw !== null && 'runId' in raw ? (raw as { runId: unknown }).runId : undefined
  if (typeof runId !== 'string' || runId === '') return refuse('Not checked: runId must be the runId from your instructions.')
  const live = ownRun(deps, sessionId, siteId, runId)
  if (typeof live === 'string') return refuse(live)
  const guarded = await guard(live.mockup.workDir, deps.guardLimits ?? GUARD_LIMITS)
  if (!guarded.ok) {
    deps.log.warn(`mockup ${live.mockup.id}: ${live.stage} run ${runId}: the real-data check refused`)
    return refuse(`Not clear: ${guarded.reason} ${TAKE_DOWN}`)
  }
  deps.log.info(`mockup ${live.mockup.id}: ${live.stage} run ${runId}: the real-data check is clear`)
  return text('Clear: nothing in directions/ or mockup-app/ is a copy of a real-data input. You may turn the protection off.', false)
}

/** Check 3. `undefined`: every file is there, inside, and not empty. */
async function checkFiles(live: Live, input: SubmitInput, caseInsensitive: boolean): Promise<string | undefined> {
  const { vaultDir, workDir } = live.mockup
  for (const required of RUN_SPECS[live.stage].files) {
    if (!input.files.includes(required)) return `files must include ${required}, the document this stage writes.`
  }
  const required = RUN_SPECS[live.stage].files
  for (const file of input.files) {
    // A document the stage requires is read from the mockup folder, so it must be THERE; anything else
    // may be in either folder.
    const candidates = isAbsolute(file) ? [file] : required.includes(file) ? [join(vaultDir, file)] : [join(vaultDir, file), join(workDir, file)]
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
    if (found === undefined) {
      return required.includes(file)
        ? `${file} does not exist in ${vaultDir}. Write it there and call again.`
        : `${file} does not exist in ${vaultDir} nor in ${workDir}. Write it there and call again.`
    }
    const realPath = await real(found)
    if (!inside(vaultDir, realPath, caseInsensitive) && !inside(workDir, realPath, caseInsensitive)) {
      return `${file} is outside the mockup folders (${vaultDir}, ${workDir}). Write it inside them.`
    }
    if ((await readFile(found, 'utf8')).trim() === '') return `${file} is empty. Write the document and call again.`
  }
  return undefined
}

/** Check 4. `undefined`: the options are what the stage table asks. */
export function checkOptions(kind: RunKind, options: SubmitInput['options']): string | undefined {
  const rule = RUN_SPECS[kind].options
  if (rule === null) return options === undefined || options.length === 0 ? undefined : `the ${kind} stage takes no options; call again without them.`
  const count = options?.length ?? 0
  if (options === undefined || count < rule.min || count > rule.max) {
    return `the ${kind} stage needs ${rule.min} or ${rule.max} options, one per alternative, and got ${count}.`
  }
  if (new Set(options.map((option) => option.id)).size !== count) return 'two options have the same id; give each its own.'
  if (rule.url) {
    const bare = options.find((option) => option.url === undefined)
    if (bare !== undefined) return `option ${bare.id} has no url: each one needs the URL of its deployed page.`
  } else {
    // The screen renders an option's url as a link: none where the stage deploys nothing.
    const linked = options.find((option) => option.url !== undefined)
    if (linked !== undefined) return `option ${linked.id} has a url, and the ${kind} stage deploys nothing; call again without it.`
  }
  return undefined
}

/** Check 5: `https://<something>.vercel.app`, nothing else (no port, no user, no other host). */
export function isVercelUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  const host = url.hostname
  return url.protocol === 'https:' && url.port === '' && url.username === '' && url.password === '' && host.endsWith('.vercel.app') && host.length > '.vercel.app'.length
}

/** Check 5. `undefined`: every URL handed in is a Vercel deployment. */
export function checkUrls(input: SubmitInput): string | undefined {
  const urls: readonly [string, string | undefined][] = [
    ...(input.options ?? []).map((option): [string, string | undefined] => [`option ${option.id}'s url`, option.url]),
    ['previewUrl', input.previewUrl],
    ['prodUrl', input.prodUrl],
  ]
  for (const [what, url] of urls) {
    if (url !== undefined && !isVercelUrl(url)) return `${what} must be https://<something>.vercel.app, the URL vercel deploy printed.`
  }
  return undefined
}

async function submit(deps: SubmitDeps, sessionId: string, siteId: string, raw: unknown): Promise<AgentToolResult> {
  const shaped = parseSubmit(raw)
  if (!shaped.ok) return refuse(`Not submitted: ${shaped.field} ${shaped.reason}. Fix it and call again.`)
  const input = shaped.value

  const live = ownRun(deps, sessionId, siteId, input.runId)
  if (typeof live === 'string') return refuse(live)

  const problem = (await checkFiles(live, input, deps.caseInsensitive)) ?? checkOptions(live.stage, input.options) ?? checkUrls(input)
  if (problem !== undefined) return refuse(`Not submitted: ${problem}`)
  if (RUN_SPECS[live.stage].guard) {
    const guarded = await guard(live.mockup.workDir, deps.guardLimits ?? GUARD_LIMITS)
    if (!guarded.ok) {
      deps.log.warn(`mockup ${live.mockup.id}: ${live.stage} run ${input.runId} refused by the real-data guard`)
      return refuse(`Not submitted: ${guarded.reason} ${TAKE_DOWN}`)
    }
  }

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
  if (step.status === 'waiting') await pushGate(deps, live)
  return text(step.status === 'waiting' ? 'Submitted. The owner will review it. End your turn now.' : 'Submitted. End your turn now.', false)
}

/**
 * One push per accepted submission with a gate (D6). The name is the owner's choice (requirements
 * §5); the body is FIXED, and nothing else goes. Its own `try`: the submission is accepted already,
 * and a push that fails must not tell the agent otherwise.
 */
async function pushGate(deps: SubmitDeps, live: Live): Promise<void> {
  if (!deps.notify.canReach()) {
    deps.log.info(`mockup ${live.mockup.id}: ${live.stage} is waiting; no device to push to`)
    return
  }
  try {
    await deps.notify.send({
      title: `${live.mockup.name}: ${live.stage} ready`,
      body: 'Tap to review.',
      path: `/m/mockups/${live.mockup.id}/${live.stage}`,
      tag: `mockups-gate-${live.mockup.id}-${live.stage}`,
    })
  } catch (error) {
    deps.log.warn(`mockup ${live.mockup.id}: the gate push failed (${error instanceof Error ? error.name : 'unknown'})`)
  }
}

/** The family's implementation: what `mockups` fills the link with, LAST in `start` (D1). */
export function createSubmitTool(deps: SubmitDeps): AgentToolImpl {
  return {
    tools: () => [TOOL, CHECK_TOOL],
    call: async (input) => {
      if (input.name !== SUBMIT_STAGE && input.name !== CHECK_REAL_DATA) return refuse(`The mockups module has no tool called ${input.name}.`)
      try {
        if (input.name === CHECK_REAL_DATA) return await checkRealData(deps, input.sessionId, input.siteId, input.raw)
        return await submit(deps, input.sessionId, input.siteId, input.raw)
      } catch (error) {
        deps.log.error(`submit_stage failed unexpectedly (${codeOf(error)}, ${error instanceof Error ? error.name : 'unknown'})`)
        return refuse('The mockups module could not take the submission right now. Tell the owner in your reply.')
      }
    },
  }
}
