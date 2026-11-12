import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { mapSource, viewBoxOf } from './fixtures/mounted'
import { mountReady, mountTarget, type ViewCase } from './fixtures/views'

const DESKTOP: ViewCase = {
  id: 'layout',
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

const pane = mountTarget(DESKTOP)

// The native test tree exposes containment, not the host's pixel layout.
const framed = async (ui: { find: (q: { key: string }) => Promise<unknown> }) =>
  (await ui.find({ key: 'pane-body' })) !== undefined

const expectFooter = async (ui: {
  find: (q: {
    key?: string
    type?: string
    text?: string
  }) => Promise<{ props: Record<string, unknown> } | undefined>
}) => {
  expect(await ui.find({ key: 'map-legend' })).toBeDefined()
  const credit = await ui.find({
    type: 'Link',
    text: 'unkillablecompanies.com',
  })
  expect(credit?.props.href).toBe('https://unkillablecompanies.com')
}

const boxStamp = async (ui: {
  find: (q: {
    key: string
  }) => Promise<{ props: Record<string, unknown> } | undefined>
}) => {
  const client = await ui.find({ key: 'map-hit' })
  const props = client?.props.props as { box?: unknown } | undefined
  if (typeof props?.box !== 'string') throw new Error('map client has no frame')
  return props.box
}

test('desktop map keeps reframing after a terminal pane renders', async ($, on: On) => {
  const { ui } = await mountReady($, on, DESKTOP)
  await ui.resize({ columns: 50, rows: 20, in: 'map-hit' })
  const before = viewBoxOf(await mapSource(ui))
  expect(before).toBeDefined()

  const terminal = await $.ui.mount(
    mountTarget({ ...DESKTOP, id: 'layout-terminal', surface: 'terminal' }),
  )
  expect(await terminal.findAll({ type: 'Svg' })).toEqual([])
  await ui.resize({ columns: 50, rows: 28, in: 'map-hit' })
  const after = viewBoxOf(await mapSource(ui))
  expect(after).toBeDefined()
  expect(after!.h / after!.w).toBeGreaterThan(before!.h / before!.w)
  await terminal.unmount()
  await ui.unmount()
})

test('an old frame report cannot reframe the resized desktop map', async ($, on: On) => {
  const { ui } = await mountReady($, on, DESKTOP)
  const oldFrame = await boxStamp(ui)
  await ui.redraw({ ...pane.props, bodyColumns: 80 })
  const before = viewBoxOf(await mapSource(ui))
  expect(before).toBeDefined()
  await ui.post(
    { kind: 'box', columns: 30, rows: 8, for: oldFrame },
    { in: 'map-hit' },
  )
  expect(viewBoxOf(await mapSource(ui))).toEqual(before)
  await ui.unmount()
})

test('a wide, shallow map remains framed', async ($, on: On) => {
  const { ui } = await mountReady($, on, DESKTOP)
  await ui.redraw({ ...pane.props, bodyColumns: 80 })
  expect(await framed(ui)).toBe(true)
  await ui.resize({ columns: 80, rows: 12, in: 'map-hit' })
  expect(await framed(ui)).toBe(true)
  await expectFooter(ui)
  await ui.unmount()
})

test('a zero-height map remains framed, and widening restores its paint', async ($, on: On) => {
  const { ui } = await mountReady($, on, DESKTOP)
  expect(await framed(ui)).toBe(true)
  await ui.resize({ columns: 60, rows: 0, in: 'map-hit' })
  expect(await framed(ui)).toBe(true)
  await expectFooter(ui)
  // The test surface does not lay out the Client when pane props change.
  // Model the host's positive measurement as well as its wider pane.
  await ui.resize({ columns: 80, rows: 24, in: 'map-hit' })
  await ui.redraw({ ...pane.props, bodyColumns: 80 })
  expect(await framed(ui)).toBe(true)
  await expectFooter(ui)
  await ui.unmount()
})

test('a zero-row dock stays bounded and restores the pane when rows return', async ($, on: On) => {
  const { ui } = await mountReady($, on, DESKTOP)
  await ui.redraw({
    ...pane.props,
    scroll: { ...pane.props.scroll, bodyRows: 0 },
  })
  const zero = await ui.drawn()
  if (zero.type !== 'Box') throw new Error('expected a bounded Box')
  expect(zero.props?.height).toBe(0)
  expect(zero.props?.overflow).toBe('hidden')
  await ui.redraw(pane.props)
  expect(await framed(ui)).toBe(true)
  await expectFooter(ui)
  await ui.unmount()
})

test('body pages clamp and last follows later content measurements', async ($, on: On) => {
  const { ui } = await mountReady($, on, {
    ...DESKTOP,
    id: 'body-pages',
    tab: 'goal',
  })
  await ui.resize({ columns: 0, rows: 10, in: 'viewport-probe' })
  await ui.resize({ columns: 0, rows: 30, in: 'content-probe' })
  await ui.press({ key: 'body-last' })
  expect((await ui.find({ key: 'body-content' }))?.props.top).toBe(-21)
  await ui.resize({ columns: 0, rows: 40, in: 'content-probe' })
  await ui.resize({ columns: 0, rows: 50, in: 'content-probe' })
  expect((await ui.find({ key: 'body-content' }))?.props.top).toBe(-41)
  await ui.press({ key: 'body-previous' })
  expect((await ui.find({ key: 'body-content' }))?.props.top).toBe(-31)
  await ui.press({ key: 'body-first' })
  await ui.press({ key: 'body-previous' })
  expect(
    Math.abs(Number((await ui.find({ key: 'body-content' }))?.props.top)),
  ).toBe(0)
  await ui.unmount()
})

test('chrome notice keeps its probes alive and recovers after a smaller measurement', async ($, on: On) => {
  const { ui } = await mountReady($, on, DESKTOP)
  await ui.resize({ columns: 0, rows: 20, in: 'header-probe' })
  await ui.resize({ columns: 0, rows: 20, in: 'footer-probe' })
  expect(await ui.find({ text: /Enlarge the pane/ })).toBeDefined()
  await ui.resize({ columns: 0, rows: 4, in: 'header-probe' })
  await ui.resize({ columns: 0, rows: 3, in: 'footer-probe' })
  expect(await ui.find({ key: 'pane-body' })).toBeDefined()
  await ui.unmount()
})

test('terminal pane rendering preserves desktop pagination and overflow scroll passes through', async ($, on: On) => {
  on('ui.scroll', () => ({}))
  const scenario = { ...DESKTOP, id: 'cross-surface', tab: 'goal' as const }
  const { ui } = await mountReady($, on, scenario)
  await ui.resize({ columns: 0, rows: 10, in: 'viewport-probe' })
  await ui.resize({ columns: 0, rows: 30, in: 'content-probe' })
  await ui.press({ key: 'body-next' })
  const terminal = await $.ui.mount(
    mountTarget({ ...scenario, id: 'terminal', surface: 'terminal' }),
  )
  await terminal.redraw()
  await ui.press({ key: 'body-next' })
  expect((await ui.find({ key: 'body-content' }))?.props.top).toBe(-20)
  await $.ui.scroll({
    component: 'Pane',
    requestId: 'brain-trail-v2',
    offset: 5,
    by: 5,
    bodyRows: 40,
    contentRows: 100,
    origin: { kind: 'person' },
  })
  expect((await ui.find({ key: 'body-content' }))?.props.top).toBe(-20)
  await $.ui.scroll({
    component: 'Pane',
    requestId: 'brain-trail-v2',
    offset: 0,
    by: -40,
    bodyRows: 40,
    contentRows: 40,
    origin: { kind: 'person' },
  })
  expect((await ui.find({ key: 'body-content' }))?.props.top).toBe(-10)
  await terminal.unmount()
  await ui.unmount()
})

test('a saturated resize temporarily clamps the view but retains the requested position', async ($, on: On) => {
  const { ui } = await mountReady($, on, {
    ...DESKTOP,
    id: 'resize-body',
    tab: 'goal',
  })
  await ui.resize({ columns: 0, rows: 10, in: 'viewport-probe' })
  for (const rows of [40, 80, 160, 320, 500])
    await ui.resize({ columns: 0, rows, in: 'content-probe' })
  for (let i = 0; i < 30; i++) await ui.press({ key: 'body-next' })
  expect((await ui.find({ key: 'body-content' }))?.props.top).toBe(-300)
  await ui.redraw({ ...pane.props, bodyColumns: 61 })
  await ui.resize({ columns: 0, rows: 10, in: 'viewport-probe' })
  await ui.resize({ columns: 0, rows: 40, in: 'content-probe' })
  expect((await ui.find({ key: 'body-content' }))?.props.top).toBe(-31)
  // A rerender with the same old client size is not proof of completion.
  await ui.redraw()
  expect((await ui.find({ key: 'body-content' }))?.props.top).toBe(-31)
  for (const rows of [80, 160, 320, 500])
    await ui.resize({ columns: 0, rows, in: 'content-probe' })
  expect((await ui.find({ key: 'body-content' }))?.props.top).toBe(-300)
  await ui.unmount()
})

test('last remains reachable when natural content exactly equals the first probe reach', async ($, on: On) => {
  const { ui } = await mountReady($, on, {
    ...DESKTOP,
    id: 'exact-reach',
    tab: 'goal',
  })
  await ui.resize({ columns: 0, rows: 10, in: 'viewport-probe' })
  await ui.resize({ columns: 0, rows: 40, in: 'content-probe' })
  await ui.redraw()
  await ui.press({ key: 'body-last' })
  expect((await ui.find({ key: 'body-content' }))?.props.top).toBe(-31)
  await ui.unmount()
})

test('wheel over the enlargement notice cannot zoom the hidden map', async ($, on: On) => {
  on('ui.scroll', () => ({}))
  const { ui } = await mountReady($, on, DESKTOP)
  await ui.resize({ columns: 60, rows: 20, in: 'map-hit' })
  await ui.pointer({ type: 'move', x: 20, y: 8, in: 'map-hit' })
  const before = viewBoxOf(await mapSource(ui))
  await ui.resize({ columns: 0, rows: 20, in: 'header-probe' })
  await ui.resize({ columns: 0, rows: 20, in: 'footer-probe' })
  expect(await ui.find({ text: /Enlarge the pane/ })).toBeDefined()
  await $.ui.scroll({
    component: 'Pane',
    requestId: 'brain-trail-v2',
    offset: 0,
    by: -1,
    bodyRows: 40,
    contentRows: 40,
    origin: { kind: 'person' },
    pointer: { column: 1, row: 1 },
  })
  await ui.resize({ columns: 0, rows: 4, in: 'header-probe' })
  await ui.resize({ columns: 0, rows: 3, in: 'footer-probe' })
  expect(viewBoxOf(await mapSource(ui))).toEqual(before)
  await ui.unmount()
})

// The SDK test host needs explicit redraws to expose each visible transition.
for (const hide of ['notice', 'tab'] as const) {
  for (const spinning of [true, false]) {
    test(`hiding a dragged 3D map by ${hide} restores ${spinning ? 'running' : 'paused'} spin`, async ($, on: On) => {
      const { ui } = await mountReady($, on, {
        ...DESKTOP,
        id: `drag-${hide}-${spinning}`,
        view3d: true,
      })
      try {
        if (!spinning) {
          await ui.press({ key: 'spin' })
          await ui.redraw()
        }
        await ui.press({ key: 'zoom-in' })
        await ui.redraw()
        await ui.resize({ columns: 36, rows: 16, in: 'map-hit' })
        await ui.pointer({
          type: 'down',
          x: 4,
          y: 4,
          button: 'left',
          in: 'map-hit',
        })
        await ui.pointer({
          type: 'move',
          x: 12,
          y: 6,
          button: 'left',
          in: 'map-hit',
        })
        await ui.redraw()
        expect((await ui.find({ key: 'spin' }))?.text).toBe('▶')
        const dragged = await mapSource(ui)
        if (hide === 'notice') {
          await ui.resize({ columns: 0, rows: 20, in: 'header-probe' })
          await ui.resize({ columns: 0, rows: 20, in: 'footer-probe' })
          expect(await ui.find({ text: /Enlarge the pane/ })).toBeDefined()
          await ui.resize({ columns: 0, rows: 4, in: 'header-probe' })
          await ui.resize({ columns: 0, rows: 3, in: 'footer-probe' })
        } else {
          await ui.press({ key: 't-goal' })
          await ui.redraw()
          expect(await ui.find({ key: 'spin' })).toBeUndefined()
          await ui.press({ key: 't-map' })
          await ui.redraw()
        }
        expect((await ui.find({ key: 'spin' }))?.text).toBe(
          spinning ? '❚❚' : '▶',
        )
        // Pausing again lets the SVG compare the final yaw, pitch and zoom directly.
        if (spinning) {
          await ui.press({ key: 'spin' })
          await ui.redraw()
        }
        expect(await mapSource(ui)).toBe(dragged)
      } finally {
        await ui.unmount()
      }
    })
  }
}

test('switching to 2D during a 3D drag clears the transient pause', async ($, on: On) => {
  const { ui } = await mountReady($, on, {
    ...DESKTOP,
    id: 'drag-mode',
    view3d: true,
  })
  try {
    await ui.resize({ columns: 36, rows: 16, in: 'map-hit' })
    await ui.pointer({
      type: 'down',
      x: 4,
      y: 4,
      button: 'left',
      in: 'map-hit',
    })
    await ui.pointer({
      type: 'move',
      x: 12,
      y: 6,
      button: 'left',
      in: 'map-hit',
    })
    await ui.redraw()
    expect((await ui.find({ key: 'spin' }))?.text).toBe('▶')
    await ui.press({ key: 'view-3d' })
    await ui.redraw()
    expect((await ui.find({ key: 'view-3d' }))?.text).toBe('3D')
    await ui.pointer({ type: 'up', x: 12, y: 6, button: 'left', in: 'map-hit' })
    await ui.press({ key: 'view-3d' })
    await ui.redraw()
    expect((await ui.find({ key: 'spin' }))?.text).toBe('❚❚')
  } finally {
    await ui.unmount()
  }
})
