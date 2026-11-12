import assert from 'node:assert/strict'
import { test } from 'node:test'

import { tempBase } from '../test-support.ts'
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

test('unparsed: a "## " heading that is not "## N. Title", in a package or in the kit, is in the report with its line count', async () => {
  const ads = `${await fixture(ADS)}\n\n## Appendix\n\nOne line.\nTwo lines.\n`
  const report = await dryRunWith({ [ADS]: ads })
  assert.deepEqual(report.unparsed, [
    { file: 'kit.md', heading: 'How to use this pack', lines: 1 },
    { file: ADS, heading: 'Appendix', lines: 2 },
  ])
})
