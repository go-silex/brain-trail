import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { mapSource, viewBoxOf } from './fixtures/mounted'
import { mountReady, type ViewCase } from './fixtures/views'

const MAP: ViewCase = {
  id: 'replay',
  component: 'Pane',
  surface: 'desktop',
  theme: 'dark',
  lang: 'en',
  tab: 'map',
  phase: 'ready',
  view3d: false,
  browser3d: false,
  transition: 'none',
}
const dots = (source: string) =>
  [...source.matchAll(/<circle\b([^>]*?)\/?>/g)]
    .map((raw) => {
      const attrs = raw[1] ?? ''
      return `${/(?:^|\s)cx="([^"]+)"/.exec(attrs)?.[1] ?? ''},${/(?:^|\s)cy="([^"]+)"/.exec(attrs)?.[1] ?? ''}`
    })
    .sort()
    .join('|')
const scene = async (ui: {
  findAll: (q: {
    type: 'Svg'
  }) => Promise<{ props: { alt?: unknown; source?: unknown } }[]>
}) => (await mapSource(ui)) ?? ''

test('replay changes the drawn map, not only the step counter', async ($, on: On) => {
  const { ui } = await mountReady($, on, MAP)
  const live = await scene(ui)
  expect(live.length).toBeGreaterThan(0)
  await ui.press({ key: 'play' })
  const first = await scene(ui)
  expect(first).not.toBe(live)
  expect(dots(first)).not.toBe(dots(live))
  await ui.press({ key: 'fwd' })
  const second = await scene(ui)
  expect(second).not.toBe(first)
  await ui.press({ key: 'live' })
  expect(viewBoxOf(await scene(ui))).toEqual(viewBoxOf(live))
  await ui.unmount()
})
