import type { Layout } from './map'
import type { Kind, Trail } from '../types/model'

export type SceneSemantics = {
  readonly kinds: ReadonlyMap<number, Kind>
  readonly touched: ReadonlySet<number>
  readonly gaps: readonly number[]
}
export const projectSemantics = (trail: Trail): SceneSemantics => ({
  kinds: new Map([...trail.state].map(([index, state]) => [index, state.k])),
  touched: new Set(
    [...trail.state]
      .filter(([, state]) => state.k === 'read' || state.k === 'write')
      .map(([index]) => index),
  ),
  gaps: trail.moves.filter((move) => move.gap).map((move) => move.n),
})

const TAU = Math.PI * 2
const NB = 72
const rnd = (i: number) => {
  let t = Math.imul(i + 1, 2654435761) >>> 0
  t ^= t >>> 15
  t = Math.imul(t, 2246822519) >>> 0
  t ^= t >>> 13
  t = Math.imul(t, 3266489917) >>> 0
  t ^= t >>> 16
  return (t >>> 0) / 4294967296
}
const dome = (d: number, r: number) => Math.sqrt(Math.max(0, 1 - (d / r) ** 2))

// Each note in 3D (same shape as the browser view: two hemispheres, one lobe per folder),
// then as a distance from the axis (u), a height (v) and the angle of its slice.
export type Brain = {
  readonly X: Readonly<Float32Array>
  readonly Y: Readonly<Float32Array>
  readonly Z: Readonly<Float32Array>
  readonly u: Readonly<Float32Array>
  readonly v: Readonly<Float32Array>
  readonly a: Readonly<Float32Array>
  readonly b: Readonly<Int16Array>
  readonly rMax: number
  readonly yMax: number
  readonly labels: readonly Readonly<{
    name: string
    u: number
    v: number
    a: number
    b: number
    size: number
  }>[]
}
const cache = new WeakMap<Layout, Brain>()
export const sliceOf = (a: number) =>
  ((Math.round(((((a % TAU) + TAU) % TAU) / TAU) * NB) % NB) + NB) % NB
export const sliceAngle = (b: number) => (b / NB) * TAU

export const brain = (L: Layout): Brain => {
  const hit = cache.get(L)
  if (hit !== undefined) return hit
  const C = L.size / 2
  const root = L.groups.find((g) => g.depth === 0)
  const R = root?.r ?? C
  const g1 = L.groups.filter((g) => g.depth === 1),
    g2 = L.groups.filter((g) => g.depth === 2)
  const N = L.files.length
  const X = new Float32Array(N),
    Y = new Float32Array(N),
    Z = new Float32Array(N),
    u = new Float32Array(N),
    v = new Float32Array(N),
    A = new Float32Array(N),
    b = new Int16Array(N)
  const top = new Map<(typeof g1)[number], number>()
  L.files.forEach(([, x, y], i) => {
    const a = g1.find((g) => Math.hypot(g.x - x, g.y - y) <= g.r),
      s = g2.find((g) => Math.hypot(g.x - x, g.y - y) <= g.r)
    let px = x - C,
      pz = (y - C) * 1.18
    px += Math.sign(px) * 46 // the two hemispheres
    let py = R * 0.34 * dome(Math.hypot(x - C, y - C), R)
    if (a) py += a.r * 0.5 * dome(Math.hypot(a.x - x, a.y - y), a.r)
    if (s)
      py +=
        (rnd(i) - 0.5) * 2 * s.r * 0.8 * dome(Math.hypot(s.x - x, s.y - y), s.r)
    else if (a)
      py +=
        (rnd(i) - 0.5) * a.r * 0.35 * dome(Math.hypot(a.x - x, a.y - y), a.r)
    px += (rnd(i * 7 + 1) - 0.5) * 6
    pz += (rnd(i * 13 + 2) - 0.5) * 6
    X[i] = px
    Y[i] = py
    Z[i] = pz
    u[i] = Math.hypot(px, pz)
    v[i] = py
    A[i] = Math.atan2(pz, px)
    b[i] = sliceOf(A[i]!)
    if (a) top.set(a, Math.max(top.get(a) ?? 0, py))
  })
  let rMax = 1,
    yMax = 1
  for (let i = 0; i < N; i++) {
    rMax = Math.max(rMax, u[i]!)
    yMax = Math.max(yMax, v[i]!)
  }
  const labels = g1
    .filter((g) => top.has(g))
    .map((g) => {
      let px = g.x - C
      const pz = (g.y - C) * 1.18
      px += Math.sign(px) * 46
      const name =
        g.name.charAt(0).toUpperCase() + g.name.slice(1).toLowerCase()
      return {
        name,
        u: Math.hypot(px, pz),
        v: top.get(g)! + 26,
        a: Math.atan2(pz, px),
        b: sliceOf(Math.atan2(pz, px)),
        size: g.r,
      }
    })
    .sort((p, q) => q.size - p.size)
    .slice(0, 11)
  const out = { X, Y, Z, u, v, a: A, b, rMax, yMax, labels }
  cache.set(L, out)
  return out
}
