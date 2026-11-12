// Map pointer geometry in the frame the map last drew. The gauge SVG stays in the adapter.

export type MapFrame = {
  vx: number
  vy: number
  vw: number
  vh: number
  px: number
}

// zooms by `f` (under 1 = closer) around (fx, fy) of the frame. null = the frame is the whole map again.
export const zoomFrame = (
  v: MapFrame,
  fx: number,
  fy: number,
  f: number,
  size: number,
) => {
  const X = v.vx + fx * v.vw,
    Y = v.vy + fy * v.vh
  const side = Math.max(70, Math.min(v.vw, v.vh) * f)
  if (side >= size * 1.02) return null
  return { x: X - fx * side, y: Y - fy * side, side }
}

// the frame a drag started from, moved by the distance the pointer went
export const panFrame = (
  b: { vx: number; vy: number; vw: number; vh: number },
  dx: number,
  dy: number,
) => {
  const side = Math.min(b.vw, b.vh)
  return {
    x: b.vx + (b.vw - side) / 2 - dx * b.vw,
    y: b.vy + (b.vh - side) / 2 - dy * b.vh,
    side,
  }
}

export const pickAt = <
  G extends { depth: number; tx: number; ty: number; r: number; ry: number },
>(
  files: readonly (readonly [number, number])[],
  groups: readonly G[],
  view: MapFrame,
  touched: { has(n: number): boolean },
  fx: number,
  fy: number,
) => {
  const X = view.vx + fx * view.vw,
    Y = view.vy + fy * view.vh
  // a file Claude touched answers from further away than the others: it is the one people look for
  let best: { n: number; d: number } | undefined
  files.forEach(([x, y], n) => {
    const d = Math.hypot(x - X, y - Y) / (touched.has(n) ? 2.2 : 1)
    if (d < 9 * view.px && (best === undefined || d < best.d)) best = { n, d }
  })
  const folder = groups
    .filter(
      (g) =>
        g.depth > 0 && ((g.tx - X) / g.r) ** 2 + ((g.ty - Y) / g.ry) ** 2 < 1,
    )
    .sort((a, z) => z.depth - a.depth)[0]
  return { file: best?.n, folder, X, Y }
}
