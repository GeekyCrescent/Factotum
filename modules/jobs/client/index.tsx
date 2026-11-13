/**
 * The jobs client (spec 2026-11-12-postulaciones, design D15 «Rutas del cliente»). The shell's bar
 * on top, no drawer of its own. C3 puts `jobsClient` in `apps/web/src/modules.ts`.
 *
 * WHAT `rest` MEANS (`settings-route.ts`): `''` is the tracker, `review` the batch, `settings` the
 * profile, rules and import — `settings#<field>` lands on that field. An application (`a/<id>`),
 * `companies`, `scout` and `log` arrive with their tasks; until then they say so.
 */

import './client.css'
import type { ViewProps } from './contract.ts'
import { Review } from './review.tsx'
import { routeOf } from './settings-route.ts'
import { Settings } from './settings.tsx'
import { Tracker } from './tracker.tsx'

const REVIEW = 'review'

function JobsView(props: ViewProps) {
  const route = routeOf(props.rest)
  if (route.screen === 'review') return <Review props={props} />
  if (route.screen === 'settings') return <Settings props={props} anchor={route.anchor} />
  if (route.screen === 'tracker') return <Tracker props={props} />
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

/** `settings` also enters from the shell's Settings page (D15, `ModuleClient.settings`). */
export const jobsClient = { id: 'jobs', View: JobsView, settings: [{ label: 'Jobs', rest: 'settings' }] }
