import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applicationBySeedKey, getArtifacts } from '../store/repo.ts'
import { tempBase } from '../test-support.ts'
import { ok } from '../types.ts'
import { importSeed, type ImportReport } from './import.ts'
import { ADS, context, fixture, readerWith, storeWith } from './test-seed.ts'

// Review fixes of the seed import: what the parsers drop or refuse is never silent, it is in the report.

function reportOf(result: Awaited<ReturnType<typeof importSeed>>): ImportReport {
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.reason}`)
  return result.value
}

async function dryRunWith(replace: Readonly<Record<string, string>>): Promise<ImportReport> {
  using base = tempBase()
  const db = await storeWith(base)
  try {
    return reportOf(await importSeed(db, context({ readText: readerWith(replace) }), { dryRun: true }))
  } finally {
    db.close()
  }
}

test('issues: a form line that does not parse and an empty answer are reported; the empty answer is not ok', async () => {
  const ads = (await fixture(ADS)).replace(
    '- *Why do you want to work here?* —',
    '- Not a question line\n- *Anything else?*\n- *Why do you want to work here?* —',
  )
  const reader = readerWith({ [ADS]: ads })
  assert.deepEqual((await dryRunWith({ [ADS]: ads })).issues, [
    { kind: 'unparsed-form-line', file: ADS, n: 1, detail: '- Not a question line' },
    { kind: 'empty-answer', file: ADS, n: 1, detail: 'Anything else?' },
  ])
  using base = tempBase()
  const db = await storeWith(base)
  reportOf(await importSeed(db, context({ readText: reader, enqueueCv: () => ok(undefined) }), { dryRun: false }))
  const form = db.read((q) => getArtifacts(q, applicationBySeedKey(q, `${ADS}#1`)?.id ?? '', 1)?.form ?? [])
  assert.equal(form.find((f) => f.question === 'Anything else?')?.ok, false)
  assert.equal(form.find((f) => f.question === 'Why do you want to work here?')?.ok, true)
  db.close()
})

test('issues: an address the create transition refuses is invalid-address, in an entry or in the companies file', async () => {
  const replace = {
    [ADS]: (await fixture(ADS)).replace('email hr@petrel.example', 'email {hr}@petrel.example'),
    'companies.json': (await fixture('companies.json')).replace('"hello@wattle-robotics.example"', '"[hello]@wattle-robotics.example"'),
  }
  const report = await dryRunWith(replace)
  assert.deepEqual(
    report.issues.filter((i) => i.kind === 'invalid-address'),
    [
      { kind: 'invalid-address', file: 'companies.json', n: null, detail: 'Wattle Robotics: [hello]@wattle-robotics.example' },
      { kind: 'invalid-address', file: ADS, n: 5, detail: '{hr}@petrel.example' },
    ],
  )
})

test('unparsed: a "## " heading that is not "## N. Title", in a package or in the kit, is in the report with its line count', async () => {
  const ads = `${await fixture(ADS)}\n\n## Appendix\n\nOne line.\nTwo lines.\n`
  const report = await dryRunWith({ [ADS]: ads })
  assert.deepEqual(report.unparsed, [
    { file: 'kit.md', heading: 'How to use this pack', lines: 1 },
    { file: ADS, heading: 'Appendix', lines: 2 },
  ])
})
