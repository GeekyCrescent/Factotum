#!/usr/bin/env node
/**
 * A stand-in for the `claude` binary, so the runner can be tested without spending
 * quota and without the network.
 *
 * It speaks the same `stream-json` the real CLI was measured emitting in block A. What
 * it does is chosen by the PROMPT it is given, which is the argument after `-p`:
 *
 *   "quick"      one tool call, one message, a successful result. Then exits.
 *   "linger"     the same, then spawns a GRANDCHILD that sleeps for a minute and
 *                holds stdout open — which is the shape that makes killing only the
 *                child insufficient — and then sleeps itself.
 *   "noise"      valid stream-json mixed with lines that are not JSON at all.
 *   "boom"       writes to stderr and exits non-zero.
 *   "traps"      catches SIGTERM and exits with 143 instead of dying from the signal.
 *                That is what the REAL CLI looks like from outside, and the difference
 *                matters: a finalizer that inferred cancellation from the exit status
 *                would call this one "failed: exited with code 143".
 *
 * SUBAGENTS (spec 2026-10-01-subagentes-visibles). These REPLAY a stream recorded from the real CLI
 * 2.1.286, next to this script, instead of the made-up session above — so they branch before it:
 *
 *   "subagent-bg"     replays `stream-subagent-bg-2.1.286.jsonl` (a background subagent, two
 *                     `result`s) and exits 0.
 *   "subagent-kill"   replays `stream-subagent-fg-2.1.286.jsonl` up to and including its
 *                     `task_started`, then waits. On SIGTERM it writes the one line the real CLI
 *                     wrote when its group was killed — `task_updated` with `killed`, and NO
 *                     `task_notification` — and exits 143, like "traps".
 *
 * QUESTIONS (spec 2026-10-01-preguntas-con-opciones, criterion 42). Also branches before `session()`:
 *
 *   "ask-then-exit"   waits until its session's log (next to the `--settings` file) holds a
 *                     `questions` `asked` — the test plays the MCP call — and then ends its turn and
 *                     exits 0 WITHOUT waiting for the answer: a process that ends with a batch open.
 *   "service-then-exit" the same, waiting for a `service` event instead: the test plays `start_service`,
 *                     and the turn ends with the service still running (spec 2026-10-02, criterion 16).
 *
 * THE LIST THE CLI ANNOUNCES (spec 2026-10-03-skills-a-mano, D2). Both play "quick", but their `init`
 * is the real line of CLI 2.1.288 (`init-2.1.288.json`, trimmed) instead of the made-up one:
 *
 *   "announce"        that `init` once.
 *   "announce-twice"  that `init` twice, as a CLI that restarted its stream would.
 *
 * Every session turn also appends its argv, as one JSON line, to `argv.log` in the session's directory.
 *
 * THE TITLER (spec 2026-09-30, D6). Called with `--tools`, which a session never passes, it plays
 * the titler instead: it appends `{ owner, pid }` to `./titler-calls.log` IN ITS CWD — the titler's
 * own directory, where no session ever runs, so that file exists only if the titler was started —
 * and answers by the text after the FIRST "\n\nowner: ":
 *
 *   "title:ok"          <title>Plan de maratón</title>
 *   "title:none"        <title>NO TITLE.</title>
 *   "title:preamble"    a preamble and a suffix around the tag
 *   "title:boom"        stderr, exit 1
 *   "title:hang"        sleeps a minute
 *   "title:slow:<ms>"   waits <ms>, then answers like "title:ok"
 *   anything else       <title>NO TITLE</title> — so a session test's `quick` titles nothing
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const args = process.argv.slice(2)
const prompt = args[args.indexOf('-p') + 1] ?? ''
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

if (args.includes('--tools')) {
  const marker = '\n\nowner: '
  const at = prompt.indexOf(marker)
  const owner = at === -1 ? '' : prompt.slice(at + marker.length)
  // One JSON line per call: what it was asked, and its pid, so a test can watch it die.
  appendFileSync('titler-calls.log', `${JSON.stringify({ owner, pid: process.pid })}\n`)
  const answer = (text) => process.stdout.write(text, () => process.exit(0))
  if (owner.startsWith('title:boom')) {
    process.stderr.write('fake-claude: the titler broke\n')
    process.exit(1)
  } else if (owner.startsWith('title:hang')) {
    setTimeout(() => answer('<title>Too late</title>'), 60_000)
  } else if (owner.startsWith('title:slow:')) {
    setTimeout(() => answer('<title>Plan de maratón</title>'), Number(owner.slice('title:slow:'.length)) || 0)
  } else if (owner.startsWith('title:ok')) {
    answer('<title>Plan de maratón</title>')
  } else if (owner.startsWith('title:none')) {
    answer('<title>NO TITLE.</title>')
  } else if (owner.startsWith('title:preamble')) {
    answer('Sure!\n<title>Foo bar</title>\nHope it helps')
  } else {
    answer('<title>NO TITLE</title>')
  }
} else if (prompt.startsWith('subagent-')) {
  subagent()
} else if (prompt.startsWith('ask-then-exit')) {
  askThenExit()
} else if (prompt.startsWith('service-then-exit')) {
  askThenExit('"kind":"service"')
} else {
  session()
}

function askThenExit(needle = '"phase":"asked"') {
  emit({ type: 'system', subtype: 'init', tools: ['mcp__factotum__ask_owner'] })
  const log = join(dirname(args[args.indexOf('--settings') + 1] ?? '.'), 'events.jsonl')
  const started = Date.now()
  const poll = setInterval(() => {
    const text = existsSync(log) ? readFileSync(log, 'utf8') : ''
    if (!text.includes(needle) && Date.now() - started < 10_000) return
    clearInterval(poll)
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'leaving' }] } })
    emit({ type: 'result', subtype: 'success', result: 'leaving' })
    process.stdout.write('', () => process.exit(0))
  }, 20)
}

function recorded(name) {
  const file = new URL(`./stream-subagent-${name}-2.1.286.jsonl`, import.meta.url)
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
}

function subagent() {
  if (prompt.startsWith('subagent-bg')) {
    for (const line of recorded('bg')) process.stdout.write(`${line}\n`)
    return
  }
  // subagent-kill
  const lines = recorded('fg')
  const started = lines.findIndex((line) => JSON.parse(line).subtype === 'task_started')
  const taskId = JSON.parse(lines[started]).task_id
  for (const line of lines.slice(0, started + 1)) process.stdout.write(`${line}\n`)
  process.on('SIGTERM', () => {
    emit({ type: 'system', subtype: 'task_updated', task_id: taskId, patch: { status: 'killed', end_time: Date.now() } })
    process.stdout.write('', () => process.exit(143))
  })
  setTimeout(() => emit({ type: 'result', subtype: 'success', result: 'late' }), 60_000)
}

function session() {
  // The argv of each turn, one JSON line, next to the `--settings` file (the session's directory):
  // so a test can tell a first turn's `--agent` from a reply's without it (spec 2026-10-03, criterion 7).
  const settings = args.indexOf('--settings')
  // Only when it is a session's own settings.json: some tests hand the runner a stand-in path.
  const file = args[settings + 1] ?? ''
  if (settings !== -1 && basename(file) === 'settings.json') appendFileSync(join(dirname(file), 'argv.log'), `${JSON.stringify(args)}\n`)

const toolUse = {
  type: 'assistant',
  message: {
    content: [
      { type: 'tool_use', id: 'toolu_fake_1', name: 'Write', input: { file_path: '/work/site/a.txt', content: 'HI\n' } },
    ],
  },
}
const toolResult = {
  type: 'user',
  message: { content: [{ tool_use_id: 'toolu_fake_1', type: 'tool_result', content: 'File created successfully' }] },
}
const text = { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }

if (prompt.startsWith('boom')) {
  process.stderr.write('fake-claude: something went wrong\n')
  process.exit(3)
}

if (prompt.startsWith('announce')) {
  const init = JSON.parse(readFileSync(new URL('./init-2.1.288.json', import.meta.url), 'utf8'))
  emit(init)
  if (prompt.startsWith('announce-twice')) emit(init)
} else {
  emit({ type: 'system', subtype: 'init', tools: ['Write'] })
}
emit(toolUse)
emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })
emit(toolResult)

if (prompt.startsWith('noise')) {
  process.stdout.write('this line is not json at all\n')
  process.stdout.write('{"truncated": \n')
}

emit(text)

if (prompt.startsWith('traps')) {
  process.on('SIGTERM', () => process.exit(143))
  setTimeout(() => emit({ type: 'result', subtype: 'success', result: 'late' }), 60_000)
} else if (prompt.startsWith('linger')) {
  // A grandchild that inherits stdout. This is the reason the runner kills the GROUP:
  // killing the child alone leaves this running with the pipe still open.
  spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'inherit' })
  setTimeout(() => {
    emit({ type: 'result', subtype: 'success', result: 'late' })
  }, 60_000)
} else {
  emit({ type: 'result', subtype: 'success', result: 'done' })
}
}
