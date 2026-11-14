// The brain in 3D, drawn inside the pane as one SVG that turns by itself.
// The pane runs no WebGL, so the turn is done with the SVG's own animations:
// the notes are sorted into thin vertical slices around the brain's axis. A slice is a flat plane,
// and a plane seen from a camera that turns around the axis is just a moving 2D transform.
// One keyframe list drives every slice, each with its own delay. Names and the notes Claude touched
// follow their exact path with animateMotion. Nothing runs in the mod while it turns.
import type { Trail } from '../types/model'
import { fileName, fitTitle, fitted, kindColors, type Layout, type Palette } from './map'
import { fitFrame } from './pointer'
import { brain, sliceAngle, sliceOf } from './scene3d'
export { brain, sliceAngle } from './scene3d'

export const SPIN_MS = 80_000  // one full turn
const NB = 72                  // slices around the axis (5 degrees each)
const KF = 36                  // keyframes per turn
const FLUID = 2400
// Fitted annotations must stay inside a stable camera envelope as counts grow.
const FIT_GLOW_LOG_MAX = 4
const TAU = Math.PI * 2

// `pan` moves the drawing on the screen's plane (SVG units), not the axis the brain turns around.
export type Cam = { yaw: number; pitch: number; zoom: number; pan: { x: number; y: number }; spin: boolean; at: number }
export const CAM0: Cam = { yaw: -0.6, pitch: 0.5, zoom: 1, pan: { x: 0, y: 0 }, spin: true, at: 0 }
export const PITCH_MIN = 0.08, PITCH_MAX = 1.05
export const ZOOM_MIN = 0.6, ZOOM_MAX = 12
// the camera's turn at a given time: it keeps going between redraws
export const yawAt = (c: Cam, now: number) => c.yaw + (c.spin ? (TAU * (now - c.at)) / SPIN_MS : 0)

const f = (v: number) => Math.round(v * 10) / 10
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// where a point lands on screen when its slice faces angle phi
const at = (u: number, v: number, phi: number, ce: number, se: number): [number, number] => [u * Math.cos(phi), -v * ce - u * Math.sin(phi) * se]
// how near the viewer it is: 1 in front, 0 at the back
const nearness = (phi: number) => (1 - Math.sin(phi)) / 2

// What a drawing shows, so a gesture continues from it: `zoom` and `pan` as drawn (a followed note's
// framing included), and `focus`, the point a change of zoom alone keeps in place.
export type SpinView = {
  vx: number; vy: number; vw: number; vh: number; px: number; yaw: number; ce: number; se: number; t: number; spinning: boolean
  zoom: number; pan: { x: number; y: number }; focus: { x: number; y: number }; follow: boolean
}

// `aspect`: the height over the width of the box the host gives the drawing; absent, it takes its own fixed shape.
export const drawSpin = (
  L: Layout, T: Trail, P: Palette,
  o: { widthPx: number; now: number; cam: Cam; follow: boolean; filesWord: string; outside: number; dark: boolean; aspect?: number },
) => {
  const B = brain(L)
  const { widthPx, now, cam } = o
  const cur = T.moves.at(-1)?.n
  // following Claude: the note it is on turns to the front and the camera comes close
  const follow = o.follow && cur !== undefined
  const pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, cam.pitch))
  const ce = Math.cos(pitch), se = Math.sin(pitch)
  const spinning = cam.spin && !follow
  const ang = (n: number) => (spinning ? sliceAngle(B.b[n]!) : B.a[n]!)
  const yaw = follow ? -Math.PI / 2 - ang(cur!) : yawAt(cam, now)
  // The intrinsic frame stays unchanged without an aspect; fitted views
  // contain a natural picture before expanding it to the available rectangle.
  const contentW = B.rMax * 1.98, contentTop = -(B.yMax * ce + B.rMax * se), contentBottom = B.rMax * se
  const aspect = 0.58
  let vw = Math.max(contentW, (contentBottom - contentTop) * 1.04 / aspect)
  // the zoom keeps the picture's middle in place, moved by the pan, or the followed note
  let ax = 0, ay = (contentTop + contentBottom) / 2
  let cx = ax + cam.pan.x, cy = ay + cam.pan.y
  const zoom = follow ? Math.max(1.8, cam.zoom) : Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, cam.zoom))
  vw /= zoom
  if (follow) [cx, cy] = at(B.u[cur!]!, B.v[cur!]!, ang(cur!) + yaw, ce, se)
  let vh = vw * aspect
  const px = vw / widthPx
  const head = 34 * px
  let vx = cx - vw / 2, vy = cy - vh / 2 - head
  let H = vh + head
  let titleX = vx, titleY = vy
  if (o.aspect !== undefined) {
    // Bound rotating annotations at every yaw, not just the current projection.
    // These bounds are built at unit zoom, then zoom/follow remain deliberate crops.
    const unit = px * zoom
    // Any note may become current; fitted glows have a fixed maximum radius.
    let nameLength = 0
    const glow = (16 + 5 * FIT_GLOW_LOG_MAX) * unit
    for (const [path] of L.files) {
      const length = path.length - path.lastIndexOf('/') - 1 - (path.endsWith('.md') ? 3 : 0)
      nameLength = Math.max(nameLength, Math.min(30, length))
    }
    const pill = (14 + nameLength * 12.5 * 0.56 + 18) * unit
    const horizontal = Math.max(glow, pill, 30 * unit)
    const vertical = Math.max(glow, 30 * unit, 11 * unit)
    let left = -B.rMax - horizontal, right = B.rMax + horizontal
    const lift = 30 + Math.hypot(2 * B.rMax, B.yMax) * 0.16
    let top = Math.min(-(B.yMax + lift) * ce - B.rMax * se - 3 * unit, contentTop - vertical, -B.yMax * ce * 0.35 - (B.rMax * Math.max(0.3, se) * 0.9 + B.yMax * ce * 0.5))
    let bottom = Math.max(contentBottom + vertical, -B.yMax * ce * 0.35 + (B.rMax * Math.max(0.3, se) * 0.9 + B.yMax * ce * 0.5))
    for (let i = 0; i < B.u.length; i++) {
      top = Math.min(top, -B.v[i]! * ce - B.u[i]! * se - vertical)
      bottom = Math.max(bottom, -B.v[i]! * ce + B.u[i]! * se + vertical)
    }
    for (const l of B.labels) {
      const fs = Math.max(9.5, Math.min(12, 9 + l.size / 90)) * unit
      const half = l.name.length * fs * 0.65 / 2 + 3 * unit
      const extent = l.u + half
      left = Math.min(left, -extent); right = Math.max(right, extent)
      top = Math.min(top, -l.v * ce - l.u * se - fs * 1.4)
      bottom = Math.max(bottom, -l.v * ce + l.u * se + fs * 0.4)
    }
    const minimumWidth = vw * zoom
    if (right - left < minimumWidth) {
      const extra = (minimumWidth - (right - left)) / 2
      left -= extra; right += extra
    }
    const centerX = (left + right) / 2, centerY = (top + bottom) / 2
    ax = centerX; ay = centerY
    if (!follow) { cx = centerX + cam.pan.x; cy = centerY + cam.pan.y }
    const natural = { vx: (left - centerX) / zoom + cx, vy: (top - centerY) / zoom + cy - head, vw: (right - left) / zoom, vh: (bottom - top) / zoom + head }
    titleX = natural.vx; titleY = natural.vy
    const fittedFrame = fitFrame(natural, o.aspect)
    ;({ vx, vy, vw, vh: H } = fittedFrame)
  }
  const heightPx = Math.round(widthPx * H / vw)
  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(vx)} ${f(vy)} ${f(vw)} ${f(H)}" ${o.aspect === undefined ? `width="${FLUID}" height="${Math.round(FLUID * H / vw)}"` : fitted} font-family="'General Sans',ui-sans-serif,system-ui,sans-serif">`)

  // one turn of a slice: its flat plane squeezed by the angle, slanted by the camera's height, dimmer at the back
  const tk = Math.tan(pitch)
  const n3 = (v: number) => String(Math.round(v * 1000) / 1000)
  const frame = (phi: number, unit = 'deg') => `scale(${n3(Math.cos(phi))},${n3(-ce)}) skewY(${f((Math.atan(Math.sin(phi) * tk) * 180) / Math.PI)}${unit})`
  const kf: string[] = []
  for (let k = 0; k <= KF; k++) {
    const phi = (TAU * k) / KF
    kf.push(`${f((100 * k) / KF)}%{transform:${frame(phi)};opacity:${f(0.18 + 0.82 * nearness(phi) ** 1.4)}}`)
  }
  const dotW = 2.5 * px, ink = P.fg
  const K = kindColors(P), EMBER = K.read, GAP = K.gap
  out.push(`<style>`
    + (spinning ? `@keyframes s{${kf.join('')}}.b{animation:s ${SPIN_MS}ms linear infinite;transform-origin:0 0;transform-box:view-box}` : '')
    + `.d0,.d1,.tr,.tg{fill:none;stroke-linecap:round}`
    + `.d0{stroke:${ink};stroke-opacity:${o.dark ? '.34' : '.4'};stroke-width:${f(dotW)}}`
    + `.d1{stroke:${ink};stroke-opacity:${o.dark ? '.72' : '.75'};stroke-width:${f(dotW * 1.2)}}`
    + `.tr{stroke:${EMBER};stroke-width:${f(dotW * 1.25)}}.tg{stroke:${GAP};stroke-width:${f(dotW)}}`
    + `.lb{font-family:ui-monospace,monospace;fill:${ink};fill-opacity:.62;stroke:${P.bg};stroke-width:${f(3 * px)};paint-order:stroke;stroke-linejoin:round}`
    + `.pt{fill:${ink};font-size:${f(12.5 * px)}px;font-weight:500}`
    + `</style>`)
  out.push(`<defs><radialGradient id="g3"><stop offset="0" stop-color="${EMBER}" stop-opacity=".85"/><stop offset=".4" stop-color="${EMBER}" stop-opacity=".3"/><stop offset="1" stop-color="${EMBER}" stop-opacity="0"/></radialGradient>`
    + `<radialGradient id="h3" cx=".5" cy=".55" r=".5"><stop offset="0" stop-color="${ink}" stop-opacity="${o.dark ? '.07' : '.06'}"/><stop offset="1" stop-color="${ink}" stop-opacity="0"/></radialGradient></defs>`)
  // a soft halo under the brain, so it does not float on nothing
  out.push(`<ellipse cx="0" cy="${f(-B.yMax * ce * 0.35)}" rx="${f(B.rMax * 1.05)}" ry="${f(B.rMax * Math.max(0.3, se) * 0.9 + B.yMax * ce * 0.5)}" fill="url(#h3)"/>`)

  // the trail, as beads along arcs lifted between the notes (in 3D, so it turns with the brain)
  const recent = T.moves.slice(-28)
  const beads: { u: number; v: number; a: number; b: number; gap: boolean; fresh: boolean }[] = []
  recent.forEach((m, j) => {
    if (j === 0) return
    const a = recent[j - 1]!.n, z = m.n
    const ax = B.X[a]!, ay = B.Y[a]!, az = B.Z[a]!, bx = B.X[z]!, by = B.Y[z]!, bz = B.Z[z]!
    const d = Math.hypot(bx - ax, by - ay, bz - az)
    if (d < 1) return
    const lift = 30 + d * 0.16
    const mx = (ax + bx) / 2, my = Math.max(ay, by) + lift, mz = (az + bz) / 2
    const n = Math.max(3, Math.min(42, Math.round(d / 16)))
    for (let k = 1; k < n; k++) {
      const t = k / n, s = 1 - t
      const x = s * s * ax + 2 * s * t * mx + t * t * bx, y = s * s * ay + 2 * s * t * my + t * t * by, zz = s * s * az + 2 * s * t * mz + t * t * bz
      beads.push({ u: Math.hypot(x, zz), v: y, a: Math.atan2(zz, x), b: sliceOf(Math.atan2(zz, x)), gap: m.gap, fresh: j >= recent.length - 5 })
    }
  })

  // the notes; the higher a note sits on its lobe, the brighter, the nearer, the more solid
  const lit = B.yMax * 0.5
  const N = L.files.length
  const thin = N > 9000 ? Math.ceil(N / 9000) : 1
  if (spinning) {
    // slice by slice: each slice is a flat plane the keyframes turn
    const slices: string[][] = Array.from({ length: NB }, () => [])
    const buf: { d0: string[]; d1: string[]; tr: string[]; tg: string[] }[] = Array.from({ length: NB }, () => ({ d0: [], d1: [], tr: [], tg: [] }))
    for (let i = 0; i < N; i += thin) buf[B.b[i]!]![B.v[i]! > lit ? 'd1' : 'd0'].push(`M${Math.round(B.u[i]!)} ${Math.round(B.v[i]!)}h0`)
    for (const e of beads) buf[e.b]![e.gap ? 'tg' : 'tr'].push(`M${Math.round(e.u)} ${Math.round(e.v)}h0`)
    for (let s = 0; s < NB; s++) {
      const p = buf[s]!
      if (p.d0.length + p.d1.length + p.tr.length + p.tg.length === 0) continue
      const phi = sliceAngle(s) + yaw
      const delay = Math.round(SPIN_MS * ((((phi / TAU) % 1) + 1) % 1))
      slices[s]!.push(`<g class="b" style="animation-delay:-${delay}ms" transform="${frame(phi, '')}" opacity="${f(0.18 + 0.82 * nearness(phi) ** 1.4)}">`)
      for (const k of ['d0', 'd1', 'tg', 'tr'] as const) if (p[k].length > 0) slices[s]!.push(`<path class="${k}" d="${p[k].join('')}"/>`)
      slices[s]!.push('</g>')
    }
    out.push(slices.flat().join(''))
  } else {
    // still: every note at its exact place, in four depth levels
    const lv: string[][] = [[], [], [], []], tr: string[] = [], tg: string[] = []
    const dot = (x: number, y: number) => `M${f(x)} ${f(y)}h0`
    for (let i = 0; i < N; i += thin) {
      const phi = B.a[i]! + yaw
      const [x, y] = at(B.u[i]!, B.v[i]!, phi, ce, se)
      const k = Math.min(3, Math.floor(nearness(phi) ** 1.5 * 3.4 + (B.v[i]! > lit ? 0.45 : 0)))
      lv[k]!.push(dot(x, y))
    }
    for (const e of beads) { const [x, y] = at(e.u, e.v, e.a + yaw, ce, se); (e.gap ? tg : tr).push(dot(x, y)) }
    lv.forEach((d, k) => { if (d.length > 0) out.push(`<path class="d1" stroke-opacity="${[0.12, 0.26, 0.5, 0.86][k]}" stroke-width="${f(dotW * [0.85, 1, 1.15, 1.3][k]!)}" d="${d.join('')}"/>`) })
    if (tg.length > 0) out.push(`<path class="tg" d="${tg.join('')}"/>`)
    if (tr.length > 0) out.push(`<path class="tr" d="${tr.join('')}"/>`)
  }

  // something that follows one point of the brain: animateMotion along its path while it turns, else placed once
  const follows = (u: number, v: number, a: number, fade: boolean) => {
    const phi0 = a + yaw
    if (!spinning) {
      const [x, y] = at(u, v, phi0, ce, se)
      return { open: `<g transform="translate(${f(x)},${f(y)})"${fade ? ` opacity="${f(0.25 + 0.75 * nearness(phi0))}"` : ''}>`, close: '</g>' }
    }
    const pts: string[] = [], ops: string[] = []
    for (let k = 0; k <= KF; k++) {
      const phi = phi0 + (TAU * k) / KF
      const [x, y] = at(u, v, phi, ce, se)
      pts.push(`${f(x)},${f(y)}`)
      ops.push(`${f(0.2 + 0.8 * nearness(phi) ** 1.3)}`)
    }
    return {
      open: `<g><animateMotion dur="${SPIN_MS}ms" repeatCount="indefinite" values="${pts.join(';')}"/>`
        + (fade ? `<animate attributeName="opacity" dur="${SPIN_MS}ms" repeatCount="indefinite" values="${ops.join(';')}"/>` : ''),
      close: '</g>',
    }
  }

  // the folders' names, above their lobe, faded when the lobe is at the back
  for (const l of B.labels) {
    const fs = Math.max(9.5, Math.min(12, 9 + l.size / 90)) * px
    const w = follows(l.u, l.v, spinning ? sliceAngle(l.b) : l.a, true)
    out.push(`${w.open}<text class="lb" font-size="${f(fs)}" text-anchor="middle">${esc(l.name)}</text>${w.close}`)
  }

  // the notes Claude read or wrote: an ember glow that breathes, a ring on a write
  const touched = [...T.state.entries()].filter(([, s]) => s.k === 'read' || s.k === 'write')
  const order = [...new Set([...recent.map(m => m.n).reverse(), ...touched.map(([n]) => n)])].filter(n => T.state.has(n)).slice(0, 48)
  for (const n of order) {
    const s = T.state.get(n)!
    if (s.k !== 'read' && s.k !== 'write') continue
    const w = follows(B.u[n]!, B.v[n]!, ang(n), true)
    const intensity = Math.log2(s.count + 1)
    const r = (o.aspect === undefined ? 3.4 + intensity : Math.min(3.4 + intensity, 32)) * px
    const g = (16 + 5 * (o.aspect === undefined ? intensity : Math.min(intensity, FIT_GLOW_LOG_MAX))) * px
    out.push(`${w.open}<circle r="${f(g)}" fill="url(#g3)"><animate attributeName="opacity" values=".55;1;.55" dur="3.6s" repeatCount="indefinite"/></circle>`
      + `<circle r="${f(r)}" fill="${K[s.k]}" stroke="${P.bg}" stroke-width="${f(px)}"/>`
      + (s.k === 'write' ? `<circle r="${f(r + 3 * px)}" fill="none" stroke="${K.write}" stroke-width="${f(px)}"/>` : '')
      + w.close)
  }
  // the note Claude is on: a pulse and its name in a pill
  if (cur !== undefined) {
    const w = follows(B.u[cur]!, B.v[cur]!, ang(cur), false)
    const full = fileName(L.files[cur]![0]).replace(/\.md$/, '')
    const name = full.length > 30 ? `${full.slice(0, 29)}…` : full
    const fs = 12.5 * px, h = 22 * px, wd = name.length * fs * 0.56 + 18 * px
    out.push(`${w.open}<circle r="${f(24 * px)}" fill="url(#g3)"><animate attributeName="r" values="${f(18 * px)};${f(30 * px)};${f(18 * px)}" dur="2.2s" repeatCount="indefinite"/></circle>`
      + `<circle r="${f(9 * px)}" fill="none" stroke="${EMBER}" stroke-opacity=".8" stroke-width="${f(px)}"/>`
      + `<rect x="${f(14 * px)}" y="${f(-h / 2)}" width="${f(wd)}" height="${f(h)}" rx="${f(6 * px)}" fill="${P.bg}" fill-opacity=".92" stroke="${EMBER}" stroke-opacity=".8" stroke-width="${f(px)}"/>`
      + `<text class="pt" x="${f(23 * px)}" y="${f(fs * 0.36)}">${esc(name)}</text>${w.close}`)
  }

  // the title on the top row, left: cut to the room the three buttons on the right leave, never under them
  const more = o.outside > 0 ? ` · +${o.outside} outside` : ''
  const root = L.groups.find(g => g.depth === 0)
  const title = fitTitle(L.title.toUpperCase(), `${(root?.n ?? N).toLocaleString('en-US')} ${o.filesWord.toUpperCase()}${more}`, widthPx, 320)
  if (title !== '') out.push(`<text x="${f(titleX + 12 * px)}" y="${f(titleY + 22 * px)}" font-size="${f(11 * px)}" font-family="ui-monospace,monospace" letter-spacing=".04em" fill="${P.dim}" stroke="${P.bg}" stroke-width="${f(4 * px)}" paint-order="stroke">${esc(title)}</text>`)
  out.push('</svg>')
  const view: SpinView = {
    vx, vy, vw, vh: H, px: vw / widthPx, yaw, ce, se, t: now, spinning,
    zoom, pan: { x: cx - ax, y: cy - ay }, focus: { x: cx, y: cy }, follow,
  }
  return { svg: out.join(''), heightPx, view }
}

// the turn a drawing shows at a given moment (the brain keeps turning between redraws)
export const yawOf = (view: SpinView, now: number) => view.spinning ? view.yaw + (TAU * (now - view.t)) / SPIN_MS : view.yaw

// The zoom and pan that scale the drawn frame by `f` (under 1 = closer) around its point (fx, fy).
export const zoomSpin = (view: SpinView, fx: number, fy: number, f: number) => {
  const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, view.zoom / f)), k = view.zoom / zoom
  const X = view.vx + fx * view.vw, Y = view.vy + fy * view.vh
  return { zoom, pan: { x: view.pan.x + (X - view.focus.x) * (1 - k), y: view.pan.y + (Y - view.focus.y) * (1 - k) } }
}

// the pan that moves the drawn frame by (dx, dy) of its size: the picture follows the pointer
export const panSpin = (view: SpinView, dx: number, dy: number) => ({ x: view.pan.x - dx * view.vw, y: view.pan.y - dy * view.vh })

// the note under the pointer at a given moment (the brain keeps turning), touched notes first
export const pickSpin = (L: Layout, view: SpinView, now: number, fx: number, fy: number, touched: Set<number>) => {
  const B = brain(L)
  const yaw = yawOf(view, now)
  const X = view.vx + fx * view.vw, Y = view.vy + fy * view.vh
  let best: number | undefined, bd = Infinity
  const scan = (n: number, reach: number) => {
    const [x, y] = at(B.u[n]!, B.v[n]!, (view.spinning ? sliceAngle(B.b[n]!) : B.a[n]!) + yaw, view.ce, view.se)
    const d = Math.hypot(x - X, y - Y) / view.px
    if (d < reach && d < bd) { bd = d; best = n }
  }
  for (const n of touched) scan(n, 14)
  if (best !== undefined) return best
  for (let n = 0; n < L.files.length; n++) scan(n, 6)
  return best
}
