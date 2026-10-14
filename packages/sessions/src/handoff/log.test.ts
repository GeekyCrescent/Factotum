import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { put } from '../test-repos.ts'
import { addSession, linked } from '../test-handoff.ts'

/**
 * Criterion 36, the sessions side: the log never carries content — not a message, not a diff, not the
 * name of a file of the WIP. The phrase is sown in all three, and in an ignored collision's path too,
 * and looked for in everything both hosts logged.
 */
const SOWN = 'MURCIELAGO-QUINTO'

test('the phrase sown in a message, and in the name and the content of a WIP file, appears in NO log line of either host', async () => {
  const l = await linked()
  await put(l.w.source, `notes/${SOWN}.md`, `the secret is ${SOWN}\n`)
  await put(l.w.source, 'a.txt', `${SOWN} in a diff\n`)
  await addSession(l.mac, { siteId: 'vault', transcript: `{"said":"${SOWN}"}\n`, events: [{ kind: 'message', role: 'user', text: `remember ${SOWN}` }] })
  assert.equal((await l.mac.api.start({ to: 'omarchy' })).kind, 'ok')
  await l.mac.api.settled()

  const lines = [...l.mac.lines, ...l.omarchy.lines]
  assert.ok(lines.some((line) => line.includes('moved to omarchy')), 'the handoff was logged')
  assert.deepEqual(lines.filter((line) => line.includes(SOWN)), [])
})

test('an ignored collision names its paths in the report and NEVER in the log: how many, not which', async () => {
  const l = await linked({
    setup: async (w) => {
      await writeFile(join(w.target, '.git', 'info', 'exclude'), `${SOWN}.local\n`)
      await put(w.target, `${SOWN}.local`, 'the target’s own\n')
    },
  })
  await put(l.w.source, `${SOWN}.local`, 'from the source\n')
  await addSession(l.mac, { siteId: 'vault', transcript: 'x\n' })
  const started = await l.mac.api.start({ to: 'omarchy' })
  await l.mac.api.settled()
  const hid = started.kind === 'ok' ? (started.body as { hid: string }).hid : ''
  const report = await l.mac.api.report(hid)
  assert.match(JSON.stringify(report), new RegExp(SOWN), 'the report names it, for the owner')
  const lines = [...l.mac.lines, ...l.omarchy.lines]
  assert.ok(lines.some((line) => /1 path\(s\)/.test(line)))
  assert.deepEqual(lines.filter((line) => line.includes(SOWN)), [])
})
