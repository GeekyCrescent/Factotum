/**
 * «Import the package», as data (design D8; requirements crit. 9, 10, 10b). Pure.
 *
 * THE DRY RUN FIRST: the settings page asks `POST /import { dryRun: true }`, shows this report, and only
 * then offers the real import — and not at all while the report says the phone is missing (the real
 * one would refuse with `422 missing-phone` anyway; the screen does not offer what will be refused).
 */

import type { Channel, ImportReport } from './contract.ts'

export interface ReportSection {
  readonly title: string
  readonly items: readonly string[]
}

export interface ReportView {
  /** On top, in red: why the real import will refuse. */
  readonly blocked: string | null
  readonly lines: readonly string[]
  /** What needs a look, by kind; only the kinds with something in them. */
  readonly sections: readonly ReportSection[]
}

const BLOCKED: Readonly<Record<NonNullable<ImportReport['blocked']>, string>> = {
  'missing-phone': 'Add your phone first: without it no CV of the package is printed.',
  'missing-profile': 'There is no profile yet: save the settings first.',
}

const CHANNELS: readonly Channel[] = ['email', 'form', 'platform', 'linkedin']

const at = (entry: { readonly file: string; readonly n: number }): string => `${entry.file} #${entry.n}`

function fileLine(file: ImportReport['files'][number]): string {
  const fresh = file.existing === 0 ? `${file.new} new` : file.new === 0 ? `${file.existing} already in` : `${file.new} new, ${file.existing} already in`
  const channels = CHANNELS.filter((channel) => file.channels[channel] > 0).map((channel) => `${channel} ${file.channels[channel]}`)
  const flags = [...(file.holdUntil === null ? [] : [`held until ${file.holdUntil}`]), ...(file.byHand ? ['by hand'] : [])]
  return [`${file.file}: ${file.entries} entries, ${fresh}`, ...channels, ...flags].join(' · ')
}

export function reportOf(report: ImportReport): ReportView {
  const queued = `${report.dryRun ? 'Would queue' : 'Queued'} ${report.queued.cv} CVs and ${report.queued.checks} address checks`
  const sections: readonly ReportSection[] = [
    { title: 'Fields not read', items: report.missing.map((m) => `${at(m)}: ${m.missing.join(', ')}`) },
    { title: 'No company in the list (one is made)', items: report.unmatched.map((u) => `${at(u)}: ${u.company}`) },
    { title: 'Placeholders left', items: report.placeholders.map((p) => `${at(p)} ${p.where}: ${p.token}`) },
    { title: 'Kit answers matched loosely', items: report.kitRefs.filter((k) => k.ambiguous).map((k) => `${at(k)} «${k.question}» → §${k.section} ${k.matched ?? 'nothing'}`) },
    { title: 'Addresses taken as verified', items: report.verified.map((v) => `${at(v)}: ${v.email} (${v.evidence})`) },
    { title: 'Suggested health employers (not switched on)', items: report.companies.suggestedHealth },
    { title: 'Sent by hand', items: report.byHand.map((b) => `${at(b)}: ${b.result}`) },
    { title: 'Not sent by hand yet', items: report.byHandPending.map((p) => `${at(p)}: ${p.company}`) },
    { title: 'Issues', items: report.issues.map((i) => `${i.n === null ? i.file : `${i.file} #${i.n}`}: ${i.kind}, ${i.detail}`) },
    { title: 'Warnings', items: report.warnings },
  ]
  return {
    blocked: report.blocked === null ? null : BLOCKED[report.blocked],
    lines: [`${report.companies.read} companies, ${report.companies.created} new`, ...report.files.map(fileLine), queued],
    sections: sections.filter((section) => section.items.length > 0),
  }
}

/** The real import is offered after a dry run that found no reason to refuse. */
export const canImport = (report: ImportReport): boolean => report.dryRun && report.blocked === null
