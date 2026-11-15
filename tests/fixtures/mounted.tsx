import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { ServerEvent } from '../../types/browser'
type SvgHit = { props: { alt?: unknown; source?: unknown } }

export const mapSourceOf = (svgs: SvgHit[]) => {
  const map = svgs.find((el) => {
    const alt = typeof el.props.alt === 'string' ? el.props.alt : ''
    const source = typeof el.props.source === 'string' ? el.props.source : ''
    return (
      alt.includes('files touched') &&
      !alt.startsWith('Unkillable Companies') &&
      /viewBox="/.test(source)
    )
  })
  return typeof map?.props.source === 'string' ? map.props.source : undefined
}

export const mapSource = async (ui: {
  findAll: (q: { type: 'Svg' }) => Promise<SvgHit[]>
}) => mapSourceOf(await ui.findAll({ type: 'Svg' }))

export const viewBoxOf = (source: string | undefined) => {
  if (source === undefined) return undefined
  const raw = /viewBox="([^"]+)"/.exec(source)?.[1]
  if (raw === undefined) return undefined
  const [x, y, w, h] = raw.split(' ').map(Number)
  if (x === undefined || y === undefined || w === undefined || h === undefined)
    return undefined
  if ([x, y, w, h].some((n) => Number.isNaN(n))) return undefined
  return { x, y, w, h }
}

export const latestSnapshot = (events: unknown[]) =>
  [...events]
    .reverse()
    .find(
      (event): event is Extract<ServerEvent, { kind: 'snapshot' }> =>
        typeof event === 'object' &&
        event !== null &&
        'kind' in event &&
        event.kind === 'snapshot',
    )

// Inspect the entire SDK render tree, including Link, Markdown and Code props.
export const renderedContains = async (
  ui: { drawn: () => Promise<unknown> },
  value: string,
) => JSON.stringify(await ui.drawn()).includes(value)

export const mountCommandOutput = async (
  $: Engine,
  surface: 'desktop' | 'terminal' = 'desktop',
  requestId = 'command-output',
) => {
  const result = await $.command.run({
    command: 'brain-trail-v2',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  return $.ui.mount({
    plugin: 'brain-trail-v2',
    component: 'CommandOutput',
    requestId,
    surface,
    props: {
      command: 'brain-trail-v2',
      args: '',
      text: result.text ?? '',
      isErrored: false,
    },
  })
}

export const mockPaneRegistry = (on: On, ids: string[], denied = false) => {
  const panes = new Set(ids)
  const closed: string[] = []
  on('ui.panes', () => ({
    value: [...panes].map((id) => ({
      id,
      title: id,
      isShown: false,
      isFocused: false,
      isPlaced: true,
    })),
  }))
  on('ui.close', (_, e) => {
    closed.push(e.id)
    if (denied) return { deny: 'close refused' }
    panes.delete(e.id)
    return { value: undefined }
  })
  return { panes, closed }
}
