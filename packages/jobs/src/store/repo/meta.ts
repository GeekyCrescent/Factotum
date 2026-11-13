/** `meta`: clocks such as `lastReplyPoll`. Not entity state, so no event. */

import type { Queries } from '../db.ts'
import { text, type Row } from './rows.ts'

export const getMeta = (q: Queries, key: string): string | undefined => {
  const row = q.get<Row>('SELECT value FROM meta WHERE key = ?', key)
  return row === undefined ? undefined : text(row, 'value')
}

export function setMeta(q: Queries, key: string, value: string): void {
  q.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value)
}

export function deleteMeta(q: Queries, key: string): void {
  q.run('DELETE FROM meta WHERE key = ?', key)
}
