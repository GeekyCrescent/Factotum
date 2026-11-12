/**
 * A stage's documents, read from the vault NOW (criterion 25): the frontmatter as a list of keys, the
 * body through the shared Markdown (`modules/shared/markdown/`, its second consumer).
 */

import { useEffect, useState } from 'preact/hooks'
import { Markdown } from '../../shared/markdown/markdown.tsx'
import type { DocFile, StageId } from '../types.ts'
import type { Api } from './contract.ts'
import { messageOf } from './launch.ts'

type Loaded = { readonly kind: 'loading' } | { readonly kind: 'ok'; readonly files: readonly DocFile[] } | { readonly kind: 'failed'; readonly message: string }

export function DocView({ api, mockupId, stage, version }: { readonly api: Api; readonly mockupId: string; readonly stage: StageId; readonly version: number }) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' })
  useEffect(() => {
    let alive = true
    setLoaded({ kind: 'loading' })
    api
      .get<{ files: readonly DocFile[] }>(`mockups/${encodeURIComponent(mockupId)}/docs/${stage}`)
      .then((answer) => alive && setLoaded({ kind: 'ok', files: answer.files }))
      .catch((cause: unknown) => alive && setLoaded({ kind: 'failed', message: messageOf(cause) }))
    return () => {
      alive = false
    }
    // `version`: a new submission is a new document to read.
  }, [api, mockupId, stage, version])

  if (loaded.kind === 'loading') return <div class="mk-skeleton" aria-busy="true" />
  if (loaded.kind === 'failed') return <p class="mk-notice mk-err">The document could not be read: {loaded.message}</p>
  if (loaded.files.length === 0) return <p class="mk-empty">No document yet. The stage writes it in the mockup folder of the vault.</p>
  return (
    <>
      {loaded.files.map((file) => (
        <article key={file.name} class="mk-doc">
          <p class="mk-cap">
            {file.name} · version {version}
          </p>
          {Object.keys(file.frontmatter).length === 0 ? null : (
            <dl class="mk-keys">
              {Object.entries(file.frontmatter).map(([key, value]) => (
                <>
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </>
              ))}
            </dl>
          )}
          <div class="s-md">
            <Markdown text={file.markdown} />
          </div>
        </article>
      ))}
    </>
  )
}
