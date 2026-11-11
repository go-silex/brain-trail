import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { mapSource, viewBoxOf } from './fixtures/mounted'
import { mountReady, type ViewCase } from './fixtures/views'

const MAP: ViewCase = {
  id: 'spin',
  component: 'Pane',
  surface: 'desktop',
  theme: 'dark',
  lang: 'en',
  tab: 'map',
  phase: 'ready',
  view3d: true,
  browser3d: false,
  transition: 'none',
}

const scene = async (ui: {
  findAll: (q: {
    type: 'Svg'
  }) => Promise<{ props: { alt?: unknown; source?: unknown } }[]>
}) => (await mapSource(ui)) ?? ''

test('inline 3D zoom, turn and drag change the mounted scene', async ($, on: On) => {
  const { ui } = await mountReady($, on, MAP)
  expect((await ui.find({ key: 'view-3d' }))?.text).toBe('2D')
  const first = await scene(ui)
  const wide = viewBoxOf(first)?.w
  expect(wide).toBeGreaterThan(0)
  await ui.press({ key: 'zoom-in' })
  const closer = await scene(ui)
  expect(viewBoxOf(closer)?.w).toBeLessThan(wide! * 0.8)
  await ui.press({ key: 'turn-right' })
  const turned = await scene(ui)
  expect(turned).not.toBe(closer)
  await ui.resize({ columns: 36, rows: 16, in: 'map-hit' })
  await ui.pointer({
    type: 'down',
    x: 4,
    y: 4,
    button: 'left',
    fine: { x: 4.2, y: 4.2 },
    in: 'map-hit',
  })
  await ui.pointer({
    type: 'move',
    x: 12,
    y: 6,
    button: 'left',
    fine: { x: 12.4, y: 6.3 },
    in: 'map-hit',
  })
  expect((await ui.find({ key: 'spin' }))?.text).toBe('▶')
  expect(await scene(ui)).not.toBe(turned)
  await ui.pointer({ type: 'up', x: 12, y: 6, button: 'left', in: 'map-hit' })
  expect((await ui.find({ key: 'spin' }))?.text).toBe('❚❚')
  await ui.unmount()
})
