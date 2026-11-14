/** The versions of an application's artifacts (design D5). */

import type { Artifacts } from '../../types.ts'
import type { Queries } from '../db.ts'
import { deepFreeze, json, textOrNull, type Row } from './rows.ts'

type ArtifactContent = Pick<Artifacts, 'cv' | 'letter' | 'form' | 'skills' | 'linkedin' | 'origin'>

/**
 * A version of an application's artifacts. It carries NO event of its own: a version is the content
 * of the event that made it (`imported` of the seed, `prepared` of a generation), written beside it in
 * the same `tx` by the same caller.
 */
export function insertArtifacts(q: Queries, applicationId: string, a: Artifacts, now: Date): void {
  const content: ArtifactContent = { cv: a.cv, letter: a.letter, form: a.form, skills: a.skills, linkedin: a.linkedin, origin: a.origin }
  q.run(
    `INSERT INTO artifacts (application_id, version, content, pdf, png, contact_hash, profile_version, rules, usage, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    applicationId,
    a.version,
    JSON.stringify(content),
    a.pdf,
    a.png,
    a.contactHash,
    a.profileVersion,
    JSON.stringify(a.rules),
    a.usage === null ? null : JSON.stringify(a.usage),
    now.toISOString(),
  )
}

export function getArtifacts(q: Queries, applicationId: string, version: number): Artifacts | undefined {
  const row = q.get<Row>('SELECT * FROM artifacts WHERE application_id = ? AND version = ?', applicationId, version)
  if (row === undefined) return undefined
  const content = json<ArtifactContent>(row, 'content', { cv: null, letter: null, form: [], skills: null, linkedin: null, origin: 'seed' })
  return deepFreeze({
    version: Number(row.version),
    cv: content.cv,
    pdf: textOrNull(row, 'pdf'),
    png: textOrNull(row, 'png'),
    contactHash: textOrNull(row, 'contact_hash'),
    letter: content.letter,
    form: content.form,
    skills: content.skills,
    linkedin: content.linkedin,
    profileVersion: Number(row.profile_version),
    rules: json(row, 'rules', []),
    usage: json(row, 'usage', null),
    origin: content.origin,
  })
}
