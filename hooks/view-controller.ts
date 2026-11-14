import type { Coach, Play, PreviewRef, TrailSettings } from '../types/model'
import type { SharedView, SharedViewIntent } from '../types/view'
import type {
  DrawnFrames,
  GestureMemory,
  GestureResult,
  MapGesture,
  Step,
  ViewIntent,
  ViewState,
} from '../types/view'
import type { Strings } from './i18n'
import { BANNER_ASPECT, BANNER_MAX, fileName, SIZE, tilt } from './map'
import {
  dragAction,
  dragZoom,
  panFrame,
  pickAt,
  usableFrame,
  wheelZoom,
  zoomFrame,
  type PointerButton,
} from './pointer'
import {
  CAM0,
  PITCH_MAX,
  PITCH_MIN,
  ZOOM_MAX,
  ZOOM_MIN,
  panSpin,
  pickSpin,
  yawAt,
  yawOf,
  zoomSpin,
  type Cam,
  type SpinView,
} from './spin'

export const STEP_MS = 900
export const VIEW_STATE0: ViewState = {
  tab: 'map',
  open: [],
  zoomed: false,
  camera: null,
  play: { step: null, playing: false },
  view3d: false,
  cam3d: CAM0,
  preview: null,
}
export const GESTURE0: GestureMemory = {
  hover: undefined,
  drag2d: undefined,
  drag3d: undefined,
}
// A drawing follows the pane: one of its pixels is one pixel of the screen, at any width.
export const paneWidthPx = (columns: number) => Math.max(240, columns * 8 - 24)

// A docked pane's rows are a frame: the header on top, the footer at the bottom, the map in what
// they leave. Hosts count that room in cells; a row is this many times as tall as a column is wide
// (the desktop's line height over its cell advance, the same at both of its densities).
export const CELL_RATIO = 2.46
export type Cells = { columns: number; rows: number }
// What the header and the footer take around the map, until the host measures it: the banner (it
// grows with the pane up to its cap), then the meter, the tabs, the legend and the credit. Guessed
// generously, so the map is first drawn for a box no taller than the one it gets.
export const guessChrome = (columns: number): Cells => ({
  columns: 0,
  rows:
    Math.round(
      (Math.min(paneWidthPx(columns), BANNER_MAX) * BANNER_ASPECT) /
        (8 * CELL_RATIO),
    ) + 10,
})
export const mapCells = (pane: Cells, chrome: Cells): Cells => ({
  columns: Math.max(0, pane.columns - chrome.columns),
  rows: Math.max(0, pane.rows - chrome.rows),
})
// Measurements are rounded down to cells; use a half-cell estimate, including at zero.
export const cellAspect = (box: Cells) =>
  ((Math.max(0, box.rows) + 0.5) * CELL_RATIO) /
  (Math.max(0, box.columns) + 0.5)
// The 3D picture back on the brain's middle, the way a reset returns the 2D map to its whole.
const centred = (k: Cam): Cam =>
  k.pan.x === 0 && k.pan.y === 0 ? k : { ...k, pan: { x: 0, y: 0 } }
// Leaving a followed note by hand starts from the picture it showed: its turn, zoom and pan.
const fromDrawn = (k: Cam, v: SpinView | undefined, now: number): Cam =>
  v?.follow ? { ...k, yaw: v.yaw, at: now, zoom: v.zoom, pan: v.pan } : k
export const absOf = (index: { root: string } | undefined, ref: PreviewRef) =>
  ref.out || index === undefined ? ref.p : `${index.root}/${ref.p}`
export type OpenTarget =
  | { kind: 'preview'; ref: PreviewRef }
  | { kind: 'app'; abs: string; app: string }
export const openTarget = (
  settings: TrailSettings,
  index: { root: string } | undefined,
  ref: PreviewRef,
): OpenTarget => {
  const abs = absOf(index, ref),
    app = abs.endsWith('.md') ? settings.openMd : settings.openOther
  return app === 'preview'
    ? { kind: 'preview', ref: { p: ref.p, ...(ref.out ? { out: true } : {}) } }
    : { kind: 'app', abs, app }
}
export const plan = (
  i: ViewIntent,
  c: { now: number; frames: DrawnFrames },
): Step[] => {
  switch (i.kind) {
    case 'tab':
      return [{ key: 'tab', next: () => i.tab }]
    case 'toggle-open':
      return [
        {
          key: 'open',
          next: (l) =>
            l.includes(i.key) ? l.filter((x) => x !== i.key) : [...l, i.key],
        },
      ]
    case 'figure':
      return [
        {
          key: 'open',
          next: (l) => {
            const was = l.includes(`kpi:${i.id}`)
            const rest = l.filter((k) => !k.startsWith('kpi:'))
            return was ? rest : [...rest, `kpi:${i.id}`]
          },
        },
      ]
    case 'legend':
      return [
        {
          key: 'open',
          next: (l) => [
            ...l.filter((k) => !k.startsWith('kpi:')),
            `kpi:${i.id}`,
          ],
        },
        { key: 'tab', next: () => 'files' },
      ]
    case 'preview':
      return [
        { key: 'preview', next: () => i.ref },
        ...(i.ref === null
          ? []
          : [{ key: 'tab' as const, next: () => 'files' as const }]),
      ]
    case 'replay-play':
      return [
        {
          key: 'play',
          next: (p) => ({
            step: p.step === null || p.step >= i.steps - 1 ? 0 : p.step,
            playing: true,
          }),
        },
      ]
    case 'replay-pause':
      return [{ key: 'play', next: (p) => ({ ...p, playing: false }) }]
    case 'replay-live':
    case 'replay-reset':
      return [{ key: 'play', next: () => ({ step: null, playing: false }) }]
    case 'replay-step':
      return [
        {
          key: 'play',
          next: (p) => ({
            step: Math.max(
              0,
              Math.min(i.steps - 1, (p.step ?? i.steps - 1) + i.by),
            ),
            playing: false,
          }),
        },
      ]
    case 'toggle-3d':
      return [{ key: 'view3d', next: (v) => !v }]
    case 'follow':
      return [
        { key: 'camera', next: () => null },
        { key: 'cam3d', next: centred },
        { key: 'zoomed', next: () => !i.following },
      ]
    case 'whole':
      return [
        { key: 'camera', next: () => null },
        { key: 'cam3d', next: centred },
        { key: 'zoomed', next: () => false },
      ]
    case 'zoom-2d': {
      const frame = c.frames.d2
      return frame === undefined
        ? []
        : [
            ...(i.f === 1
              ? []
              : [{ key: 'zoomed' as const, next: () => false }]),
            {
              key: 'camera',
              next: () => zoomFrame(frame.view, i.fx, i.fy, i.f, SIZE),
            },
          ]
    }
    case 'turn-3d': {
      const v = c.frames.d3?.view
      return [
        { key: 'zoomed', next: () => false },
        {
          key: 'cam3d',
          next: (k) => {
            const from = fromDrawn(k, v, c.now)
            return { ...from, yaw: yawAt(from, c.now) + i.by, at: c.now }
          },
        },
      ]
    }
    case 'spin-3d':
      return [
        {
          key: 'cam3d',
          next: (k) => ({
            ...k,
            yaw: yawAt(k, c.now),
            spin: !k.spin,
            at: c.now,
          }),
        },
      ]
    // Zooming by hand stops following Claude, as in 2D.
    case 'zoom-3d': {
      const v = c.frames.d3?.view
      return [
        { key: 'zoomed', next: () => false },
        {
          key: 'cam3d',
          next: (k) => {
            const from = fromDrawn(k, v, c.now)
            return {
              ...from,
              zoom:
                i.dir === 'in'
                  ? Math.min(ZOOM_MAX, from.zoom * 1.5)
                  : Math.max(ZOOM_MIN, from.zoom / 1.5),
            }
          },
        },
      ]
    }
  }
}
export const isSharedViewIntent = (i: ViewIntent): i is SharedViewIntent =>
  i.kind === 'preview' ||
  i.kind === 'replay-play' ||
  i.kind === 'replay-pause' ||
  i.kind === 'replay-live' ||
  i.kind === 'replay-step' ||
  i.kind === 'replay-reset' ||
  i.kind === 'follow' ||
  i.kind === 'whole'

export const sharedView = (state: ViewState): SharedView => ({
  preview: state.preview,
  zoomed: state.zoomed,
  play: state.play,
})

export const reduceSharedView = (
  shared: SharedView,
  intent: SharedViewIntent,
  steps: number,
): SharedView => {
  if (
    steps < 1 &&
    (intent.kind === 'replay-play' || intent.kind === 'replay-step')
  )
    return { ...shared, play: { step: null, playing: false } }
  const bounded =
    intent.kind === 'replay-play' || intent.kind === 'replay-step'
      ? { ...intent, steps }
      : intent
  const next = { ...shared }
  for (const step of plan(bounded, {
    now: 0,
    frames: { d2: undefined, d3: undefined },
  })) {
    if (step.key === 'preview') next.preview = step.next(next.preview)
    else if (step.key === 'zoomed') next.zoomed = step.next(next.zoomed)
    else if (step.key === 'play') next.play = step.next(next.play)
  }
  return next
}
export const timerEffect = (i: ViewIntent): 'start' | 'stop' | 'none' =>
  i.kind === 'replay-play'
    ? 'start'
    : i.kind === 'replay-pause' ||
        i.kind === 'replay-live' ||
        i.kind === 'replay-step' ||
        i.kind === 'replay-reset'
      ? 'stop'
      : 'none'
export const replayTick =
  (steps: number) =>
  (p: Play): Play => {
    const next = (p.step ?? 0) + 1
    return next >= steps
      ? { step: steps - 1, playing: false }
      : { step: next, playing: true }
  }
// A measurement carries the exact pane/map stamp it was drawn for.
export const parseBox = (
  data: unknown,
): (Cells & { for: string; pane: Cells }) | undefined => {
  if (typeof data !== 'object' || data === null) return undefined
  const d: Record<string, unknown> = Object.fromEntries(Object.entries(data))
  if (
    d.kind !== 'box' ||
    typeof d.for !== 'string' ||
    typeof d.columns !== 'number' ||
    typeof d.rows !== 'number' ||
    !Number.isSafeInteger(d.columns) ||
    !Number.isSafeInteger(d.rows) ||
    d.columns <= 0 ||
    d.rows < 0
  )
    return undefined
  const stamp = /^(\d+)x(\d+)\/(\d+)x(\d+)$/.exec(d.for)
  if (!stamp) return undefined
  const [columns, rows, mapColumns, mapRows] = stamp.slice(1).map(Number)
  if (
    ![columns, rows].every(
      (n) => n !== undefined && Number.isSafeInteger(n) && n > 0,
    ) ||
    ![mapColumns, mapRows].every(
      (n) => n !== undefined && Number.isSafeInteger(n) && n >= 0,
    )
  )
    return undefined
  return {
    columns: d.columns,
    rows: d.rows,
    for: d.for,
    pane: { columns: columns!, rows: rows! },
  }
}
const finite = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v)
const buttonOf = (v: unknown): PointerButton | undefined =>
  v === 'left' || v === 'middle' || v === 'right' ? v : undefined
export const parseGesture = (data: unknown): MapGesture | undefined => {
  if (typeof data !== 'object' || data === null) return undefined
  const d: Record<string, unknown> = Object.fromEntries(Object.entries(data))
  if (d.kind === 'leave' || d.kind === 'dragend') return { kind: d.kind }
  if (!finite(d.fx) || !finite(d.fy)) return undefined
  if (d.kind === 'hover')
    return {
      kind: 'hover',
      fx: d.fx,
      fy: d.fy,
      x: finite(d.x) ? d.x : 0,
      y: finite(d.y) ? d.y : 0,
    }
  const button = buttonOf(d.button)
  if (button === undefined) return undefined
  if (d.kind === 'click') return { kind: 'click', fx: d.fx, fy: d.fy, button }
  if (
    d.kind === 'drag' &&
    finite(d.sfx) &&
    finite(d.sfy) &&
    typeof d.press === 'number' &&
    Number.isSafeInteger(d.press) &&
    d.press > 0
  )
    return {
      kind: 'drag',
      press: d.press,
      button,
      fx: d.fx,
      fy: d.fy,
      sfx: d.sfx,
      sfy: d.sfy,
    }
  return undefined
}
// Spin intent lives in the camera; a drag of any button pauses only its rendered projection.
export const cameraDuringGesture = (
  camera: ViewState['cam3d'],
  memory: GestureMemory,
): ViewState['cam3d'] =>
  memory.drag3d === undefined ? camera : { ...camera, spin: false }
export const mapGesture = (
  g: MapGesture | undefined,
  s: Pick<ViewState, 'view3d' | 'zoomed' | 'cam3d'>,
  m: GestureMemory,
  frames: DrawnFrames,
  c: { now: number; hoverNames: boolean },
): GestureResult => {
  // The wheel zooms around the last point the pointer was seen at over the map.
  let memory =
    g?.kind === 'leave'
      ? { ...m, hover: undefined }
      : g?.kind === 'hover' || g?.kind === 'click' || g?.kind === 'drag'
        ? { ...m, hover: { fx: g.fx, fy: g.fy } }
        : m
  const steps: Step[] = []
  const concludes =
    g?.kind === 'dragend' ||
    g?.kind === 'hover' ||
    g?.kind === 'click' ||
    g?.kind === 'leave'
  if (concludes) memory = { ...memory, drag2d: undefined }
  // Moving the camera by hand (a press's first drag, a click that zooms) stops following Claude.
  const unfollow = () => {
    if (s.zoomed) steps.push({ key: 'zoomed', next: () => false })
  }
  let tip: GestureResult['tip'] = null
  let open: PreviewRef | undefined
  if (s.view3d) {
    // A later non-drag message can replace an undelivered dragend in the client transport.
    if (memory.drag3d !== undefined && concludes) {
      memory = { ...memory, drag3d: undefined }
      steps.push({ key: 'cam3d', next: (k) => ({ ...k, at: c.now }) })
    }
    const frame = frames.d3
    if (frame !== undefined && g !== undefined) {
      if (g.kind === 'hover') {
        const n = c.hoverNames
          ? pickSpin(frame.layout, frame.view, c.now, g.fx, g.fy, frame.touched)
          : undefined
        if (n !== undefined)
          tip = { text: fileName(frame.layout.files[n]![0]), x: g.x, y: g.y }
      } else if (g.kind === 'drag') {
        // A press continues from the drawing it started on, at the turn shown then.
        let base = memory.drag3d
        if (base === undefined || base.press !== g.press) {
          base = {
            press: g.press,
            yaw: yawOf(frame.view, c.now),
            pitch: s.cam3d.pitch,
            view: frame.view,
          }
          memory = { ...memory, drag3d: base }
          if (usableFrame(base.view)) unfollow()
        }
        const b = base,
          v = b.view,
          action = dragAction(g.button, true),
          dx = g.fx - g.sfx,
          dy = g.fy - g.sfy
        if (usableFrame(v))
          steps.push({
            key: 'cam3d',
            next: (k) => ({
              ...k,
              yaw: action === 'orbit' ? b.yaw + dx * Math.PI * 1.3 : b.yaw,
              pitch:
                action === 'orbit'
                  ? Math.max(PITCH_MIN, Math.min(PITCH_MAX, b.pitch + dy * 1.4))
                  : b.pitch,
              ...(action === 'zoom'
                ? zoomSpin(v, 0.5, 0.5, dragZoom(dy))
                : {
                    zoom: v.zoom,
                    pan: action === 'pan' ? panSpin(v, dx, dy) : v.pan,
                  }),
              at: c.now,
            }),
          })
      } else if (g.kind === 'click' && g.button !== 'middle') {
        // Only the left button opens a note; elsewhere it zooms in, the right button out.
        const n =
          g.button === 'left'
            ? pickSpin(
                frame.layout,
                frame.view,
                c.now,
                g.fx,
                g.fy,
                frame.touched,
              )
            : undefined
        if (n !== undefined) open = { p: frame.layout.files[n]![0] }
        else if (usableFrame(frame.view)) {
          const v = frame.view,
            f = g.button === 'right' ? 1.5 : 1 / 1.5
          unfollow()
          steps.push({
            key: 'cam3d',
            next: (k) => ({
              ...fromDrawn(k, v, c.now),
              ...zoomSpin(v, g.fx, g.fy, f),
            }),
          })
        }
      }
    }
  } else {
    const frame = frames.d2
    if (frame !== undefined && g !== undefined) {
      if (g.kind === 'hover' || (g.kind === 'click' && g.button !== 'middle')) {
        const tilted = tilt(frame.layout),
          hit = pickAt(
            tilted.files,
            tilted.groups,
            frame.view,
            frame.touched,
            g.fx,
            g.fy,
          )
        if (g.kind === 'hover') {
          if (c.hoverNames && hit.file !== undefined)
            tip = {
              text: fileName(frame.layout.files[hit.file]![0]),
              x: g.x,
              y: g.y,
            }
        } else if (g.button === 'left' && hit.file !== undefined)
          open = { p: frame.layout.files[hit.file]![0] }
        else if (usableFrame(frame.view)) {
          unfollow()
          steps.push({
            key: 'camera',
            next: () =>
              zoomFrame(
                frame.view,
                g.fx,
                g.fy,
                g.button === 'right' ? 1.8 : 1 / 1.8,
                SIZE,
              ),
          })
        }
      } else if (g.kind === 'drag') {
        // A press continues from the frame it started on; the middle button zooms around its middle.
        const held =
          memory.drag2d?.press === g.press ? memory.drag2d.view : undefined
        const base = held ?? { ...frame.view }
        memory = { ...memory, drag2d: { press: g.press, view: base } }
        if (usableFrame(base)) {
          if (held === undefined) unfollow()
          const dx = g.fx - g.sfx,
            dy = g.fy - g.sfy,
            zoom = dragAction(g.button, false) === 'zoom'
          steps.push({
            key: 'camera',
            next: () =>
              zoom
                ? zoomFrame(base, 0.5, 0.5, dragZoom(dy), SIZE)
                : panFrame(base, dx, dy),
          })
        }
      }
    }
  }
  return { memory, steps, tip, open }
}
// The wheel zooms toward the pointer (`hover`, as a fraction of the map), `by` rows at a time.
export const mapWheel = (
  by: number,
  view3d: boolean,
  hover: { fx: number; fy: number },
  frames: DrawnFrames,
  now: number,
): Step[] => {
  if (by === 0 || !Number.isFinite(by)) return []
  const f = wheelZoom(by)
  if (view3d) {
    const frame = frames.d3
    if (frame === undefined || !usableFrame(frame.view)) return []
    const v = frame.view
    return [
      { key: 'zoomed', next: () => false },
      {
        key: 'cam3d',
        next: (k) => ({
          ...fromDrawn(k, v, now),
          ...zoomSpin(v, hover.fx, hover.fy, f),
        }),
      },
    ]
  }
  const frame = frames.d2
  return frame === undefined || !usableFrame(frame.view)
    ? []
    : [
        { key: 'zoomed', next: () => false },
        {
          key: 'camera',
          next: () => zoomFrame(frame.view, hover.fx, hover.fy, f, SIZE),
        },
      ]
}
export const coachBusy = (c: Coach): Coach => ({
  ...c,
  busy: true,
  error: undefined,
})
export const coachDone = (reply: string, at: number): Coach => {
  const block = /```context\s*\n([\s\S]*?)```/.exec(reply)
  return {
    text: reply.replace(/```context\s*\n[\s\S]*?```/, '').trim(),
    patch: block?.[1]?.trim() || undefined,
    at,
    busy: false,
  }
}
export const coachFailed =
  (reason: string, S: Strings) =>
  (c: Coach): Coach => ({
    ...c,
    busy: false,
    error:
      reason === 'nothing-to-fork'
        ? S.coachEmpty
        : `${S.coachFailed} ${reason}`,
  })
