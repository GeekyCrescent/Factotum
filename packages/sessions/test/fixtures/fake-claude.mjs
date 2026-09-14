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
 */
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const prompt = args[args.indexOf('-p') + 1] ?? ''
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

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
