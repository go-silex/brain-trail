// Map pointer geometry in the frame the map last drew. The gauge SVG stays in the adapter.

// One gesture policy for every map, applied by each renderer with its own projection:
// the wheel and a middle drag zoom, a right drag pans, a left drag pans a plane and turns a scene.
export type PointerButton = 'left' | 'middle' | 'right'
export type DragAction = 'pan' | 'orbit' | 'zoom'
export const dragAction = (
  button: PointerButton,
  scene: boolean,
): DragAction =>
  button === 'middle' ? 'zoom' : button === 'right' || !scene ? 'pan' : 'orbit'
// a DOM pointer's `button` index
export const pointerButton = (index: number): PointerButton | undefined =>
  index === 0
    ? 'left'
    : index === 1
      ? 'middle'
      : index === 2
        ? 'right'
        : undefined
const BIT = { left: 1, right: 2, middle: 4 } as const
// whether a DOM pointer's `buttons` still holds this button
export const heldIn = (button: PointerButton, buttons: number) =>
  (buttons & BIT[button]) !== 0
// whether a DOM pointer's `buttons` holds another button too: a chord, never a click
export const heldBesides = (button: PointerButton, buttons: number) =>
  (buttons & 7 & ~BIT[button]) !== 0

// A notch of the wheel is one row, wherever it turns: the pane counts rows itself,
// a browser reports about 100 pixels, 3 lines or 1 page.
export const wheelRows = (deltaY: number, deltaMode: number) =>
  deltaMode === 1 ? deltaY / 3 : deltaMode === 2 ? deltaY : deltaY / 100
// A row scales the view by this much; rows toward the person (positive) zoom out.
const ROW_ZOOM = 1.18
const WHEEL_ROWS = 4
export const wheelZoom = (rows: number) =>
  Number.isFinite(rows)
    ? Math.pow(ROW_ZOOM, Math.max(-WHEEL_ROWS, Math.min(WHEEL_ROWS, rows)))
    : 1
// A middle drag down the whole map zooms out as much as this many rows; up zooms in.
// A captured pointer reports past the map's edges: a few map heights at most count.
const DRAG_ROWS = 8
const DRAG_REACH = 3
export const dragZoom = (dy: number) =>
  Number.isFinite(dy)
    ? Math.pow(
        ROW_ZOOM,
        Math.max(-DRAG_REACH, Math.min(DRAG_REACH, dy)) * DRAG_ROWS,
      )
    : 1

type Box = { vx: number; vy: number; vw: number; vh: number }
// a drawn frame a gesture can be measured in: finite, with an area
export const usableFrame = (v: Box & { cameraFrame?: Box }): boolean =>
  Number.isFinite(v.vx) &&
  Number.isFinite(v.vy) &&
  Number.isFinite(v.vw) &&
  Number.isFinite(v.vh) &&
  v.vw > 0 &&
  v.vh > 0 &&
  (v.cameraFrame === undefined || usableFrame(v.cameraFrame))

export type MapFrame = {
  vx: number
  vy: number
  vw: number
  vh: number
  px: number
  // The frame drawn around a unit camera square, without the whole-map title.
  // Its inverse keeps pan/zoom anchored even when that title disappears.
  cameraFrame?: { vx: number; vy: number; vw: number; vh: number }
  // the frame the same map draws with no camera: the whole map
  whole: Box
}

export const fitFrame = (
  box: { vx: number; vy: number; vw: number; vh: number },
  aspect: number,
) => {
  const vw = Math.max(box.vw, box.vh / aspect)
  const vh = vw * aspect
  return {
    vx: box.vx - (vw - box.vw) / 2,
    vy: box.vy - (vh - box.vh) / 2,
    vw,
    vh,
  }
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
  if (v.cameraFrame !== undefined) {
    const c = v.cameraFrame
    const side = Math.max(70, (v.vw * f) / c.vw)
    if (f > 1 && side >= size * 1.02) return null
    return {
      x: X - (c.vx + fx * c.vw) * side,
      y: Y - (c.vy + fy * c.vh) * side,
      side,
    }
  }
  const side = Math.max(70, Math.min(v.vw, v.vh) * f)
  if (side >= size * 1.02) return null
  return { x: X - fx * side, y: Y - fy * side, side }
}

// the frame a drag started from, moved by the distance the pointer went
export const panFrame = (
  b: Pick<MapFrame, 'vx' | 'vy' | 'vw' | 'vh' | 'cameraFrame'>,
  dx: number,
  dy: number,
) => {
  if (b.cameraFrame !== undefined) {
    const c = b.cameraFrame,
      side = b.vw / c.vw
    return {
      x: b.vx - dx * b.vw - c.vx * side,
      y: b.vy - dy * b.vh - c.vy * side,
      side,
    }
  }
  const side = Math.min(b.vw, b.vh)
  return {
    x: b.vx + (b.vw - side) / 2 - dx * b.vw,
    y: b.vy + (b.vh - side) / 2 - dy * b.vh,
    side,
  }
}

// The frame a camera made from `like` (by panFrame or zoomFrame; null: the whole map) draws:
// `like`'s shape at the camera's place and size, so a gesture can go on from a camera that is
// not drawn yet.
export const frameOf = (
  cam: { x: number; y: number; side: number } | null,
  like: MapFrame,
): MapFrame => {
  const c = like.cameraFrame,
    whole = like.whole
  if (cam === null)
    return {
      ...whole,
      px: (like.px * whole.vw) / like.vw,
      ...(c !== undefined && { cameraFrame: c }),
      whole,
    }
  if (c !== undefined) {
    const vw = c.vw * cam.side
    return {
      vx: cam.x + c.vx * cam.side,
      vy: cam.y + c.vy * cam.side,
      vw,
      vh: c.vh * cam.side,
      px: (like.px * vw) / like.vw,
      cameraFrame: c,
      whole,
    }
  }
  const k = cam.side / Math.min(like.vw, like.vh),
    vw = like.vw * k,
    vh = like.vh * k
  return {
    vx: cam.x - (vw - cam.side) / 2,
    vy: cam.y - (vh - cam.side) / 2,
    vw,
    vh,
    px: like.px * k,
    whole,
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
