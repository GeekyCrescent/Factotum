/**
 * The row helpers every query module shares (design D2): the row type, deep freezing, the column
 * readers and the «no row was touched» result. ROWS COME BACK FROZEN, all the way down.
 */

import { fail, type Result } from '../../types.ts'
import type { SqlValue } from '../db.ts'

export type Row = Readonly<Record<string, SqlValue>>

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner)
    Object.freeze(value)
  }
  return value
}

export const text = (row: Row, key: string): string => String(row[key] ?? '')
export const textOrNull = (row: Row, key: string): string | null => (row[key] === null || row[key] === undefined ? null : String(row[key]))
export const numberOrNull = (row: Row, key: string): number | null => (row[key] === null || row[key] === undefined ? null : Number(row[key]))
export const json = <T>(row: Row, key: string, fallback: T): T => (row[key] === null || row[key] === undefined ? fallback : (JSON.parse(String(row[key])) as T))
export const flag = (value: boolean): number => (value ? 1 : 0)

/** An UPDATE that touched no row: nothing was there, so no event is appended either. */
export const notFound = (entity: string): Result<void> => fail('not-found', `no such ${entity}`)
