import { expect, test } from 'claude-code/testing'

import { createMapRenderer, DARK, packFiles } from '../hooks/map'
import type { Trail } from '../types/model'

const empty: Trail = {
  state: new Map(),
  moves: [],
  calls: [],
  perSvc: new Map(),
}
const opts = {
  zoomed: false,
  widthPx: 900,
  now: 1000,
  outside: 0,
  filesWord: 'files',
  services: [],
}

test('full directory paths enclose their files at every depth', async () => {
  const files = [
    'catalog/brain-trail/hooks/a.ts',
    'catalog/brain-trail/hosts/native/a.ts',
    'catalog/brain-trail/hosts/browser/b.ts',
    'catalog/brain-trail/hosts/relay/c.ts',
    'catalog/brain-trail/tests/a.ts',
    'root.md',
  ]
  const layout = packFiles(files, 'workspace')
  expect(layout.files.map((f) => f[0])).toEqual(files)
  for (const path of [
    'catalog',
    'catalog/brain-trail',
    'catalog/brain-trail/hooks',
    'catalog/brain-trail/hosts/native',
    'catalog/brain-trail/hosts/browser',
    'catalog/brain-trail/hosts/relay',
    'catalog/brain-trail/tests',
  ]) {
    const group = layout.groups.find((g) => g.path === path)!
    expect(group.depth).toBe(path.split('/').length)
    const matching = layout.files.filter((f) => f[0].startsWith(`${path}/`))
    expect(matching.length).toBeGreaterThan(0)
    for (const [, x, y] of matching) {
      expect(Math.hypot(x - group.x, y - group.y)).toBeLessThanOrEqual(
        group.r + 1e-6,
      )
    }
  }
  expect(layout.groups.find((g) => g.path === '·')?.n).toBe(1)
})

test('wrapper and branch labels are drawn without overlapping', async () => {
  const files = [
    'hooks',
    'hosts/native',
    'hosts/browser',
    'hosts/relay',
    'tests',
  ].flatMap((folder) =>
    Array.from(
      { length: 20 },
      (_, i) => `catalog/brain-trail/${folder}/${i}.ts`,
    ),
  )
  const { svg } = createMapRenderer().draw(
    packFiles(files, 'workspace'),
    empty,
    DARK,
    opts,
  )
  const labels = [
    ...svg.matchAll(
      /<text class="l fn" x="([\d.-]+)" y="([\d.-]+)" font-size="([\d.-]+)"[^>]*>([^<]+)<\/text>/g,
    ),
  ]
  for (const name of ['CATALOG / brain-trail', 'hooks', 'hosts', 'tests']) {
    expect(labels.some((m) => m[4] === name)).toBe(true)
  }
  const boxes = labels.map((m) => {
    const x = Number(m[1])
    const y = Number(m[2])
    const fs = Number(m[3])
    const w = m[4]!.length * fs * 0.62
    return { x: x - w / 2, y: y - fs, w, h: fs * 1.3 }
  })
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!
      const b = boxes[j]!
      expect(
        a.x < b.x + b.w - 0.2 &&
          b.x < a.x + a.w - 0.2 &&
          a.y < b.y + b.h - 0.2 &&
          b.y < a.y + a.h - 0.2,
      ).toBe(false)
    }
  }
})

test('deep nesting does not recurse or produce an oversized SVG', async () => {
  const path = `${Array.from({ length: 2000 }, (_, i) => `d${i}`).join('/')}/file.ts`
  const layout = packFiles([path], 'workspace')
  expect(layout.groups.at(-1)?.path).toBe(path.slice(0, -'/file.ts'.length))
  const { svg } = createMapRenderer().draw(layout, empty, DARK, opts)
  expect(
    encodeURIComponent(svg).replace(/%[A-F\d]{2}/g, 'x').length,
  ).toBeLessThanOrEqual(131_072)
})
