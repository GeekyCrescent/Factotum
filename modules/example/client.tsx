/**
 * The reference module's screen.
 *
 * `api` arrives already prefixed to `/modules/example/`, so this cannot call another
 * module's routes by accident — the client-side half of the rule that a module only
 * lives under its own prefix.
 */

import { useEffect, useState } from 'preact/hooks'

interface Ping {
  readonly greeting: string
  readonly ticks: number
  readonly since: string
}

interface Props {
  readonly api: { get: <T>(path: string) => Promise<T> }
}

function ExampleView({ api }: Props) {
  const [ping, setPing] = useState<Ping | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let live = true
    void api
      .get<Ping>('ping')
      .then((value) => { if (live) setPing(value) })
      .catch((cause: unknown) => { if (live) setError(String(cause)) })
    return () => { live = false }
  }, [api])

  if (error !== undefined) return <p class="notice">{error}</p>
  if (ping === undefined) return <p>…</p>

  return (
    <>
      <h1>{ping.greeting}</h1>
      <p>
        The background task has ticked <strong>{ping.ticks}</strong> time{ping.ticks === 1 ? '' : 's'}
        {ping.ticks > 0 ? ` since ${new Date(ping.since).toLocaleString()}` : ''}.
      </p>
      <p>
        This module does nothing useful on purpose. Copy <code>modules/example/</code> and make it
        yours — see <code>docs/writing-a-module.md</code>.
      </p>
    </>
  )
}

export const exampleClient = { id: 'example', View: ExampleView }
