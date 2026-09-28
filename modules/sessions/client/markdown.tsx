/**
 * Paints what `markdown.ts` parsed. Every node is a Preact element or a string, so nothing the
 * agent wrote is ever read as HTML.
 *
 * HEADINGS START AT h3: the screen's own title is the h1, and a message is inside it.
 */

import type { Block, Inline, List } from './markdown.ts'
import { blocks } from './markdown.ts'

const HEADINGS = ['h3', 'h4', 'h5', 'h6', 'h6', 'h6'] as const

export function Markdown({ text }: { readonly text: string }) {
  return <>{blocks(text).map(block)}</>
}

function block(node: Block, key: number) {
  switch (node.kind) {
    case 'para':
      return <p key={key}>{spans(node.children)}</p>
    case 'heading': {
      const Tag = HEADINGS[node.level - 1] ?? 'h6'
      return <Tag key={key}>{spans(node.children)}</Tag>
    }
    case 'code':
      return (
        <pre key={key} class="mono">
          <code>{node.value}</code>
        </pre>
      )
    case 'rule':
      return <hr key={key} />
    case 'quote':
      return <blockquote key={key}>{node.children.map(block)}</blockquote>
    case 'list':
      return <ListOf key={key} list={node} />
    case 'table':
      return (
        <div key={key} class="s-md-table">
          <table>
            <thead>
              <tr>
                {node.head.map((cell, i) => (
                  <th key={i}>{spans(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i}>{spans(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

function ListOf({ list }: { readonly list: List }) {
  const items = list.items.map((item, i) => (
    <li key={i}>
      {spans(item.children)}
      {item.sub === undefined ? null : <ListOf list={item.sub} />}
    </li>
  ))
  return list.ordered ? <ol start={list.start}>{items}</ol> : <ul>{items}</ul>
}

function spans(nodes: readonly Inline[]) {
  return nodes.map((node, key) => {
    switch (node.kind) {
      case 'text':
        return node.value
      case 'code':
        return (
          <code key={key} class="mono">
            {node.value}
          </code>
        )
      case 'strong':
        return <strong key={key}>{spans(node.children)}</strong>
      case 'em':
        return <em key={key}>{spans(node.children)}</em>
      case 'link':
        return (
          <a key={key} href={node.href} target="_blank" rel="noopener noreferrer">
            {spans(node.children)}
          </a>
        )
    }
  })
}
