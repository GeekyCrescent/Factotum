/**
 * «Import the package» (design D8, D15 «Ajustes»; requirements crit. 9, 10, 10b). THE DRY RUN FIRST:
 * «Check the package» asks `POST /import { dryRun: true }` and shows the report; only then — and not
 * while the report says the phone is missing — «Import» posts the real one. A real import refused
 * with `422 missing-phone` says so, with the way to the field. One request at a time.
 */

import { useMemo, useState } from 'preact/hooks'
import type { Api, ImportReport, ImportRequest } from './contract.ts'
import { createLock, runOrSay } from './guard.ts'
import { canImport, importFailureOf, reportOf, type ImportFailure } from './import-model.ts'

export function ImportPanel({ api }: { readonly api: Api }) {
  const [report, setReport] = useState<ImportReport | null>(null)
  const [error, setError] = useState<ImportFailure | null>(null)
  const [busy, setBusy] = useState(false)
  const lock = useMemo(createLock, [])

  const run = async (dryRun: boolean): Promise<void> => {
    await runOrSay(lock, async () => {
      setBusy(true)
      setError(null)
      try {
        const body: ImportRequest = { dryRun }
        setReport(await api.post<ImportReport>('import', body))
      } catch (cause) {
        // The report it replaced no longer stands: «Import» is never offered on a stale dry run.
        setReport(null)
        setError(importFailureOf(cause))
      } finally {
        setBusy(false)
      }
    }, (text) => setError({ text, toPhone: false }))
  }

  const view = report === null ? null : reportOf(report)
  return (
    <section class="j-section" id="import">
      <h2>Import the package</h2>
      <p class="j-quiet">Reads the companies and the application files of the vault. Check first: nothing is written until you import.</p>
      <div class="j-exits">
        <button type="button" class="btn" disabled={busy} onClick={() => void run(true)}>
          {report === null ? 'Check the package' : 'Check again'}
        </button>
        {report !== null && canImport(report) ? (
          <button type="button" class="btn primary" disabled={busy} onClick={() => void run(false)}>
            Import
          </button>
        ) : null}
      </div>
      {error === null ? null : (
        <p class="j-error" role="alert">
          {error.text} {error.toPhone ? <ToPhone /> : null}
        </p>
      )}
      {view === null || report === null ? null : (
        <div class="j-report">
          <h3 class="j-doc-title" role="status">{report.dryRun ? 'Dry run: nothing written' : 'Imported'}</h3>
          {view.blocked === null ? null : (
            <p class="j-error">
              {view.blocked} <ToPhone />
            </p>
          )}
          <ul class="j-report-lines">
            {view.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {view.sections.map((section) => (
            <details key={section.title} class="j-notes">
              <summary>
                {section.title} ({section.items.length})
              </summary>
              <ul class="j-report-lines">
                {section.items.map((item, at) => (
                  <li key={at}>{item}</li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
    </section>
  )
}

function ToPhone() {
  return (
    <button type="button" class="btn sm quiet" onClick={() => document.getElementById('phone')?.scrollIntoView({ block: 'center' })}>
      Go to the phone
    </button>
  )
}
