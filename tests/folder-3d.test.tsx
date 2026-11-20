import { expect, test } from 'claude-code/testing'
import { DARK, packFiles } from '../hooks/map'
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
