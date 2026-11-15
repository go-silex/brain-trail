import type {
  Camera,
  Coach,
  Play,
  PreviewRef,
  TrailSettings,
} from '../types/model'
import type { SharedView, SharedViewIntent } from '../types/view'
import type {
  Drag2d,
  DrawnFrames,
  GestureMemory,
  GestureResult,
  MapGesture,
  MapPoint,
  Step,
  ViewIntent,
  ViewState,
} from '../types/view'
import type { Strings } from './i18n'
import { fileName, SIZE, tilt } from './map'
import {
  dragAction,
  dragZoom,
  frameOf,
  panFrame,
  pickAt,
  usableFrame,
  wheelZoom,
  zoomFrame,
  type MapFrame,
} from './pointer'
import { CAM0, ZOOM_MAX, ZOOM_MIN, yawAt, type Cam } from './scene3d'

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
}
// The 3D picture back on the brain's middle.
const centred = (k: Cam): Cam =>
  k.pan.x === 0 && k.pan.y === 0 ? k : { ...k, pan: { x: 0, y: 0 } }
// The whole 3D picture again, as the 2D map's reset: the fitted zoom on the brain's middle;
// the turn, the tilt and the spin stay.
const whole3d = (k: Cam): Cam =>
  k.zoom === CAM0.zoom && k.pan.x === 0 && k.pan.y === 0
    ? k
    : { ...k, zoom: CAM0.zoom, pan: { x: 0, y: 0 } }
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
// `view3d`: the dimension shown, the one a reset returns to its whole.
export const plan = (
  i: ViewIntent,
  c: { now: number; frames: DrawnFrames; view3d: boolean },
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
    // The picture shown back to its whole; the other dimension keeps its own camera.
    case 'whole':
      return [
        c.view3d
          ? { key: 'cam3d', next: whole3d }
          : { key: 'camera', next: () => null },
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
    case 'turn-3d':
      return [
        { key: 'zoomed', next: () => false },
        {
          key: 'cam3d',
          next: (k) => ({ ...k, yaw: yawAt(k, c.now) + i.by, at: c.now }),
        },
      ]
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
      return [
        { key: 'zoomed', next: () => false },
        {
          key: 'cam3d',
          next: (k) => ({
            ...k,
            zoom:
              i.dir === 'in'
                ? Math.min(ZOOM_MAX, k.zoom * 1.5)
                : Math.max(ZOOM_MIN, k.zoom / 1.5),
          }),
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
    frames: { d2: undefined },
    view3d: false,
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
// The camera a 2D stretch asks for with the pointer at `p`: the middle button zooms around the
// frame's middle (up in, down out), the others pan.
const drag2dCamera = (d: Drag2d, view: MapFrame, p: MapPoint): Camera =>
  dragAction(d.button, false) === 'zoom'
    ? zoomFrame(view, 0.5, 0.5, dragZoom(p.fy - d.from.fy), SIZE)
    : panFrame(view, p.fx - d.from.fx, p.fy - d.from.fy)
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
  if (!s.view3d) {
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
        // A press starts from the frame it went down on.
        const at = { fx: g.fx, fy: g.fy }
        const held =
          memory.drag2d?.press === g.press ? memory.drag2d : undefined
        const view = held === undefined ? { ...frame.view } : held.view
        const d: Drag2d =
          held === undefined
            ? {
                press: g.press,
                button: g.button,
                view,
                from: { fx: g.sfx, fy: g.sfy },
                at,
              }
            : { ...held, at }
        memory = { ...memory, drag2d: d }
        if (usableFrame(view)) {
          if (held === undefined) unfollow()
          const camera = drag2dCamera(d, view, at)
          steps.push({ key: 'camera', next: () => camera })
        }
      }
    }
  }
  return { memory, steps, tip, open }
}
// The wheel zooms toward the pointer (`at`, as a fraction of the map), `by` rows at a time.
// During a press it zooms what the press shows now and starts the press's next stretch from
// there, so the drag goes on from the zoomed picture without undoing the wheel.
export const mapWheel = (
  by: number,
  view3d: boolean,
  at: MapPoint,
  m: GestureMemory,
  frames: DrawnFrames,
  _now: number,
): { memory: GestureMemory; steps: Step[] } => {
  const none = { memory: m, steps: [] }
  if (by === 0 || !Number.isFinite(by)) return none
  const f = wheelZoom(by)
  const unfollow: Step = { key: 'zoomed', next: () => false }
  if (view3d) return none
  const d = m.drag2d
  // the frame the press has reached (its camera's, or the whole map's), else the drawn one
  const shown =
    d !== undefined && usableFrame(d.view)
      ? frameOf(drag2dCamera(d, d.view, d.at), d.view)
      : frames.d2?.view
  if (shown === undefined || !usableFrame(shown)) return none
  const camera = zoomFrame(shown, at.fx, at.fy, f, SIZE)
  return {
    memory:
      d === undefined
        ? m
        : { ...m, drag2d: { ...d, view: frameOf(camera, shown), from: d.at } },
    steps: [unfollow, { key: 'camera', next: () => camera }],
  }
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
