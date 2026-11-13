/**
 * The CV attached to an initial is a regular `.pdf` file under `<stateDir>/artifacts/`, by its real
 * path — never another path the store names (D9 step 2, revisión de E).
 */

import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { errorOf, valueOf } from '../test-state.ts'
import { appOf, world, write, type World, type WorldOptions } from '../test-send.ts'
import { createSender } from './send.ts'

async function within(t: { skip: (m: string) => void }, options: WorldOptions, body: (w: World) => Promise<void>): Promise<void> {
  const w = await world(options)
  if (w === null) return t.skip('openssl is not installed: the send tests need it for a throwaway CA')
  try {
    await body(w)
  } finally {
    await w.close()
  }
}

const pointPdfAt = (w: World, path: string): void => void write(w.db, (q) => q.run("UPDATE artifacts SET pdf = ? WHERE application_id = 'app-1'", path))

/** Paths the store might name that are not the module's PDF. */
function outsiders(w: World): readonly (readonly [string, string])[] {
  const outside = join(w.base.dir, 'outside.pdf')
  writeFileSync(outside, '%PDF-1.7\nnot ours\n')
  const artifacts = join(w.deps.stateDir, 'artifacts')
  symlinkSync(outside, join(artifacts, 'link.pdf'))
  writeFileSync(join(artifacts, 'notes.txt'), 'not a pdf')
  mkdirSync(join(artifacts, 'dir.pdf'))
  return [
    ['an absolute path outside the state (/etc/hosts)', '/etc/hosts'],
    ['a relative path that climbs out with ../', 'artifacts/../../outside.pdf'],
    ['an absolute path to a PDF outside artifacts/', outside],
    ['a symlink inside artifacts/ to a file outside', join(artifacts, 'link.pdf')],
    ['a file under artifacts/ that is not .pdf', join(artifacts, 'notes.txt')],
    ['a directory named .pdf', join(artifacts, 'dir.pdf')],
    ['the artifacts directory itself', 'artifacts'],
  ]
}

describe('the CV is confined to <stateDir>/artifacts (D9 step 2, revisión de E)', () => {
  test('step 1: any other path → blocked missing-cv, no row, nothing sent', async (t) => {
    await within(t, {}, async (w) => {
      for (const [name, path] of outsiders(w)) {
        pointPdfAt(w, path)
        errorOf(createSender(w.deps).approve('app-1', 'initial'), 'blocked', 'missing-cv')
        assert.deepEqual(appOf(w.db).sends, [], name)
      }
      assert.equal(w.inputs.length, 0)
    })
  })

  test('step 2: a row in flight whose PDF now names another path → failed missing-cv, nothing attached nor sent', async (t) => {
    await within(t, {}, async (w) => {
      write(w.db, (q) => {
        q.run("UPDATE applications SET state = 'sending' WHERE id = 'app-1'")
        q.run("INSERT INTO sends (application_id, kind, channel, message_id, state, at, profile_version, artifacts_version) VALUES ('app-1', 'initial', 'smtp', '<m@jobs.factotum.local>', 'sending', '2026-11-13T22:00:00.000Z', 1, 1)")
      })
      pointPdfAt(w, '/etc/hosts')
      const sender = createSender(w.deps)
      sender.launch('app-1', 'initial')
      await sender.settled()
      assert.equal(appOf(w.db).sends[0]?.state, 'failed')
      assert.equal(appOf(w.db).sends[0]?.reason, 'missing-cv')
      assert.equal(w.inputs.length, 0)
      assert.equal(w.server.messages.length, 0)
    })
  })

  test('the PDF under artifacts/, absolute or relative to stateDir, goes attached by its real path', async (t) => {
    for (const relative of [false, true]) {
      await within(t, {}, async (w) => {
        if (relative) pointPdfAt(w, 'artifacts/app-1/v1/cv.pdf')
        const sender = createSender(w.deps)
        valueOf(sender.approve('app-1', 'initial'))
        await sender.settled()
        assert.equal(appOf(w.db).state, 'sent')
        assert.equal(w.inputs[0]?.attachment?.path, w.pdf)
        assert.ok((w.server.messages[0] ?? '').includes('application/pdf'))
      })
    }
  })
})
