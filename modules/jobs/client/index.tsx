/**
 * The jobs client (spec 2026-11-12-postulaciones, design D15 «Rutas del cliente»). The shell's bar
 * on top, no drawer of its own. C3 puts `jobsClient` in `apps/web/src/modules.ts`.
 *
 * WHAT `rest` MEANS: `review` is the batch (R4a). The tracker (`''`, R7), an application (`a/<id>`),
 * `companies`, `scout`, `settings` (R6) and `log` arrive with their tasks; until then they say so.
 */

import './client.css'
import type { ViewProps } from './contract.ts'
import { Review } from './review.tsx'

const REVIEW = 'review'

function JobsView(props: ViewProps) {
  if (props.rest === REVIEW) return <Review props={props} />
  return <NotYet props={props} />
}

function NotYet({ props }: { readonly props: ViewProps }) {
  return (
    <div class="j-screen">
      <div class="j-empty">
        <p>This part of Jobs is not built yet.</p>
        <button type="button" class="btn primary" onClick={() => props.navigate(REVIEW)}>
          Go to the review
        </button>
      </div>
    </div>
  )
}

export const jobsClient = { id: 'jobs', View: JobsView }
