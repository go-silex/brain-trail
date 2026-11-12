import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { mapSource, viewBoxOf } from './fixtures/mounted'
import { mountReady, type ViewCase } from './fixtures/views'

const MAP: ViewCase = {
  id: 'zoom',
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
const mapBox = async (ui: {
  findAll: (q: {
    type: 'Svg'
  }) => Promise<{ props: { alt?: unknown; source?: unknown } }[]>
}) => viewBoxOf(await mapSource(ui))

test('zoom-in shrinks around the centre, zoom-out grows, reset restores, and the wheel keeps the cell centre', async ($, on: On) => {
  const { ui } = await mountReady($, on, MAP)
  const before = await mapBox(ui)
  expect(before).toBeDefined()
  await ui.press({ key: 'zoom-in' })
  const closer = await mapBox(ui)
  expect(closer).toBeDefined()
  expect(closer!.w).toBeLessThan(before!.w * 0.7)
  expect(closer!.w).toBeGreaterThan(before!.w * 0.45)
  expect(
    Math.abs(closer!.x + closer!.w / 2 - (before!.x + before!.w / 2)),
  ).toBeLessThan(1.5)
  await ui.press({ key: 'zoom-out' })
  const wider = await mapBox(ui)
  expect(wider!.w).toBeGreaterThan(closer!.w)
  await ui.press({ key: 'zoom-in' })
  await ui.press({ key: 'whole' })
  expect(await mapBox(ui)).toEqual(before)

  const columns = 40
  const rows = 16
  const x = 8
  const y = 3
  // The kit drops fine before the handler, so the anchor is the cell centre hit.tsx falls back to.
  const fx = (x + 0.5) / columns
  await ui.resize({ columns, rows, in: 'map-hit' })
  await ui.pointer({
    type: 'move',
    x,
    y,
    fine: { x: x + 0.5, y: y + 0.5 },
    in: 'map-hit',
  })
  const hovered = await mapBox(ui)
  await $.ui.scroll({
    component: 'Pane',
    requestId: 'brain-trail-v2',
    offset: 0,
    by: -1,
    bodyRows: 40,
    contentRows: 80,
    origin: { kind: 'person' },
    pointer: { column: 1, row: 1 },
  })
  const wheeled = await mapBox(ui)
  expect(wheeled).toBeDefined()
  expect(wheeled!.w).toBeLessThan(hovered!.w)
  expect(
    Math.abs(wheeled!.x + fx * wheeled!.w - (hovered!.x + fx * hovered!.w)),
  ).toBeLessThan(1.5)
  await ui.unmount()
})
