/**
 * The mockups' client (spec 2026-11-12-maquetas, D9; direction B chosen in K2). Its own bar, like the
 * board.
 *
 * WHAT `rest` MEANS: `''` the gallery; `new` the form; `<id>` a mockup at its current stage;
 * `<id>/<stage>` a mockup open at that stage — the path a gate's push opens (D6). An id is a UUIDv7,
 * so it is never `new`.
 */

import './mockups.css'
import { STAGE_IDS, type StageId } from '../types.ts'
import type { ViewProps } from './contract.ts'
import { Gallery } from './gallery.tsx'
import { NewMockup } from './new-mockup.tsx'
import { Pipeline } from './pipeline.tsx'

function decoded(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

function MockupsView(props: ViewProps) {
  const { rest } = props
  if (rest === '') return <Gallery props={props} />
  if (rest === 'new') return <NewMockup props={props} />
  const [first = '', second] = rest.split('/')
  const id = decoded(first)
  if (id === undefined) return <Gallery props={props} />
  const stage = STAGE_IDS.find((s) => s === second) as StageId | undefined
  return <Pipeline key={id} props={props} id={id} open={stage} />
}

export const mockupsClient = { id: 'mockups', View: MockupsView, ownsTopBar: true }
