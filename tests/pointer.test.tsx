import type { On } from 'claude-code'
import type { Mounted } from 'claude-code/testing'
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

const fileCell = async (
  ui: Mounted<'desktop' | 'terminal', 'Pane' | 'AbovePrompt'>,
) => {
  const columns = 160
  const rows = 80
  await ui.resize({ columns, rows, in: 'map-hit' })
  const source = (await mapSource(ui)) ?? ''
  const frame = viewBoxOf(source)
  expect(frame).toBeDefined()
  for (const circle of circlesIn(source, frame!)) {
    const cell = {
      x: Math.min(
        columns - 1,
        Math.max(
          0,
          Math.round(((circle.x - frame!.x) / frame!.w) * columns - 0.5),
        ),
      ),
      y: Math.min(
        rows - 1,
        Math.max(
          0,
          Math.round(((circle.y - frame!.y) / frame!.h) * rows - 0.5),
        ),
      ),
    }
    const fine = { x: cell.x + 0.5, y: cell.y + 0.5 }
    await ui.pointer({ type: 'move', ...cell, fine, in: 'map-hit' })
    const tip = (await ui.find({ type: 'Text', in: 'map-hit' }))?.text.trim()
    if (tip) return { cell, fine, tip }
  }
  throw new Error('No file dot found in the mounted map')
}

test(
  'a map dot opens its selected file in preview and a drag pans',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const previewOpened = new Promise<void>((resolve) => {
      on(
        'state.set',
        { plugin: 'brain-trail-v2', key: 'tab' },
        async (_$, e, next) => {
          const result = await next(e)
          if (result.value?.isSet && e.value === 'files') resolve()
          return result
        },
      )
    })
    const { ui, host } = await mountReady($, on, MAP)
    host.seed('settings', {
      openMd: 'preview',
      openOther: 'preview',
      hover: true,
      band: true,
    })
    await ui.redraw()
    const { cell, fine, tip } = await fileCell(ui)
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
    await host.fileRead
    await previewOpened
    expect(host.preparedFiles).toEqual(host.readFiles)
    expect(host.readFiles).toHaveLength(1)
    expect(host.readFiles[0]?.endsWith(`/${tip}`)).toBe(true)
    await ui.redraw()
    expect(await ui.find({ key: 'preview-back' })).toBeDefined()
    await ui.press({ key: 't-map' })
    await ui.redraw()
    await ui.resize({ columns: 160, rows: 80, in: 'map-hit' })

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
    await ui.redraw()
    const after = viewBoxOf(await mapSource(ui))
    expect(before).toBeDefined()
    expect(after).toBeDefined()
    expect(after!.x).not.toBe(before!.x)
    await ui.unmount()
  },
)

test('middle and right clicks on a map file never open it', async ($, on: On) => {
  const { ui, host } = await mountReady($, on, MAP)
  try {
    host.seed('settings', {
      openMd: 'preview',
      openOther: 'preview',
      hover: true,
      band: true,
    })
    await ui.redraw()
    const { cell, fine, tip } = await fileCell(ui)
    await ui.pointer({ type: 'move', ...cell, fine, in: 'map-hit' })
    expect((await ui.find({ type: 'Text', in: 'map-hit' }))?.text.trim()).toBe(
      tip,
    )
    for (const button of ['middle', 'right'] as const) {
      await ui.pointer({ type: 'down', ...cell, button, fine, in: 'map-hit' })
      await ui.pointer({ type: 'up', ...cell, button, fine, in: 'map-hit' })
      await host.clock.settle()
      await ui.redraw()
      expect(await ui.find({ key: 'map-hit' })).toBeDefined()
      expect(host.readFiles).toHaveLength(0)
      expect(host.preparedFiles).toHaveLength(0)
      expect(host.opened).toHaveLength(0)
    }
    await ui.pointer({ type: 'move', ...cell, fine, in: 'map-hit' })
    expect((await ui.find({ type: 'Text', in: 'map-hit' }))?.text.trim()).toBe(
      tip,
    )
    await ui.pointer({
      type: 'down',
      ...cell,
      button: 'left',
      fine,
      in: 'map-hit',
    })
    await ui.pointer({
      type: 'up',
      ...cell,
      button: 'right',
      fine,
      in: 'map-hit',
    })
    await ui.pointer({
      type: 'up',
      ...cell,
      button: 'left',
      fine,
      in: 'map-hit',
    })
    await host.clock.settle()
    await ui.redraw()
    expect(await ui.find({ key: 'map-hit' })).toBeDefined()
    expect(host.readFiles).toHaveLength(0)
    expect(host.preparedFiles).toHaveLength(0)
    expect(host.opened).toHaveLength(0)
  } finally {
    host.disconnectRelay()
    await ui.unmount()
  }
})
