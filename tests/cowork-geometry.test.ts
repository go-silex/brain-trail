import { expect, test } from 'claude-code/testing'

import { packFiles } from '../hooks/map'
import { brain, stationPosition } from '../hooks/scene3d'

test('fileless connector stations are separated beyond their marker diameter', () => {
  const layout = packFiles([], 'Cowork')
  const shape = brain(layout)
  const stations = Array.from({ length: 3 }, (_, i) =>
    stationPosition(layout, shape, i, 3),
  )
  for (let i = 0; i < stations.length; i++) {
    for (let j = i + 1; j < stations.length; j++) {
      const a = stations[i]!,
        b = stations[j]!
      expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeGreaterThan(150)
    }
  }
})

test('file-backed stations retain their original geometry', () => {
  const layout = packFiles(['src/index.ts'], 'workspace')
  const shape = brain(layout)
  const position = stationPosition(layout, shape, 0, 3)
  const angle = -Math.PI / 2 - 0.55
  expect(position).toEqual({
    x: Math.cos(angle) * shape.rMax,
    y: shape.yMax + layout.size * 0.18,
    z: Math.sin(angle) * shape.rMax,
  })
})
