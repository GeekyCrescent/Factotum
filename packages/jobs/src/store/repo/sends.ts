/** The `sends` rows (design D3, D9): one per `(application_id, kind)`, owned by an application. */

import type { Send } from '../../types.ts'
import type { Queries } from '../db.ts'
import { flag, json, numberOrNull, text, textOrNull, type Row } from './rows.ts'

export const toSend = (row: Row): Send => ({
  kind: text(row, 'kind') as Send['kind'],
  followupId: textOrNull(row, 'followup_id'),
  channel: text(row, 'channel') as Send['channel'],
  messageId: textOrNull(row, 'message_id'),
  state: text(row, 'state') as Send['state'],
  at: text(row, 'at'),
  response: textOrNull(row, 'response'),
  reason: textOrNull(row, 'reason'),
  addressOverride: row.address_override === 1,
  profileVersion: numberOrNull(row, 'profile_version'),
  artifactsVersion: numberOrNull(row, 'artifacts_version'),
  attempts: json(row, 'attempts', []),
})

export const sendsOf = (q: Queries, applicationId: string): readonly Send[] =>
  q
    .all<Row>(
      "SELECT * FROM sends WHERE application_id = ? ORDER BY CASE kind WHEN 'initial' THEN 0 WHEN 'followup-1' THEN 1 ELSE 2 END",
      applicationId,
    )
    .map(toSend)

/** One row per `(application_id, kind)` (v5, X6): «Retry» UPDATEs it, never a second INSERT. */
export function upsertSend(q: Queries, applicationId: string, send: Send): void {
  q.run(
    `INSERT INTO sends (application_id, kind, followup_id, channel, message_id, state, at, response, reason, address_override, profile_version, artifacts_version, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (application_id, kind) DO UPDATE SET
       followup_id = excluded.followup_id, channel = excluded.channel, message_id = excluded.message_id, state = excluded.state,
       at = excluded.at, response = excluded.response, reason = excluded.reason, address_override = excluded.address_override,
       profile_version = excluded.profile_version, artifacts_version = excluded.artifacts_version, attempts = excluded.attempts`,
    applicationId,
    send.kind,
    send.followupId,
    send.channel,
    send.messageId,
    send.state,
    send.at,
    send.response,
    send.reason,
    flag(send.addressOverride),
    send.profileVersion,
    send.artifactsVersion,
    JSON.stringify(send.attempts),
  )
}

/** The `at` of every `smtp` row not `failed` changed since `since`, of any application and kind: the daily cap's raw count (E2). */
export const smtpSendTimesSince = (q: Queries, since: string): readonly string[] =>
  q
    .all<Row>("SELECT at FROM sends WHERE channel = 'smtp' AND state <> 'failed' AND at >= ? ORDER BY at", since)
    .map((row) => text(row, 'at'))

/**
 * How many `sending` rows started before `before`, of an application that is not the test one: sends
 * whose step 3 never got written (review 1a). The next start makes them `send-unknown`; until then the
 * owner is told.
 */
export const sendingBefore = (q: Queries, before: string): number =>
  Number(q.get<Row>("SELECT count(*) AS n FROM sends s JOIN applications a ON a.id = s.application_id WHERE s.state = 'sending' AND s.at < ? AND a.test = 0", before)?.n ?? 0)
