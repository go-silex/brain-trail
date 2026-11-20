import { expect, test } from 'claude-code/testing'
import { DARK, packFiles, type Layout } from '../hooks/map'
import { CAM0 } from '../hooks/scene3d'
import { drawSpin, nativeBrain, pickSpin } from '../hooks/spin'
import type { Trail } from '../types/model'

test('native 3D projects nested folder footprints in still and spinning views', async () => {
  const paths = [
    'catalog/brain-trail/hooks/map.ts',
    'catalog/brain-trail/hooks/spin.ts',
    'catalog/brain-trail/hosts/native/pane.ts',
    'catalog/brain-trail/hosts/browser/view.ts',
    'catalog/brain-trail/tests/map.test.ts',
  ]
  const layout = packFiles(paths, 'catalog')
  const trail: Trail = {
    state: new Map(),
    moves: [],
    calls: [],
    perSvc: new Map(),
  }
  const scene = nativeBrain(layout)
  for (const [index, [path, x, y]] of layout.files.entries()) {
    const folder = layout.groups.find(
      (g) => g.path === path.slice(0, path.lastIndexOf('/')),
    )!
    expect(Math.hypot(x - folder.x, y - folder.y)).toBeLessThanOrEqual(folder.r)
    expect(Math.abs(scene.X[index]! - (x - layout.size / 2)) < 0.001).toBe(true)
    expect(
      Math.abs(scene.Z[index]! - (y - layout.size / 2) * 1.18) < 0.001,
    ).toBe(true)
    expect(scene.Y[index]! >= Math.min(folder.depth, 6) * 10).toBe(true)
    expect(scene.Y[index]).toBeLessThanOrEqual(
      Math.min(folder.depth, 6) * 10 + 3,
    )
  }
  for (const spin of [false, true]) {
    const { svg } = drawSpin(layout, trail, DARK, {
      widthPx: 800,
      now: 0,
      cam: { ...CAM0, spin },
      follow: false,
      filesWord: 'files',
      outside: 0,
      dark: true,
    })
    for (const path of [
      'catalog/brain-trail',
      'catalog/brain-trail/hooks',
      'catalog/brain-trail/hosts',
      'catalog/brain-trail/hosts/native',
      'catalog/brain-trail/tests',
    ]) {
      const group = layout.groups.find((g) => g.path === path)
      expect(group).toBeDefined()
      expect(svg).toContain(`data-folder="${path}"`)
    }
    expect(svg).toContain('catalog / brain-trail')
    if (spin)
      expect(svg).toContain('<animateTransform attributeName="transform"')
    expect(svg.length).toBeLessThanOrEqual(131_072)
  }
  for (const yaw of [CAM0.yaw, CAM0.yaw + Math.PI / 2]) {
    const { svg, view } = drawSpin(layout, trail, DARK, {
      widthPx: 800,
      now: 0,
      cam: { ...CAM0, spin: false, yaw },
      follow: false,
      filesWord: 'files',
      outside: 0,
      dark: true,
    })
    for (const path of [
      'catalog/brain-trail/hooks',
      'catalog/brain-trail/hosts',
      'catalog/brain-trail/tests',
    ]) {
      expect(svg).toContain(`data-folder="${path}"`)
    }
    const x = scene.u[0]! * Math.cos(scene.a[0]! + yaw)
    const y =
      -scene.v[0]! * view.ce -
      scene.u[0]! * Math.sin(scene.a[0]! + yaw) * view.se
    expect(
      pickSpin(
        layout,
        view,
        0,
        (x - view.vx) / view.vw,
        (y - view.vy) / view.vh,
        new Set([0]),
      ),
    ).toBe(0)
  }
})

test('native 3D keeps branch breadcrumbs visible at default and quarter yaw', async () => {
  const folders: [string, number][] = [
    ['catalog/brain-trail/hooks/vendor', 18],
    ['catalog/brain-trail/hooks', 22],
    ['catalog/brain-trail/hosts/browser', 16],
    ['catalog/brain-trail/hosts/relay', 12],
    ['catalog/brain-trail/hosts/native', 12],
    ['catalog/brain-trail/tests/fixtures', 12],
    ['catalog/brain-trail/tests', 12],
    ['catalog/brain-trail/scripts', 16],
    ['catalog/brain-trail', 15],
    ['browser-probe-catalog', 10],
    ['', 20],
  ]
  const files = folders.flatMap(([folder, count]) =>
    Array.from(
      { length: count },
      (_, i) =>
        `${folder ? `${folder}/` : ''}file-${String(i).padStart(3, '0')}.ts`,
    ),
  )
  const layout = packFiles(files, 'workspace')
  const trail: Trail = {
    state: new Map(),
    moves: [],
    calls: [],
    perSvc: new Map(),
  }
  for (const yaw of [CAM0.yaw, CAM0.yaw + Math.PI / 2]) {
    const { svg } = drawSpin(layout, trail, DARK, {
      widthPx: 887,
      now: 10000,
      cam: { ...CAM0, spin: false, yaw, at: 10000 },
      follow: false,
      filesWord: 'files',
      outside: 0,
      dark: true,
      aspect: 885 / 887,
    })
    for (const label of [
      'catalog / brain-trail',
      'hooks / vendor',
      'tests / fixtures',
      'hosts',
    ]) {
      expect(svg).toContain(`>${label}</text>`)
    }
  }
})

test('native spinning uses bounded yaw and exact file angles for rotation and picking', async () => {
  const layout = packFiles(
    ['catalog/hooks/a.ts', 'catalog/tests/b.ts'],
    'catalog',
  )
  const scene = nativeBrain(layout)
  const trail: Trail = {
    state: new Map([[0, { k: 'read', count: 1 }]]),
    moves: [],
    calls: [],
    perSvc: new Map(),
  }
  const now = 1_800_000_000_000
  const { svg, view } = drawSpin(layout, trail, DARK, {
    widthPx: 800,
    now,
    cam: { ...CAM0, at: 0, spin: true },
    follow: false,
    filesWord: 'files',
    outside: 0,
    dark: true,
  })
  expect(view.yaw >= 0 && view.yaw < 2 * Math.PI).toBe(true)
  const angles = [...svg.matchAll(/<animateTransform[^>]*from="([^"]+)"/g)].map(
    (m) => Number(m[1]),
  )
  expect(angles.length > 0 && angles.every((a) => Math.abs(a) <= 360)).toBe(
    true,
  )
  const round = (n: number) => Math.round(n * 10) / 10
  expect(svg).toContain(`M${round(scene.X[0]!)} ${round(scene.Z[0]!)}h0`)
  for (const dt of [0, 20_000]) {
    const yaw = view.yaw + (dt * 2 * Math.PI) / 80_000
    const x = scene.u[0]! * Math.cos(scene.a[0]! + yaw)
    const y =
      -scene.v[0]! * view.ce -
      scene.u[0]! * Math.sin(scene.a[0]! + yaw) * view.se
    expect(
      pickSpin(
        layout,
        view,
        now + dt,
        (x - view.vx) / view.vw,
        (y - view.vy) / view.vh,
        new Set([0]),
      ),
    ).toBe(0)
  }
})

test('zoomed native 3D retains visible nested contours beyond forty folders', async () => {
  const files = Array.from(
    { length: 55 },
    (_, i) => `folder-${String(i).padStart(2, '0')}/file.ts`,
  )
  files.push('folder-54/nested/deeper/target.ts')
  const layout = packFiles(files, 'many')
  const trail: Trail = {
    state: new Map(),
    moves: [],
    calls: [],
    perSvc: new Map(),
  }
  const options = {
    widthPx: 800,
    now: 0,
    follow: false,
    filesWord: 'files',
    outside: 0,
    dark: true,
  }
  const cam = { ...CAM0, yaw: 0, spin: false, zoom: 12 }
  const initial = drawSpin(layout, trail, DARK, { ...options, cam })
  const scene = nativeBrain(layout),
    index = files.length - 1
  const x = scene.X[index]!,
    y = -scene.Y[index]! * initial.view.ce - scene.Z[index]! * initial.view.se
  const focused = drawSpin(layout, trail, DARK, {
    ...options,
    cam: {
      ...cam,
      pan: { x: x - initial.view.focus.x, y: y - initial.view.focus.y },
    },
  })
  expect(focused.svg).toContain('data-folder="folder-54/nested/deeper"')
  expect(focused.svg).toContain('data-folder="folder-54/nested"')
})

test('zoomed spinning scene retains the opposite folder and its incoming label', async () => {
  const layout: Layout = {
    size: 1800,
    dot: 2,
    title: 'opposites',
    files: [
      ['near/a.ts', 1300, 900],
      ['far/b.ts', 500, 900],
    ],
    groups: [
      { depth: 0, name: 'root', path: '', x: 900, y: 900, r: 600, n: 2 },
      { depth: 1, name: 'near', path: 'near', x: 1300, y: 900, r: 100, n: 1 },
      { depth: 1, name: 'far', path: 'far', x: 500, y: 900, r: 100, n: 1 },
    ],
  }
  const trail: Trail = {
    state: new Map(),
    moves: [],
    calls: [],
    perSvc: new Map(),
  }
  const opts = {
    widthPx: 800,
    now: 0,
    follow: false,
    filesWord: 'files',
    outside: 0,
    dark: true,
  }
  const base = { ...CAM0, at: 0, yaw: 0, zoom: 8, spin: true }
  const initial = drawSpin(layout, trail, DARK, { ...opts, cam: base })
  const cam = {
    ...base,
    pan: {
      x: 400 - initial.view.focus.x,
      y: -10 * initial.view.ce - initial.view.focus.y,
    },
  }
  const spinning = drawSpin(layout, trail, DARK, { ...opts, cam })
  expect(spinning.svg).toContain('data-folder="near"')
  expect(spinning.svg).toContain('data-folder="far"')
  expect(spinning.svg).toContain('<title>far</title>far</text>')
  const still = drawSpin(layout, trail, DARK, {
    ...opts,
    cam: { ...cam, spin: false },
  })
  expect(still.svg.includes('data-folder="far"')).toBe(false)
})
