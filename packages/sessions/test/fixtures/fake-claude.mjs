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
import { appendFileSync } from 'node:fs'

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
} else {
  session()
}

function session() {

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

emit({ type: 'system', subtype: 'init', tools: ['Write'] })
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
