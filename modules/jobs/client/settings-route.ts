/**
 * What `rest` asks for (design D15 «Rutas del cliente»). Pure. `navigate('settings#portfolio')` puts
 * the place after a «#»: the screen is before it, the anchor after, and an anchor is only ever a plain
 * field name — it goes to `getElementById`, never into a selector or the page as it came.
 */

export type Screen = 'tracker' | 'review' | 'settings' | 'other'

export interface Route {
  readonly screen: Screen
  readonly anchor: string | null
}

const SCREENS: Readonly<Record<string, Screen>> = { '': 'tracker', 'review': 'review', 'settings': 'settings' }
const ANCHOR = /^[A-Za-z]{1,40}$/

export function routeOf(rest: string): Route {
  const cut = rest.indexOf('#')
  const path = cut === -1 ? rest : rest.slice(0, cut)
  const anchor = cut === -1 ? '' : rest.slice(cut + 1)
  return { screen: SCREENS[path] ?? 'other', anchor: ANCHOR.test(anchor) ? anchor : null }
}
