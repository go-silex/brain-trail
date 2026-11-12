import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { mapSource, viewBoxOf } from './fixtures/mounted'
import { mountReady, type ViewCase } from './fixtures/views'

const MAP: ViewCase = {
  id: 'pointer',
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

const circlesIn = (
  source: string,
  box: { x: number; y: number; w: number; h: number },
) => {
  const seen = new Set<string>()
  const out: { x: number; y: number }[] = []
  for (const match of source.matchAll(/<circle\b([^>]*?)\/?>/g)) {
    const attrs = match[1] ?? ''
    const cx = /(?:^|\s)cx="([^"]+)"/.exec(attrs)?.[1]
    const cy = /(?:^|\s)cy="([^"]+)"/.exec(attrs)?.[1]
    if (cx === undefined || cy === undefined) continue
    const x = Number(cx)
    const y = Number(cy)
    if (x < box.x || x > box.x + box.w || y < box.y || y > box.y + box.h)
      continue
    const key = `${x.toFixed(1)},${y.toFixed(1)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ x, y })
  }
  return out
}

test('a cell-centre pointer on a mounted map dot names that file and opens it; a drag pans', async ($, on: On) => {
  const { ui, host } = await mountReady($, on, MAP)
  const columns = 160
  const rows = 80
  await ui.resize({ columns, rows, in: 'map-hit' })
  const source = (await mapSource(ui)) ?? ''
  const box = viewBoxOf(source)
  expect(box).toBeDefined()
  const frame = box!
  const cellAt = (mx: number, my: number) => ({
    x: Math.min(
      columns - 1,
      Math.max(0, Math.round(((mx - frame.x) / frame.w) * columns - 0.5)),
    ),
    y: Math.min(
      rows - 1,
      Math.max(0, Math.round(((my - frame.y) / frame.h) * rows - 0.5)),
    ),
  })
  let tip: string | undefined
  let cell = { x: 0, y: 0 }
  for (const circle of circlesIn(source, frame)) {
    cell = cellAt(circle.x, circle.y)
    const fine = { x: cell.x + 0.5, y: cell.y + 0.5 }
    await ui.pointer({
      type: 'move',
      x: cell.x,
      y: cell.y,
      fine,
      in: 'map-hit',
    })
    const shown = (await ui.find({ type: 'Text', in: 'map-hit' }))?.text.trim()
    if (shown !== undefined && shown !== '') {
      tip = shown
      break
    }
  }
  expect(tip).toBeDefined()
  const fine = { x: cell.x + 0.5, y: cell.y + 0.5 }
  await ui.pointer({
    type: 'down',
    x: cell.x,
    y: cell.y,
    button: 'left',
    fine,
    in: 'map-hit',
  })
  await ui.pointer({
    type: 'up',
    x: cell.x,
    y: cell.y,
    button: 'left',
    fine,
    in: 'map-hit',
  })
  expect(
    host.opened.some(
      (argv) =>
        argv[0] === 'open' &&
        argv.some((part) => part.endsWith(`/${tip}`) || part.endsWith(tip!)),
    ),
  ).toBe(true)

  const before = viewBoxOf(await mapSource(ui))
  await ui.pointer({
    type: 'down',
    x: 4,
    y: 4,
    button: 'left',
    fine: { x: 4.5, y: 4.5 },
    in: 'map-hit',
  })
  await ui.pointer({
    type: 'move',
    x: 20,
    y: 8,
    button: 'left',
    fine: { x: 20.5, y: 8.5 },
    in: 'map-hit',
  })
  await ui.pointer({
    type: 'up',
    x: 20,
    y: 8,
    button: 'left',
    fine: { x: 20.5, y: 8.5 },
    in: 'map-hit',
  })
  const after = viewBoxOf(await mapSource(ui))
  expect(before).toBeDefined()
  expect(after).toBeDefined()
  expect(after!.x).not.toBe(before!.x)
  await ui.unmount()
})
