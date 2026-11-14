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

test('replay advances once per 900ms across two mounted surfaces', async ($, on: On) => {
  const { ui, host } = await mountReady($, on, MAP)
  const other = await $.ui.mount(mountTarget({ ...MAP, surface: 'terminal' }))
  try {
    await ui.press({ key: 'play' })
    await ui.redraw()
    await other.redraw()
    const first = await ui.find({ type: 'Text', text: /^1\/\d+$/ })
    expect(first).toBeDefined()
    await host.clock.advance(899)
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: /^1\/\d+$/ })).toBeDefined()
    await host.clock.advance(1)
    await ui.redraw()
    await other.redraw()
    expect(await ui.find({ type: 'Text', text: /^2\/\d+$/ })).toBeDefined()
  } finally {
    if (await ui.find({ key: 'live' })) await ui.press({ key: 'live' })
    await other.unmount()
    await ui.unmount()
  }
})

test('clearing a paused replay returns new recorded steps to live', async ($, on: On) => {
  const recorded = new Promise<void>((resolve) => {
    on(
      'state.set',
      { plugin: 'brain-trail-v2', key: 'events' },
      async (_$, e, next) => {
        const applied = await next(e)
        if (
          applied.value?.isSet &&
          e.value.value.some(
            (ev) => ev.k === 'read' && ev.p === 'notes/a.md',
          ) &&
          e.value.value.some((ev) => ev.k === 'read' && ev.p === 'notes/b.md')
        )
          resolve()
        return applied
      },
    )
  })
  on('tool.call', () => ({ result: NOTE_BODY, text: NOTE_BODY }))
  const { ui } = await mountReady($, on, MAP)
  await ui.press({ key: 'play' })
  await ui.redraw()
  await ui.press({ key: 'pause' })
  await ui.redraw()
  await ui.press({ key: 'settings' })
  await ui.redraw()
  await ui.press({ key: 'clear' })
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/notes/a.md` })
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/notes/b.md` })
  await recorded
  await ui.press({ key: 't-map' })
  await ui.redraw()
  expect(await ui.find({ key: 'play' })).toBeDefined()
  expect(await ui.find({ key: 'live' })).toBeUndefined()
  const map = (await ui.findAll({ type: 'Svg' })).find(
    (el) =>
      typeof el.props.alt === 'string' &&
      el.props.alt.includes('files touched'),
  )
  expect(map?.props.alt).toContain('2 files touched')
  await ui.unmount()
})
