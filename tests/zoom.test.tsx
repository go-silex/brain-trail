import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { mapSource, viewBoxOf } from './fixtures/mounted'
import { mountReady, type ViewCase } from './fixtures/views'
import { fitFrame, zoomFrame } from '../hooks/pointer'
import { createMapRenderer, DARK, packFiles } from '../hooks/map'
import { CAM0, drawSpin } from '../hooks/spin'
import type { Trail } from '../types/model'

const geometryLayout = packFiles(
  [
    'outer/a-very-long-current-note-name-for-the-pill.md',
    'inner/x.md',
    'inner/another-note.md',
  ],
  'Example',
)
const geometryTrail: Trail = {
  state: new Map([
    [0, { k: 'read', count: 3 }],
    [1, { k: 'write', count: 2 }],
  ]),
  moves: [{ n: 0, gap: false, at: 1, i: 0 }],
  calls: [],
  perSvc: new Map(),
}

test('3D camera remains fixed when the current note changes without follow', () => {
  const other: Trail = {
    ...geometryTrail,
    moves: [{ n: 1, gap: false, at: 1, i: 0 }],
  }
  for (const zoom of [1, 2.5]) {
    for (const aspect of [0.05, 0.2, 1, 2.4]) {
      const options = {
        widthPx: 480,
        now: 1000,
        cam: { ...CAM0, zoom },
        follow: false,
        filesWord: 'files',
        outside: 0,
        dark: true,
        aspect,
      }
      const first = drawSpin(geometryLayout, geometryTrail, DARK, options)
      const second = drawSpin(geometryLayout, other, DARK, options)
      expect([
        first.view.vx,
        first.view.vy,
        first.view.vw,
        first.view.vh,
      ]).toEqual([
        second.view.vx,
        second.view.vy,
        second.view.vw,
        second.view.vh,
      ])
    }
  }
})

test('3D fitted camera and glow budget stay stable as read and write counts grow', () => {
  const trail = (count: number): Trail => ({
    ...geometryTrail,
    state: new Map([
      [0, { k: 'read', count }],
      [1, { k: 'write', count }],
    ]),
  })
  for (const zoom of [1, 2.5]) {
    for (const aspect of [0.05, 0.2, 1, 2.4]) {
      const options = {
        widthPx: 480,
        now: 1000,
        cam: { ...CAM0, zoom },
        follow: false,
        filesWord: 'files',
        outside: 0,
        dark: true,
        aspect,
      }
      const low = drawSpin(geometryLayout, trail(1), DARK, options)
      const limit = drawSpin(geometryLayout, trail(15), DARK, options)
      const high = drawSpin(geometryLayout, trail(1_000_000_000), DARK, options)
      expect([high.view.vx, high.view.vy, high.view.vw, high.view.vh]).toEqual([
        low.view.vx,
        low.view.vy,
        low.view.vw,
        low.view.vh,
      ])
      const limitGlow = limit.svg.match(
        /<circle r="([^"]+)" fill="url\(#g3\)"/,
      )?.[1]
      const highGlow = high.svg.match(
        /<circle r="([^"]+)" fill="url\(#g3\)"/,
      )?.[1]
      expect(limitGlow).toBeDefined()
      expect(highGlow).toEqual(limitGlow)
    }
  }
})

test('intrinsic rendering cannot restart a fitted camera animation', () => {
  const renderer = createMapRenderer()
  const options = {
    widthPx: 480,
    now: 1000,
    zoomed: false,
    outside: 0,
    filesWord: 'files',
    services: [],
    aspect: 0.2,
  }
  renderer.draw(geometryLayout, geometryTrail, DARK, options)
  const camera = { x: 400, y: 400, side: 800 }
  const zoomed = renderer.draw(geometryLayout, geometryTrail, DARK, {
    ...options,
    now: 1100,
    box: camera,
  })
  expect(zoomed.svg.includes('attributeName="viewBox"')).toBe(true)
  renderer.draw(geometryLayout, geometryTrail, DARK, {
    ...options,
    aspect: undefined,
    now: 1150,
  })
  const resumed = renderer.draw(geometryLayout, geometryTrail, DARK, {
    ...options,
    now: 1200,
    box: camera,
  })
  expect(resumed.svg.includes('begin="-100ms"')).toBe(true)
  const resized = renderer.draw(geometryLayout, geometryTrail, DARK, {
    ...options,
    aspect: 0.05,
    now: 1250,
    box: camera,
  })
  expect(resized.svg.includes('attributeName="viewBox"')).toBe(false)
})

test('containment keeps the complete natural picture at shallow and tall aspects', () => {
  const picture = { vx: -10, vy: -196, vw: 1820, vh: 2026 }
  for (const aspect of [0.015, 0.05, 0.2, 1, 2.4]) {
    const frame = fitFrame(picture, aspect)
    expect(frame.vw).toBeGreaterThan(0)
    expect(frame.vh).toBeGreaterThan(0)
    expect(Math.abs(frame.vh / frame.vw - aspect)).toBeLessThan(1e-10)
    expect(frame.vx).toBeLessThan(picture.vx + 1e-8)
    expect(frame.vy).toBeLessThan(picture.vy + 1e-8)
    expect(frame.vx + frame.vw + 1e-8).toBeGreaterThan(picture.vx + picture.vw)
    expect(frame.vy + frame.vh + 1e-8).toBeGreaterThan(picture.vy + picture.vh)
    const cameraFrame = fitFrame({ vx: 0, vy: -0.13, vw: 1, vh: 1.13 }, aspect)
    const view = { ...frame, px: frame.vw / 800, cameraFrame }
    const fx = 0.23,
      fy = 0.71
    const camera = zoomFrame(view, fx, fy, 0.6, 1800)!
    const next = fitFrame(
      {
        vx: camera.x,
        vy: camera.y - camera.side * 0.13,
        vw: camera.side,
        vh: camera.side * 1.13,
      },
      aspect,
    )
    expect(
      Math.abs(next.vx + fx * next.vw - (frame.vx + fx * frame.vw)),
    ).toBeLessThan(1e-7)
    expect(
      Math.abs(next.vy + fy * next.vh - (frame.vy + fy * frame.vh)),
    ).toBeLessThan(1e-7)
  }
})

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

  // The kit drops fine before the handler, so gestures use cell centres.
  for (const [index, { columns, rows }] of [
    { columns: 80, rows: 24 },
    { columns: 24, rows: 60 },
  ].entries()) {
    if (index > 0) await ui.press({ key: 'whole' })
    await ui.resize({ columns, rows, in: 'map-hit' })
    for (const [x, y, endX, endY] of [
      [
        Math.floor(columns * 0.2),
        Math.floor(rows * 0.25),
        Math.floor(columns * 0.4),
        Math.floor(rows * 0.55),
      ],
      [
        Math.floor(columns * 0.65),
        Math.floor(rows * 0.7),
        Math.floor(columns * 0.45),
        Math.floor(rows * 0.4),
      ],
    ] as const) {
      const fx = (x + 0.5) / columns
      const fy = (y + 0.5) / rows
      await ui.pointer({ type: 'move', x, y, in: 'map-hit' })
      const hovered = await mapBox(ui)
      expect(hovered).toBeDefined()
      await $.ui.scroll({
        component: 'Pane',
        requestId: 'brain-trail-v2',
        offset: 0,
        by: -1,
        bodyRows: 40,
        contentRows: 80,
        origin: { kind: 'person' },
        pointer: { column: x, row: y },
      })
      const wheeled = await mapBox(ui)
      expect(wheeled).toBeDefined()
      expect(wheeled!.w).toBeLessThan(hovered!.w)
      expect(wheeled!.h).toBeLessThan(hovered!.h)
      expect(
        Math.abs(wheeled!.x + fx * wheeled!.w - (hovered!.x + fx * hovered!.w)),
      ).toBeLessThan(1.5)
      expect(
        Math.abs(wheeled!.y + fy * wheeled!.h - (hovered!.y + fy * hovered!.h)),
      ).toBeLessThan(1.5)

      await ui.pointer({ type: 'down', x, y, button: 'left', in: 'map-hit' })
      await ui.pointer({
        type: 'move',
        x: endX,
        y: endY,
        button: 'left',
        in: 'map-hit',
      })
      await ui.pointer({
        type: 'up',
        x: endX,
        y: endY,
        button: 'left',
        in: 'map-hit',
      })
      const panned = await mapBox(ui)
      expect(panned).toBeDefined()
      expect(Math.abs(panned!.w - wheeled!.w)).toBeLessThan(1.5)
      expect(Math.abs(panned!.h - wheeled!.h)).toBeLessThan(1.5)
      expect(
        Math.abs(
          panned!.x +
            ((endX + 0.5) / columns) * panned!.w -
            (wheeled!.x + fx * wheeled!.w),
        ),
      ).toBeLessThan(1.5)
      expect(
        Math.abs(
          panned!.y +
            ((endY + 0.5) / rows) * panned!.h -
            (wheeled!.y + fy * wheeled!.h),
        ),
      ).toBeLessThan(1.5)
    }
  }
  await ui.unmount()
})

test('middle drag zooms in both directions and right drag pans without zooming', async ($, on: On) => {
  const { ui } = await mountReady($, on, MAP)
  try {
    await ui.resize({ columns: 80, rows: 40, in: 'map-hit' })
    await ui.press({ key: 'zoom-in' })
    await ui.redraw()
    const initial = (await mapBox(ui))!
    await ui.pointer({
      type: 'down',
      x: 30,
      y: 20,
      button: 'middle',
      in: 'map-hit',
    })
    await ui.pointer({
      type: 'move',
      x: 30,
      y: 28,
      button: 'middle',
      in: 'map-hit',
    })
    await ui.redraw()
    const down = (await mapBox(ui))!
    await ui.pointer({
      type: 'move',
      x: 30,
      y: 12,
      button: 'middle',
      in: 'map-hit',
    })
    await ui.redraw()
    const up = (await mapBox(ui))!
    expect((down.w - initial.w) * (up.w - initial.w)).toBeLessThan(0)
    for (const frame of [down, up]) {
      expect(Number.isFinite(frame.w) && frame.w > 0).toBe(true)
      expect(Number.isFinite(frame.h) && frame.h > 0).toBe(true)
    }
    await ui.pointer({
      type: 'up',
      x: 30,
      y: 12,
      button: 'middle',
      in: 'map-hit',
    })

    const beforePan = (await mapBox(ui))!
    await ui.pointer({
      type: 'down',
      x: 20,
      y: 15,
      button: 'right',
      in: 'map-hit',
    })
    await ui.pointer({
      type: 'move',
      x: 32,
      y: 22,
      button: 'right',
      in: 'map-hit',
    })
    await ui.pointer({
      type: 'up',
      x: 32,
      y: 22,
      button: 'right',
      in: 'map-hit',
    })
    await ui.redraw()
    const panned = (await mapBox(ui))!
    expect(panned.x).not.toBe(beforePan.x)
    expect(panned.y).not.toBe(beforePan.y)
    expect(Math.abs(panned.w - beforePan.w)).toBeLessThan(1.5)
    expect(Math.abs(panned.h - beforePan.h)).toBeLessThan(1.5)
  } finally {
    await ui.unmount()
  }
})

test('a new drag after a lost release starts from the latest 2D view', async ($, on: On) => {
  const { ui } = await mountReady($, on, MAP)
  try {
    await ui.resize({ columns: 80, rows: 40, in: 'map-hit' })
    await ui.press({ key: 'zoom-in' })
    await ui.redraw()
    await ui.pointer({
      type: 'down',
      x: 20,
      y: 15,
      button: 'left',
      in: 'map-hit',
    })
    await ui.pointer({
      type: 'move',
      x: 30,
      y: 20,
      button: 'left',
      in: 'map-hit',
    })
    await ui.redraw()
    const first = (await mapBox(ui))!
    await ui.pointer({
      type: 'down',
      x: 30,
      y: 20,
      button: 'right',
      in: 'map-hit',
    })
    await ui.pointer({
      type: 'move',
      x: 38,
      y: 24,
      button: 'right',
      in: 'map-hit',
    })
    await ui.pointer({
      type: 'up',
      x: 38,
      y: 24,
      button: 'right',
      in: 'map-hit',
    })
    await ui.redraw()
    const second = (await mapBox(ui))!
    expect(
      Math.abs(
        second.x + (38.5 / 80) * second.w - (first.x + (30.5 / 80) * first.w),
      ),
    ).toBeLessThan(1.5)
    expect(
      Math.abs(
        second.y + (24.5 / 40) * second.h - (first.y + (20.5 / 40) * first.h),
      ),
    ).toBeLessThan(1.5)
    await ui.pointer({ type: 'move', x: 50, y: 30, in: 'map-hit' })
    await ui.redraw()
    expect(await mapBox(ui)).toEqual(second)
  } finally {
    await ui.unmount()
  }
})

for (const view3d of [false, true]) {
  test(`manual ${view3d ? '3D' : '2D'} navigation interrupts follow`, async ($, on: On) => {
    const { ui, host } = await mountReady($, on, { ...MAP, view3d })
    try {
      await ui.resize({ columns: 80, rows: 40, in: 'map-hit' })
      const idle = (await ui.find({ key: 'follow' }))?.text
      expect(idle).toBeDefined()
      for (const button of ['left', 'middle', 'right'] as const) {
        await ui.press({ key: 'follow' })
        await host.clock.settle()
        await ui.redraw()
        expect((await ui.find({ key: 'follow' }))?.text).not.toBe(idle)
        await ui.pointer({ type: 'down', x: 20, y: 15, button, in: 'map-hit' })
        await ui.pointer({ type: 'move', x: 30, y: 22, button, in: 'map-hit' })
        await ui.pointer({ type: 'up', x: 30, y: 22, button, in: 'map-hit' })
        await host.clock.settle()
        await ui.redraw()
        expect((await ui.find({ key: 'follow' }))?.text).toBe(idle)
      }
      await ui.press({ key: 'follow' })
      await host.clock.settle()
      await ui.redraw()
      expect((await ui.find({ key: 'follow' }))?.text).not.toBe(idle)
      await ui.pointer({ type: 'move', x: 20, y: 15, in: 'map-hit' })
      await $.ui.scroll({
        component: 'Pane',
        requestId: 'brain-trail-v2',
        offset: 0,
        by: -1,
        bodyRows: 40,
        contentRows: 80,
        origin: { kind: 'person' },
        pointer: { column: 20, row: 15 },
      })
      await host.clock.settle()
      await ui.redraw()
      expect((await ui.find({ key: 'follow' }))?.text).toBe(idle)
    } finally {
      await ui.unmount()
    }
  })
}
