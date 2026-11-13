import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { mapSource, viewBoxOf } from './fixtures/mounted'
import { mountReady, type ViewCase } from './fixtures/views'
import { packFiles, DARK } from '../hooks/map'
import { CAM0, drawSpin } from '../hooks/spin'
import {
  cameraDuringGesture,
  GESTURE0,
  mapGesture,
  parseGesture,
} from '../hooks/view-controller'
import { panFrame } from '../hooks/pointer'
import type { Trail } from '../types/model'

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

test('a hover or click ends a 3D drag when dragend was replaced', () => {
  const layout = packFiles(['notes/a.md'], 'Example')
  const trail: Trail = {
    state: new Map(),
    moves: [],
    calls: [],
    perSvc: new Map(),
  }
  for (const spin of [true, false]) {
    for (const kind of ['hover', 'click', 'leave'] as const) {
      let cam3d = { ...CAM0, spin, zoom: 2, at: 100 }
      const drawn = drawSpin(layout, trail, DARK, {
        widthPx: 480,
        now: 100,
        cam: cam3d,
        follow: false,
        filesWord: 'files',
        outside: 0,
        dark: true,
      })
      const frames = {
        d2: undefined,
        d3: { view: drawn.view, layout, touched: new Set<number>() },
      }
      const drag = mapGesture(
        { kind: 'drag', press: 1, sfx: 0.2, sfy: 0.2, fx: 0.5, fy: 0.4 },
        { view3d: true, zoomed: false, cam3d },
        GESTURE0,
        frames,
        { now: 200, hoverNames: false },
      )
      for (const step of drag.steps)
        if (step.key === 'cam3d') cam3d = step.next(cam3d)
      expect(drag.memory.drag3d).toBeDefined()
      expect(cameraDuringGesture(cam3d, drag.memory).spin).toBe(false)
      const moved = cam3d
      const event =
        kind === 'hover'
          ? ({ kind, fx: 0.5, fy: 0.4, x: 10, y: 10 } as const)
          : kind === 'click'
            ? ({ kind, fx: 0.5, fy: 0.4, right: true } as const)
            : ({ kind } as const)
      const ended = mapGesture(
        event,
        { view3d: true, zoomed: false, cam3d },
        drag.memory,
        frames,
        { now: 300, hoverNames: false },
      )
      for (const step of ended.steps)
        if (step.key === 'cam3d') cam3d = step.next(cam3d)
      expect(ended.memory.drag3d).toBeUndefined()
      expect(cameraDuringGesture(cam3d, ended.memory).spin).toBe(spin)
      expect([cam3d.yaw, cam3d.pitch, cam3d.at]).toEqual([
        moved.yaw,
        moved.pitch,
        300,
      ])
      expect(cam3d.zoom).toBe(kind === 'click' ? 2 / 1.5 : 2)
      if (kind === 'hover')
        expect(ended.memory.hover).toEqual({ fx: 0.5, fy: 0.4 })
    }
  }
})

test('drag messages require a positive safe-integer press identity', () => {
  const drag = { kind: 'drag', fx: 0.4, fy: 0.3, sfx: 0.2, sfy: 0.2 }
  expect(parseGesture(drag)).toBeUndefined()
  expect(parseGesture({ ...drag, press: 1.5 })).toBeUndefined()
  expect(
    parseGesture({ ...drag, press: Number.MAX_SAFE_INTEGER + 1 }),
  ).toBeUndefined()
  expect(parseGesture({ ...drag, press: 1 })).toEqual({ ...drag, press: 1 })
})

test('a new press starts from the latest drawn 2D and 3D frames after a lost end', () => {
  const layout = packFiles(['notes/a.md'], 'Example')
  const trail: Trail = {
    state: new Map(),
    moves: [],
    calls: [],
    perSvc: new Map(),
  }
  const cam3d = { ...CAM0, spin: false, at: 100 }
  const drawn = drawSpin(layout, trail, DARK, {
    widthPx: 480,
    now: 100,
    cam: cam3d,
    follow: false,
    filesWord: 'files',
    outside: 0,
    dark: true,
  })
  const view2d = { vx: 10, vy: 20, vw: 400, vh: 300, px: 1 }
  const nextView2d = { ...view2d, vx: 90, vy: 80 }
  const frame3d = { view: drawn.view, layout, touched: new Set<number>() }
  const firstFrames = {
    d2: { view: view2d, layout, touched: new Set<number>() },
    d3: frame3d,
  }
  const event = {
    kind: 'drag',
    press: 1,
    sfx: 0.2,
    sfy: 0.2,
    fx: 0.4,
    fy: 0.3,
  } as const
  const second = { ...event, press: 2 }
  const context = { now: 200, hoverNames: false }
  const first2d = mapGesture(
    event,
    { view3d: false, zoomed: false, cam3d },
    GESTURE0,
    firstFrames,
    context,
  )
  const next2d = mapGesture(
    second,
    { view3d: false, zoomed: false, cam3d },
    first2d.memory,
    { ...firstFrames, d2: { ...firstFrames.d2, view: nextView2d } },
    context,
  )
  const cameraStep = next2d.steps.find((step) => step.key === 'camera')
  expect(
    cameraStep?.key === 'camera' ? cameraStep.next(null) : undefined,
  ).toEqual(
    panFrame(nextView2d, second.fx - second.sfx, second.fy - second.sfy),
  )
  const first3d = mapGesture(
    event,
    { view3d: true, zoomed: false, cam3d },
    GESTURE0,
    firstFrames,
    context,
  )
  const nextView3d = { ...drawn.view, yaw: drawn.view.yaw + 1 }
  const next3d = mapGesture(
    second,
    { view3d: true, zoomed: false, cam3d },
    first3d.memory,
    { ...firstFrames, d3: { ...frame3d, view: nextView3d } },
    context,
  )
  const spinStep = next3d.steps.find((step) => step.key === 'cam3d')
  expect(spinStep?.key === 'cam3d' ? spinStep.next(cam3d).yaw : undefined).toBe(
    nextView3d.yaw + (second.fx - second.sfx) * Math.PI * 1.3,
  )
  const left = mapGesture(
    { kind: 'leave' },
    { view3d: false, zoomed: false, cam3d },
    next2d.memory,
    firstFrames,
    context,
  )
  expect(left.memory.drag2d).toBeUndefined()
})

test('leaving while the pointer is captured keeps the 3D drag until outside release', async ($, on: On) => {
  const { ui } = await mountReady($, on, MAP)
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
    await ui.pointer({ type: 'leave', x: 12, y: 6, in: 'map-hit' })
    await ui.redraw()
    expect((await ui.find({ key: 'spin' }))?.text).toBe('▶')
    await ui.pointer({ type: 'up', x: 40, y: 6, button: 'left', in: 'map-hit' })
    await ui.redraw()
    expect((await ui.find({ key: 'spin' }))?.text).toBe('❚❚')
  } finally {
    await ui.unmount()
  }
})
