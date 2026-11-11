import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { mapSource, viewBoxOf } from './fixtures/mounted'
import {
  CWD,
  mountReady,
  mountTarget,
  NOTE_BODY,
  type ViewCase,
} from './fixtures/views'

const SETTINGS: ViewCase = {
  id: 'settings',
  component: 'Pane',
  surface: 'desktop',
  theme: 'dark',
  lang: 'en',
  tab: 'settings',
  phase: 'ready',
  view3d: false,
  browser3d: false,
  transition: 'none',
}

const EVENTS = { plugin: 'brain-trail-v2', key: 'events' } as const

const readRecorded = (on: On) =>
  new Promise<void>((resolve) => {
    on('state.set', EVENTS, async (_$, e, next) => {
      const applied = await next(e)
      if (
        applied.value?.isSet &&
        e.value.value.some((ev) => ev.k === 'read' && ev.p === 'notes/a.md')
      )
        resolve()
      return applied
    })
  })

test('language, band and hover survive a reload, and hover changes the map tip', async ($, on: On) => {
  const read = readRecorded(on)
  on('tool.call', () => ({ result: NOTE_BODY, text: NOTE_BODY }))
  const { ui, host } = await mountReady($, on, SETTINGS)
  await ui.press({ key: 'lang-fr' })
  await ui.redraw()
  await ui.press({ key: 'band-off' })
  await ui.redraw()
  await ui.press({ key: 'hover-off' })
  await ui.redraw()
  host.forget()
  host.seed('meter', { window: 200_000, percent: 42, tokens: 84_000, usd: 1.2 })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await ui.redraw()
  expect((await ui.find({ key: 't-map' }))?.text).toBe('CARTE')
  const band = await $.ui.mount(
    mountTarget({
      ...SETTINGS,
      id: 'band',
      component: 'AbovePrompt',
      tab: 'map',
    }),
  )
  expect(await band.findAll({ type: 'Svg' })).toEqual([])
  await band.unmount()

  await ui.press({ key: 'settings' })
  await ui.redraw()
  await ui.press({ key: 'hover-on' })
  await ui.redraw()
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/notes/a.md` })
  await read
  await ui.press({ key: 't-map' })
  await ui.redraw()
  const columns = 160
  const rows = 80
  await ui.resize({ columns, rows, in: 'map-hit' })
  const source = (await mapSource(ui)) ?? ''
  const box = viewBoxOf(source)
  expect(box).toBeDefined()
  const frame = box!
  let cell = { x: 0, y: 0 }
  let tip: string | undefined
  for (const match of source.matchAll(/<circle\b([^>]*?)\/?>/g)) {
    const attrs = match[1] ?? ''
    const cx = Number(/(?:^|\s)cx="([^"]+)"/.exec(attrs)?.[1])
    const cy = Number(/(?:^|\s)cy="([^"]+)"/.exec(attrs)?.[1])
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue
    if (
      cx < frame.x ||
      cx > frame.x + frame.w ||
      cy < frame.y ||
      cy > frame.y + frame.h
    )
      continue
    cell = {
      x: Math.min(
        columns - 1,
        Math.max(0, Math.round(((cx - frame.x) / frame.w) * columns - 0.5)),
      ),
      y: Math.min(
        rows - 1,
        Math.max(0, Math.round(((cy - frame.y) / frame.h) * rows - 0.5)),
      ),
    }
    await ui.pointer({ type: 'move', x: cell.x, y: cell.y, in: 'map-hit' })
    const shown = (await ui.find({ type: 'Text', in: 'map-hit' }))?.text.trim()
    if (shown !== undefined && shown !== '') {
      tip = shown
      break
    }
  }
  expect(tip).toBe('a.md')
  await ui.press({ key: 'settings' })
  await ui.redraw()
  await ui.press({ key: 'hover-off' })
  await ui.redraw()
  await ui.press({ key: 't-map' })
  await ui.redraw()
  await ui.resize({ columns, rows, in: 'map-hit' })
  await ui.pointer({ type: 'move', x: cell.x, y: cell.y, in: 'map-hit' })
  expect(await ui.find({ type: 'Text', in: 'map-hit' })).toBeUndefined()
  await ui.unmount()
})
