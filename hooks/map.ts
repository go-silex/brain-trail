// The session's folder packed into one disc, and the trail drawn over it as an SVG.
import hierarchy from './vendor/d3-hierarchy/hierarchy/index.js'
import pack from './vendor/d3-hierarchy/pack/index.js'
import { LOGOS } from './logos'
import { svcColor } from './mcp'
import { rank, type Kind, type Trail } from '../types/model'
import { fitFrame, type MapFrame } from './pointer'

export const SIZE = 1800
const ARC_MS = 900, CALL_MS = 800, VIEW_MS = 600
// The markup's own width: wider than any pane, so the surface draws it at the pane's width and keeps its proportions.
const FLUID = 2400
// The map is scaled to the pane, so a stroke set in screen pixels would thin out: every width and dash goes to map units.
const unscale = (svg: string, px: number) => svg.replace(/<[^>]*vector-effect="non-scaling-stroke"[^>]*>/g, tag => {
  let t = tag.replace(' vector-effect="non-scaling-stroke"', '')
  t = /stroke-width="/.test(t)
    ? t.replace(/stroke-width="([\d.]+)"/, (_, n: string) => `stroke-width="${f(Number(n) * px)}"`)
    : t.replace(/\/?>$/, end => ` stroke-width="${f(px)}"${end}`)
  return t.replace(/stroke-dasharray="([\d.]+) ([\d.]+)"/, (_, a: string, b: string) => `stroke-dasharray="${f(Number(a) * px)} ${f(Number(b) * px)}"`)
})
const fluid = (w: number, h: number) => `width="${FLUID}" height="${Math.round((FLUID * h) / w)}"`
// In the native row wrapper the image stretches vertically and clamps to the full width.
// A one-pixel intrinsic height keeps that width clamp even before the first size report.
export const fitted = `width="${FLUID}" height="1" preserveAspectRatio="none"`

export type Group = { depth: number; name: string; path: string; x: number; y: number; r: number; n: number }
export type Layout = { size: number; dot: number; leaf?: number; files: [string, number, number][]; groups: Group[]; title: string }
export type Palette = { bg: string; fg: string; dot: string; ring: string; dim: string; line: string; card: string }

// Unkillable Companies: lines, not fills; one electric blue accent, only on markers under 12 px (here: the file Claude is on).
export const ACCENT = '#35b0ff'
// the map keeps the first Brain Trail's warm ember for the notes Claude reads and writes, and its one red for a jump with no link
export const EMBER = '#e8875b', GAP = '#e5484d'
export const PEACH = '#f6e8dc', MIST = '#cddce2', INK = '#0b0e10'
// the four ways a file enters the context, in the first Brain Trail's colours, and the dot of a file left aside
export type KindColors = Record<Kind, string> & { gap: string; node: string }
const KDARK: KindColors = { read: '#3b82f6', write: '#f59e0b', hit: '#a78bfa', link: '#2dd4bf', gap: '#f43f5e', node: '#52525b' }
const KLIGHT: KindColors = { read: '#2563eb', write: '#d97706', hit: '#8b5cf6', link: '#0d9488', gap: '#e11d48', node: '#a1a1aa' }
export const kindColors = (P: Palette): KindColors => (P.bg === DARK.bg ? KDARK : KLIGHT)

// dots as one path of zero-length strokes, each point relative to the last (shorter), one per cell of `cell` map units
export const dotPath = (pts: [number, number][], cell: number) => {
  const seen = new Set<string>()
  const keep: [number, number][] = []
  for (const [x, y] of pts) {
    const key = `${Math.round(x / cell)}:${Math.round(y / cell)}`
    if (seen.has(key)) continue
    seen.add(key)
    keep.push([Math.round(x), Math.round(y)])
  }
  if (keep.length === 0) return ''
  let [px, py] = keep[0]!
  const parts = [`M${px} ${py}h0`]
  for (let i = 1; i < keep.length; i++) {
    const [x, y] = keep[i]!
    parts.push(`m${x - px} ${y - py}h0`)
    px = x; py = y
  }
  return parts.join('')
}


// the dark surface of unkillablecompanies.com, and the light one of the deck
export const DARK: Palette = { bg: '#0b0e10', fg: '#ededed', dot: 'rgba(237,237,237,.28)', ring: '#ededed', dim: 'rgba(237,237,237,.48)', line: 'rgba(255,255,255,.14)', card: 'transparent' }
export const LIGHT: Palette = { bg: '#eef2f4', fg: '#0b0e10', dot: 'rgba(11,14,16,.3)', ring: '#0b0e10', dim: '#6b767c', line: 'rgba(11,14,16,.16)', card: 'transparent' }

type Tree = { key: string; kids: Map<string | number, Tree> } | { key: string; file: number }

// Folders, then sub-folders, then files: two folder levels at most.
export const packFiles = (list: string[], title: string): Layout => {
  const tree: Tree = { key: '', kids: new Map() }
  list.forEach((p, n) => {
    const parts = p.split('/')
    let cur: Tree = tree
    for (const d of [parts.length > 1 ? parts[0]! : '·', ...parts.slice(1, -1).slice(0, 1)]) {
      if (!('kids' in cur)) break
      if (!cur.kids.has(d)) cur.kids.set(d, { key: d, kids: new Map() })
      cur = cur.kids.get(d)!
    }
    if ('kids' in cur) cur.kids.set(n, { key: p, file: n })
  })
  const h = hierarchy<Tree>(tree, t => ('kids' in t ? [...t.kids.values()] : undefined))
    .sum(t => ('file' in t ? 1 : 0)).sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  pack().size([SIZE, SIZE]).padding(d => (d.depth === 0 ? 22 : d.depth === 1 ? 7 : 2))(h)
  const files: [string, number, number][] = list.map(p => [p, 0, 0])
  for (const l of h.leaves()) if ('file' in l.data) files[l.data.file] = [l.data.key, l.x, l.y]
  // the folder's path from the root, by its parents' keys
  const folderPath = (d: { data: Tree; parent: unknown }) => {
    const keys: string[] = []
    let cur = d as { data: Tree; parent: unknown } | null
    while (cur !== null && cur.parent !== null && cur.parent !== undefined) { keys.unshift(cur.data.key); cur = cur.parent as { data: Tree; parent: unknown } }
    return keys.join('/')
  }
  const pretty = (t: string) => (t === '·' ? 'root files' : t.replace(/^\d+[_ -]+/, '').replace(/_/g, ' '))
  const groups = h.descendants().filter(d => d.children && (d.depth === 1 || (d.value ?? 0) >= 4))
    .map(d => ({ depth: d.depth, name: pretty(d.data.key || title), path: folderPath(d as unknown as { data: Tree; parent: unknown }), x: d.x, y: d.y, r: d.r, n: d.value ?? 0 }))
  return { size: SIZE, dot: Math.min(2.2, (h.leaves()[0]?.r ?? 4) * 0.55), leaf: h.leaves()[0]?.r ?? 4, files, groups, title }
}

// The map's title on its top row, cut to the room the buttons on the right leave (`reserve`, in screen pixels):
// the folder's name first, then its count, never under a button.
export const fitTitle = (name: string, count: string, widthPx: number, reserve: number, fontPx = 11) => {
  const room = Math.floor((widthPx - 12 - reserve) / (fontPx * 0.62))
  const full = `${name} · ${count}`
  if (full.length <= room) return full
  if (count.length + 6 <= room) return `${name.slice(0, Math.max(1, room - count.length - 4))}… · ${count}`
  return room >= count.length ? count : ''
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
export const fileName = (p: string) => p.split('/').pop() ?? p
const f = (v: number) => Math.round(v * 10) / 10


const shortTool = (t: string) => t.replace(/^(slack_|notion-)/, '')

// ---- the brain: the folders lie flat on a slightly tilted table; the notes rise above them in lobes ----
export const TILT = 1  // how much of the table's depth shows (1: seen from straight above, the flat map)
const RISE = Math.sqrt(1 - TILT * TILT)  // how much of a height shows at that angle
export type Tilted = { files: [number, number][]; z: number[]; light: number[]; zMax: number; top: number; groups: (Group & { tx: number; ty: number; ry: number })[]; cy: number; R: number }
const tiltCache = new WeakMap<Layout, Tilted>()
const dome = (d: number, r: number) => Math.sqrt(Math.max(0, 1 - (d / r) ** 2))
// where each note and folder lands: a note rises in a dome over its folder (a lobe), a smaller one over its sub-folder
export const tilt = (L: Layout): Tilted => {
  const hit = tiltCache.get(L)
  if (hit !== undefined) return hit
  const disc = L.groups.find(g => g.depth === 0)
  const cy = disc?.y ?? L.size / 2, R = disc?.r ?? L.size / 2
  const g1 = L.groups.filter(g => g.depth === 1), g2 = L.groups.filter(g => g.depth === 2)
  // each note: its height, and how much light it catches (lit from the top left, like the rest of the brand's spheres)
  const LX = -0.45, LY = -0.55, LZ = 0.7
  const light: number[] = []
  // how high each sub-folder sits on its folder's lobe, kept low enough for its circle to stay inside the folder's
  const lift = new Map<Group, number>()
  for (const b of g2) {
    const a = g1.find(g => Math.hypot(g.x - b.x, g.y - b.y) <= g.r)
    if (!a) continue
    const dx = b.x - a.x, dy = b.y - a.y
    const half = a.r * TILT * Math.sqrt(Math.max(0, 1 - (dx / a.r) ** 2))
    const room = (dy * TILT - b.r * TILT + half - 2) / RISE
    lift.set(b, Math.max(0, Math.min(a.r * 0.32 * dome(Math.hypot(dx, dy), a.r), room)))
  }
  const z = L.files.map(([, x, y]) => {
    const a = g1.find(g => Math.hypot(g.x - x, g.y - y) <= g.r), b = g2.find(g => Math.hypot(g.x - x, g.y - y) <= g.r)
    let nx = 0, ny = 0, nz = 1, h = 0
    if (a) { const ha = dome(Math.hypot(a.x - x, a.y - y), a.r); h += b ? lift.get(b) ?? 0 : 0; nx = (x - a.x) / a.r; ny = (y - a.y) / a.r; nz = ha }
    if (b) { const hb = dome(Math.hypot(b.x - x, b.y - y), b.r); nx += 0.7 * (x - b.x) / b.r; ny += 0.7 * (y - b.y) / b.r; nz += 0.7 * hb }
    const len = Math.hypot(nx, ny, nz) || 1
    light.push(Math.max(0, (nx * LX + ny * LY + nz * LZ) / len))
    return h
  })
  // a note rises over its lobe but never out of a circle it belongs to: near a circle's top edge it stays low
  const margin = L.dot * 1.6 + 1.5
  L.files.forEach(([, x, y], n) => {
    let room = Infinity
    for (const g of L.groups) {
      const dx = x - g.x, dy = y - g.y
      if (Math.hypot(dx, dy) > g.r) continue
      // how far the dot can go up on screen before it leaves the flat ellipse drawn for this circle
      const half = g.r * TILT * Math.sqrt(Math.max(0, 1 - (dx / g.r) ** 2))
      room = Math.min(room, dy * TILT + half - margin + (lift.get(g) ?? 0) * RISE)
    }
    if (room !== Infinity) z[n] = Math.max(0, Math.min(z[n]!, room / RISE))
  })
  const files = L.files.map(([, x, y], n): [number, number] => [x, cy + (y - cy) * TILT - z[n]! * RISE])
  const groups = L.groups.map(g => ({ ...g, tx: g.x, ty: cy + (g.y - cy) * TILT - (lift.get(g) ?? 0) * RISE, ry: g.r * TILT }))
  const top = Math.min(cy - R * TILT, ...files.map(f => f[1]))
  const t = { files, z, light, zMax: Math.max(1, ...z), top, groups, cy, R }
  tiltCache.set(L, t)
  return t
}

// The frame a map shows for its natural box: the band above it (the services Claude called and,
// over the whole disc, its title) in map units at this width, then fitted to the host's box.
const framed = (
  box: { vx: number; vy: number; vw: number; vh: number },
  band: number,
  widthPx: number,
  fit: number | undefined,
) => {
  const px = box.vw / widthPx
  const banded = { vx: box.vx, vy: box.vy - band * px, vw: box.vw, vh: box.vh + band * px }
  return fit === undefined ? banded : fitFrame(banded, fit)
}

// `aspect`: the height over the width of the box the host gives the map; absent, the map takes its own height.
export type DrawOptions = { zoomed: boolean; widthPx: number; now: number; outside: number; filesWord: string; services: string[]; box?: { x: number; y: number; side: number }; aspect?: number }
export type MapRenderer = { draw: (L: Layout, T: Trail, P: Palette, opts: DrawOptions) => { svg: string; heightPx: number; view: MapFrame } }
export const createMapRenderer = () => {
  let trailBox: { vx: number; vy: number; side: number } | undefined
  type ViewHistory = { from: string; to: string; at: number; aspect?: number }
  let intrinsicView: ViewHistory | undefined
  let fittedView: ViewHistory | undefined
  const draw = (L: Layout, T: Trail, P: Palette, opts: DrawOptions) => {
  const { widthPx, now } = opts
  const TL = tilt(L)
  const xy = (n: number) => TL.files[n]!
  const disc = TL.groups.find(g => g.depth === 0)
  // view box: the whole disc and its title, the part the trail covers, or the frame the person zoomed to
  const top = TL.top - 30, bottom = TL.cy + TL.R * TILT + 20
  let [vx, vy, vw, vh] = [-10, top, L.size + 20, bottom - top]
  const wholeBox = { vx, vy, vw, vh }
  const shown = [...T.state.keys()].filter(n => T.state.get(n)!.k !== 'hit' || T.moves.length === 0)
  if (opts.box !== undefined) {
    ;[vx, vy, vw, vh] = [opts.box.x, opts.box.y, opts.box.side, opts.box.side]
    trailBox = undefined
  } else if (opts.zoomed && shown.length > 0) {
    const xs = shown.map(n => xy(n)[0]), ys = shown.map(n => xy(n)[1])
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2
    const side = Math.max(420, Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.3)
    const b = trailBox
    const margin = b === undefined ? 0 : b.side * 0.06
    const inside = b !== undefined && side >= b.side * 0.55
      && Math.min(...xs) >= b.vx + margin && Math.max(...xs) <= b.vx + b.side - margin
      && Math.min(...ys) >= b.vy + margin && Math.max(...ys) <= b.vy + b.side - margin
    if (!inside) trailBox = { vx: cx - side / 2, vy: cy - side / 2, side }
    ;[vx, vy, vw, vh] = [trailBox!.vx, trailBox!.vy, trailBox!.side, trailBox!.side]
  } else trailBox = undefined
  // the whole disc: its title sits on the top row, left, beside the Follow button, with no empty band above
  const whole = opts.box === undefined && trailBox === undefined
  const head = whole ? 40 : 0
  // the services Claude called sit in a band above the map, in the order of their first call; two rows past six.
  // No room is kept before the first call: the view glides down when a service appears.
  const svcs = opts.services.filter(s => (T.perSvc.get(s) ?? 0) > 0)
  const cols = svcs.length > 6 ? Math.ceil(svcs.length / 2) : Math.max(svcs.length, 1)
  const rows = svcs.length === 0 ? 0 : svcs.length > 6 ? 2 : 1
  const band = head + rows * 78, mapTop = vy, fit = opts.aspect
  // Glyphs belong to the natural camera, not the expanded letterbox.
  const naturalX = vx, naturalWidth = vw, px = vw / widthPx
  const bandTop = mapTop - band * px
  ;({ vx, vy, vw, vh } = framed({ vx, vy, vw, vh }, band, widthPx, fit))
  const SR = 17 * px, gapX = Math.min(naturalWidth / Math.max(cols, 1), 120 * px)
  const station = new Map(svcs.map((s, i) => {
    const c = i % cols, r = Math.floor(i / cols), inRow = Math.min(cols, svcs.length - r * cols)
    return [s, { x: naturalX + naturalWidth / 2 + (c - (inRow - 1) / 2) * gapX, y: bandTop + (head + 40 + r * 78) * px }]
  }))
  const heightPx = Math.round(widthPx * vh / vw)
  const box = `${f(vx)} ${f(vy)} ${f(vw)} ${f(vh)}`
  let lastView = fit === undefined ? intrinsicView : fittedView
  if (lastView === undefined || (fit !== undefined && lastView.aspect !== fit)) lastView = { from: box, to: box, at: 0, aspect: fit }
  else if (lastView.to !== box) lastView = { from: lastView.to, to: box, at: now, aspect: fit }
  if (fit === undefined) intrinsicView = lastView
  else fittedView = lastView
  const viewAge = now - lastView.at
  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" ${fit === undefined ? fluid(vw, vh) : fitted} font-family="'General Sans',ui-sans-serif,system-ui,sans-serif">`)
  if (viewAge < VIEW_MS && lastView.from !== box) {
    out.push(`<animate attributeName="viewBox" from="${lastView.from}" to="${box}" begin="${-viewAge}ms" dur="${VIEW_MS}ms" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".4 0 .2 1"/>`)
  }
  const K = kindColors(P)
  const dark = P.bg === DARK.bg
  const inView = (x: number, y: number) => x >= vx && x <= vx + vw && y >= vy && y <= vy + vh
  const xs: string[] = []  // what is drawn under the dots: the links between the notes the session met
  out.push(`<style>.e0{fill:${P.ring};fill-opacity:${dark ? '.03' : '.035'};stroke:${P.ring};stroke-opacity:.4}.e1{fill:${P.ring};fill-opacity:${dark ? '.055' : '.07'};stroke:${P.ring};stroke-opacity:.26}.e2{fill:none;stroke:${P.ring};stroke-opacity:.14}`
    + `.l{fill:${P.dim};font-family:ui-monospace,monospace;letter-spacing:.04em}.fn{stroke:${P.bg};stroke-opacity:.6;stroke-width:${f(3 * px)};stroke-linejoin:round;paint-order:stroke}`
    + `.t{fill:${P.fg};font-size:${f(11 * px)}px;font-weight:500;stroke:${P.bg};stroke-width:${f(px * 3)};paint-order:stroke;stroke-linejoin:round}`
    + `.k{font-family:ui-monospace,monospace;font-size:${f(10 * px)}px;letter-spacing:.06em;font-weight:500}</style>`)
  out.push(`<defs>${(['read', 'write'] as const).map(k => `<radialGradient id="g${k}"><stop offset="0" stop-color="${K[k]}" stop-opacity=".5"/><stop offset=".45" stop-color="${K[k]}" stop-opacity=".16"/><stop offset="1" stop-color="${K[k]}" stop-opacity="0"/></radialGradient>`).join('')}</defs>`)
  // the brain: the disc, its folders and sub-folders as flat circles, as the first Brain Trail drew them
  for (const g of TL.groups) {
    out.push(`<ellipse class="e${Math.min(2, g.depth)}" cx="${f(g.tx)}" cy="${f(g.ty)}" rx="${f(g.r)}" ry="${f(g.ry)}" stroke-width="${g.depth === 0 ? 1.4 : 1}" vector-effect="non-scaling-stroke"/>`)
  }
  // folder names go over the dots, and the files' names keep clear of them
  const folderLabels: string[] = []
  const placed: { x: number; y: number; w: number; h: number }[] = []
  for (const g of TL.groups) {
    if (g.depth === 0) {
      // a narrow pane keeps the title short, so it never runs under the buttons
      const more = opts.outside > 0 ? ` · +${opts.outside} outside` : ''
      const title = esc(fitTitle(L.title.toUpperCase(), `${g.n.toLocaleString('en-US')} ${opts.filesWord.toUpperCase()}${more}`, widthPx, whole ? 210 : 0))
      // zoomed in, the title would land among the services: it shows on the whole map only
      if (whole) out.push(`<text class="l" x="${f(naturalX + 12 * px)}" y="${f(bandTop + 24 * px)}" font-size="${f(11 * px)}">${title}</text>`)
      continue
    }
    const name = g.depth === 1 ? g.name.toUpperCase() : g.name
    // a folder name shrinks to fit its circle, and is left out below 8 px
    const fs = Math.min((g.depth === 1 ? 10.5 : 9.5) * px, (g.r * 1.5) / (name.length * 0.62))
    if ((g.depth === 1 && fs >= 8 * px) || (g.depth === 2 && g.r / px > 46 && fs >= 8 * px)) {
      const y = g.ty - g.ry + fs * 1.5, w = name.length * fs * 0.62
      const box = { x: g.tx - w / 2, y: y - fs, w, h: fs * 1.3 }
      // a sub-folder's name never runs over its folder's (folders come first)
      if (placed.some(o => box.x < o.x + o.w && o.x < box.x + box.w && box.y < o.y + o.h && o.y < box.y + box.h)) continue
      placed.push(box)
      folderLabels.push(`<text class="l fn" x="${f(g.tx)}" y="${f(y)}" font-size="${f(fs)}" text-anchor="middle"${g.depth === 2 ? ' fill-opacity=".7"' : ''}>${esc(name)}</text>`)
    }
  }
  const linksAt = out.length
  // the links between the notes the session met: straight inside a folder, bowed through the middle across folders
  const cx0 = disc?.tx ?? L.size / 2, cy0 = disc?.ty ?? L.size / 2
  const top1 = (n: number) => L.files[n]![0].split('/')[0]
  // the links of the last notes visited stand out; older ones stay as a faint web
  const fresh = new Set(T.moves.slice(-8).map(m => m.n))
  const linkD: string[] = [], seenD: string[] = [], oldD: string[] = []
  for (const [a, b] of T.links ?? []) {
    const sa = T.state.get(a), sb = T.state.get(b)
    if (sa === undefined || sb === undefined) continue
    const [ax, ay] = xy(a), [bx, by] = xy(b)
    if (!inView(ax, ay) && !inView(bx, by)) continue
    const d = top1(a) === top1(b)
      ? `M${Math.round(ax)} ${Math.round(ay)}L${Math.round(bx)} ${Math.round(by)}`
      : `M${Math.round(ax)} ${Math.round(ay)}Q${Math.round(cx0 + ((ax + bx) / 2 - cx0) * 0.35)} ${Math.round(cy0 + ((ay + by) / 2 - cy0) * 0.35)} ${Math.round(bx)} ${Math.round(by)}`
    ;(!fresh.has(a) && !fresh.has(b) ? oldD : sa.k === 'link' || sb.k === 'link' ? seenD : linkD).push(d)
  }
  if (seenD.length > 0) xs.push(`<path d="${seenD.join('')}" fill="none" stroke="${K.link}" stroke-opacity="${dark ? '.2' : '.28'}" stroke-width="1" vector-effect="non-scaling-stroke"/>`)
  if (linkD.length > 0) xs.push(`<path d="${linkD.join('')}" fill="none" stroke="${P.fg}" stroke-opacity="${dark ? '.35' : '.35'}" stroke-width="1" vector-effect="non-scaling-stroke"/>`)
  if (oldD.length > 0) xs.push(`<path d="${oldD.join('')}" fill="none" stroke="${P.fg}" stroke-opacity="${dark ? '.05' : '.07'}" stroke-width="1" vector-effect="non-scaling-stroke"/>`)
  // every file of the folder: one dot each, merged where several fall on the same spot of the screen
  const dotW = Math.min(Math.max(L.dot * 2, px * 1.6), (L.leaf ?? Infinity) * 2 * TILT * 0.62)
  const visible: [number, number][] = []
  for (let n = 0; n < L.files.length; n++) { const p = xy(n); if (inView(p[0], p[1]) && !T.state.has(n)) visible.push(p) }
  let cell = Math.max(1, px * 0.9), dots = dotPath(visible, cell)
  while (dots.length > 60000 && cell < px * 8) { cell *= 1.5; dots = dotPath(visible, cell) }
  if (dots !== '') out.push(`<path d="${dots}" fill="none" stroke="${K.node}" stroke-opacity="${dark ? '.85' : '.75'}" stroke-linecap="round" stroke-width="${f(dotW)}"/>`)
  // an arc that draws itself from its start; a redraw while it runs resumes it where it was
  const arc = (ax: number, ay: number, bx: number, by: number, col: string, opacity: number, width: number, dashed: boolean, at: number | undefined, ms: number) => {
    const qx = (ax + bx) / 2 - (by - ay) * 0.18, qy = (ay + by) / 2 + (bx - ax) * 0.18
    const d = `M${f(ax)} ${f(ay)}Q${f(qx)} ${f(qy)} ${f(bx)} ${f(by)}`
    const age = at === undefined ? Infinity : now - at
    if (age >= ms) {
      out.push(`<path d="${d}" fill="none" stroke="${col}" stroke-opacity="${f(opacity)}" stroke-width="${width}" vector-effect="non-scaling-stroke"${dashed ? ' stroke-dasharray="4 4"' : ''}/>`)
      return
    }
    const begin = `${-Math.round(age)}ms`, spline = 'calcMode="spline" keyTimes="0;1" keySplines=".25 .1 .25 1"'
    if (dashed) out.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="${width}" vector-effect="non-scaling-stroke" stroke-dasharray="4 4"/>`)
    else out.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="${f(width * px)}" pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1"><animate attributeName="stroke-dashoffset" from="1" to="0" begin="${begin}" dur="${ms}ms" fill="freeze" ${spline}/></path>`)
    out.push(`<circle r="${f(7 * px)}" fill="${col}" fill-opacity=".35"><animateMotion begin="${begin}" dur="${ms}ms" fill="freeze" path="${d}" ${spline}/><animate attributeName="r" from="${f(9 * px)}" to="0" begin="${ms - Math.round(age)}ms" dur="300ms" fill="freeze"/></circle>`)
    out.push(`<circle r="${f(2.2 * px)}" fill="${P.fg}"><animateMotion begin="${begin}" dur="${ms}ms" fill="freeze" path="${d}" ${spline}/><animate attributeName="r" from="${f(2.2 * px)}" to="0" begin="${ms - Math.round(age)}ms" dur="200ms" fill="freeze"/></circle>`)
  }
  // the names that entered the context without the file: a search's results, the notes a read note links to
  const seenBy = new Map<string, [number, number][]>()
  for (const [n, s] of T.state) {
    if (s.k !== 'hit' && s.k !== 'link') continue
    const p = xy(n)
    if (!inView(p[0], p[1])) continue
    // a name seen in a result counts more than one a link brought along
    const r = s.k === 'hit' ? Math.round((2.3 + Math.min(1.5, Math.log2(s.count + 1) * 0.6)) * 2) / 2 : 1.8
    const key = `${s.k}:${r}`
    seenBy.set(key, [...(seenBy.get(key) ?? []), p])
  }
  for (const k of ['link', 'hit'] as const) {
    for (const [key, pts] of seenBy) {
      if (!key.startsWith(`${k}:`)) continue
      const r = Number(key.split(':')[1])
      out.push(`<path d="${dotPath(pts, 0.5)}" fill="none" stroke="${K[k]}" stroke-opacity="${k === 'hit' ? '.9' : '.6'}" stroke-linecap="round" stroke-width="${f(2 * r * px)}"/>`)
    }
  }
  out.push(...folderLabels)
  // the trail: arcs between the files read or written, dashed red where no link joins two notes
  const recent = T.moves.slice(-60)
  recent.forEach((m, j) => {
    if (j === 0) return
    const [ax, ay] = xy(recent[j - 1]!.n), [bx, by] = xy(m.n)
    const age = recent.length - 1 - j
    arc(ax, ay, bx, by, m.gap ? K.gap : K.read, Math.max(0.15, 1 - age / 30), age < 4 ? 2 : 1.2, m.gap, age === 0 ? m.at : undefined, ARC_MS)
  })
  // MCP calls: an arc from the file Claude was on up to the service, in the service's colour
  const lastCalls = T.calls.filter(c => station.has(c.svc)).slice(-14)
  lastCalls.forEach((c, j) => {
    const st = station.get(c.svc)!
    const [ax, ay] = c.from !== undefined ? xy(c.from) : [cx0, disc ? disc.ty - disc.ry : 0]
    const age = lastCalls.length - 1 - j
    arc(ax, ay, st.x, st.y + SR, svcColor(c.svc), Math.max(0.1, 0.9 - age * 0.07), age === 0 ? 2 : 1.1, c.err, age === 0 ? c.at : undefined, CALL_MS)
  })
  // the files read and written: a glow on the last ones, a solid dot, a ring on a write
  const lastSeen = new Map<number, number>()
  T.moves.forEach((m, j) => lastSeen.set(m.n, T.moves.length - 1 - j))
  const solid = [...T.state.entries()].filter(([, s]) => s.k === 'read' || s.k === 'write').sort((a, z) => rank[a[1].k] - rank[z[1].k])
  for (const [n, s] of solid) {
    const age = lastSeen.get(n) ?? 99
    if (age >= 14) continue
    const [x, y] = xy(n)
    out.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f((16 + 5 * Math.log2(s.count + 1)) * px)}" fill="url(#g${s.k})" opacity="${f(1 - age / 16)}"/>`)
  }
  const now0 = T.moves.at(-1)?.n
  for (const [n, s] of solid) {
    const [x, y] = xy(n)
    const r = (3.2 + Math.min(3, Math.log2(s.count + 1) * 0.9)) * px
    out.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${K[s.k]}" stroke="${P.bg}" stroke-width="1.2" vector-effect="non-scaling-stroke"/>`)
    if (s.k === 'write') out.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(r + 3 * px)}" fill="none" stroke="${K.write}" stroke-width="1" vector-effect="non-scaling-stroke"/>`)
  }
  if (now0 !== undefined) {
    const [x, y] = xy(now0), col = K[T.state.get(now0)?.k ?? 'read']
    out.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(13 * px)}" fill="none" stroke="${col}" stroke-opacity=".6" stroke-width="1.5" vector-effect="non-scaling-stroke"><animate attributeName="r" values="${f(11 * px)};${f(16 * px)};${f(11 * px)}" dur="1.8s" repeatCount="indefinite" calcMode="spline" keyTimes="0;.5;1" keySplines=".45 0 .55 1;.45 0 .55 1"/></circle>`)
  }
  // names: the file Claude is on in a pill, then the last files it visited, none over another
  const free = (b: { x: number; y: number; w: number; h: number }) => b.x >= vx && b.x + b.w <= vx + vw && b.y >= vy && b.y + b.h <= vy + vh
    && !placed.some(o => b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h)
  const short = (n: number, max: number) => { const full = fileName(L.files[n]![0]).replace(/\.md$/, ''); return full.length > max ? `${full.slice(0, max - 1)}…` : full }
  const cur = recent.at(-1)?.n
  if (cur !== undefined) {
    const [x, y] = xy(cur), name = short(cur, 34), col = K[T.state.get(cur)?.k ?? 'read']
    const fs = 12.5 * px, h = 23 * px, w = name.length * fs * 0.56 + 20 * px
    const want = x + 14 * px + w > vx + vw ? x - 14 * px - w : x + 14 * px
    const left = Math.max(vx + 4 * px, Math.min(want, vx + vw - w - 4 * px))
    placed.push({ x: left, y: y - h / 2, w, h })
    out.push(`<rect x="${f(left)}" y="${f(y - h / 2)}" width="${f(w)}" height="${f(h)}" rx="${f(6 * px)}" fill="${P.bg}" fill-opacity=".92" stroke="${col}" stroke-opacity=".9" stroke-width="1" vector-effect="non-scaling-stroke"/>`)
    out.push(`<text x="${f(left + 10 * px)}" y="${f(y + fs * 0.36)}" font-size="${f(fs)}" fill="${P.fg}">${esc(name)}</text>`)
  }
  const named = [...new Set(recent.slice(-12).map(m => m.n).reverse())].filter(n => n !== cur)
  for (const n of named) {
    const [x, y] = xy(n), name = short(n, 28), fs = 11 * px
    const w = name.length * fs * 0.56, h = fs * 1.3
    const right = { x: x + 7 * px, y: y - h / 2, w, h }, left = { x: x - 7 * px - w, y: y - h / 2, w, h }
    const b = free(right) ? right : free(left) ? left : undefined
    if (b === undefined) continue
    placed.push(b)
    out.push(`<text class="t" x="${f(b.x === right.x ? x + 7 * px : x - 7 * px)}" y="${f(y + 4 * px)}"${b === left ? ' text-anchor="end"' : ''}>${esc(name)}</text>`)
  }
  // stations: the service's logo in a ring of its colour, its name above, its call count in a badge
  const last = T.calls.at(-1)
  const stationSvg = (withLogo: Set<string>) => {
    const o: string[] = []
    for (const [s, st] of station) {
      const col = svcColor(s), count = T.perSvc.get(s) ?? 0, L2 = SR * 1.2
      o.push(`<g><title>${esc(s)} · ${count}</title>`)
      if (last?.svc === s && now - last.at < CALL_MS + 900) {  // a ripple when the call lands
        const begin = CALL_MS - Math.round(now - last.at)
        o.push(`<circle cx="${f(st.x)}" cy="${f(st.y)}" r="${f(SR)}" fill="none" stroke="${col}" stroke-width="1.5" vector-effect="non-scaling-stroke" opacity="0"><animate attributeName="r" from="${f(SR)}" to="${f(SR * 1.8)}" begin="${begin}ms" dur="400ms" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".22 1 .36 1"/><animate attributeName="opacity" values="0;.6;0" begin="${begin}ms" dur="400ms" fill="freeze"/></circle>`)
      }
      o.push(`<circle cx="${f(st.x)}" cy="${f(st.y)}" r="${f(SR)}" fill="${P.bg}" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/>`)
      if (withLogo.has(s)) o.push(`<image href="${LOGOS[s]}" x="${f(st.x - L2 / 2)}" y="${f(st.y - L2 / 2)}" width="${f(L2)}" height="${f(L2)}" style="clip-path:inset(0 round 22%)"/>`)
      else o.push(`<text x="${f(st.x)}" y="${f(st.y + 5 * px)}" font-size="${f(14 * px)}" font-weight="600" fill="${col}" text-anchor="middle">${esc(s.slice(0, 1))}</text>`)
      const br = 8.5 * px, bx = st.x + SR * 0.74, by = st.y + SR * 0.74
      o.push(`<circle cx="${f(bx)}" cy="${f(by)}" r="${f(br)}" fill="${col}" stroke="${P.bg}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`)
      o.push(`<text x="${f(bx)}" y="${f(by + 3.3 * px)}" font-size="${f((count > 99 ? 8 : 9.5) * px)}" font-weight="600" fill="#fff" text-anchor="middle">${count}</text>`)
      // the name fits the room between two stations: « Google Calendar » says Calendar, a long one is cut
      const room = Math.max(3, Math.floor((gapX / px - 8) / 6.6))
      const short = s.replace(/^Google /, '').toUpperCase()
      o.push(`<text class="k" x="${f(st.x)}" y="${f(st.y - SR - 6 * px)}" fill="${col}" text-anchor="middle">${esc(short.length > room ? `${short.slice(0, room - 1)}…` : short)}</text></g>`)
    }
    if (last && station.has(last.svc)) {  // the tool of the last call, under its station, once the arc reaches it
      const st = station.get(last.svc)!, text = shortTool(last.tool) + (last.err ? ' · error' : '')
      const fs = 11 * px, h = 21 * px, w = text.length * fs * 0.56 + 18 * px, col = svcColor(last.svc)
      const x = Math.min(Math.max(st.x - w / 2, vx + 4 * px), vx + vw - w - 4 * px), y = st.y + SR + 16 * px
      const wait = Math.round(CALL_MS * 0.7 - (now - last.at))
      o.push(wait > 0 ? `<g opacity="0"><animate attributeName="opacity" to="1" begin="${wait}ms" dur="200ms" fill="freeze"/>` : '<g>')
      o.push(`<rect x="${f(x)}" y="${f(y - h / 2)}" width="${f(w)}" height="${f(h)}" rx="${f(6 * px)}" fill="${P.bg}" stroke="${col}" stroke-opacity=".7" stroke-width="1" vector-effect="non-scaling-stroke"/>`)
      o.push(`<text x="${f(x + 9 * px)}" y="${f(y + fs * 0.36)}" font-size="${f(fs)}" fill="${P.fg}">${esc(text)}</text></g>`)
    }
    return o.join('')
  }
  // the surface takes at most 131,072 characters: the links go first when room runs short, then the logos
  const LIMIT = 128000
  const size = (a: string[]) => a.reduce((t, x) => t + x.length, 0)
  const base = size(out) + 40
  const plain = stationSvg(new Set())
  let room = LIMIT - base - plain.length
  const under = xs.filter(x => { if (x.length > room) return false; room -= x.length; return true })
  const withLogo = new Set<string>()
  for (const s of [...station.keys()].sort((a, z) => (T.perSvc.get(z) ?? 0) - (T.perSvc.get(a) ?? 0))) {
    const logo = LOGOS[s]
    if (logo !== undefined && logo.length + 120 <= room) { withLogo.add(s); room -= logo.length + 120 }
  }
  out.splice(linksAt, 0, ...under)
  out.push(stationSvg(withLogo))
  out.push('</svg>')
  // what this map shows with no camera, so a gesture can reach it before it is drawn
  const view: MapFrame = { vx, vy, vw, vh, px: vw / widthPx, whole: framed(wholeBox, 40 + rows * 78, widthPx, fit) }
  if (fit !== undefined) {
    const cameraBand = rows * 78 / widthPx
    view.cameraFrame = fitFrame({ vx: 0, vy: -cameraBand, vw: 1, vh: 1 + cameraBand }, fit)
  }
  return { svg: unscale(out.join(''), px), heightPx, view }
}
  return { draw }
}

// The context gauge: a fine track, the fill in ink, the accent dot where the session stands,
// the two advice marks (half, three quarters) and, dashed, where auto-compaction runs.
export const gauge = (P: Palette, widthPx: number, percent: number, compactAt: number | undefined, _segments: unknown[], _max: number) => {
  const w = widthPx, y = 10, h = 6
  const at = Math.max(0, Math.min(1, percent / 100)) * w
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 38" ${fluid(w, 38)} font-family="'General Sans','Helvetica Neue',Helvetica,Arial,sans-serif">`]
  out.push(`<rect x="0" y="${y}" width="${w}" height="${h}" rx="3" fill="none" stroke="${P.line}" stroke-width="1"/>`)
  out.push(`<rect x="0" y="${y}" width="${f(at)}" height="${h}" rx="3" fill="${P.fg}" fill-opacity=".85"/>`)
  for (const p of [50, 75]) {
    const mx = (p / 100) * w
    out.push(`<line x1="${f(mx)}" y1="${y - 5}" x2="${f(mx)}" y2="${y + h + 5}" stroke="${P.fg}" stroke-opacity=".45" stroke-width="1"/>`)
    out.push(`<text x="${f(mx)}" y="${y + h + 18}" font-size="10" letter-spacing=".08em" fill="${P.dim}" text-anchor="middle">${p} %</text>`)
  }
  if (compactAt !== undefined && compactAt > 0 && compactAt < 100) {
    const mx = (compactAt / 100) * w
    out.push(`<line x1="${f(mx)}" y1="${y - 5}" x2="${f(mx)}" y2="${y + h + 5}" stroke="${P.fg}" stroke-opacity=".7" stroke-width="1" stroke-dasharray="3 3"/>`)
  }
  out.push(`<circle cx="${f(Math.max(5, Math.min(w - 5, at)))}" cy="${y + h / 2}" r="4" fill="${ACCENT}"/>`)
  out.push('</svg>')
  return out.join('')
}

// The brand band: crop marks at the corners, the two-line wordmark, the product name as an eyebrow with the
// one accent dot. No fill of its own: it lies on the pane's background, like the rest of the mod.
// Drawn at 480 by 76 and scaled to the pane, like a cover, up to BANNER_MAX pixels. Past that width its marks
// keep that size and the band only gets wider: it never takes the height the body needs.
export const BANNER_MAX = 900, BANNER_ASPECT = 76 / 480
export const banner = (product: string, line: string, P: Palette = DARK, widthPx = 0) => {
  const w = Math.round(480 * Math.max(1, widthPx / BANNER_MAX)), h = 76, ink = P.fg
  const corner = (x: number, y: number, dx: number, dy: number) =>
    `<path d="M${x + dx * 5} ${y}h${dx * 12}M${x} ${y + dy * 5}v${dy * 12}" stroke="${ink}" stroke-opacity=".45" stroke-width="1.2" fill="none"/>`
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" ${fluid(w, h)} font-family="'General Sans','Helvetica Neue',Helvetica,Arial,sans-serif">`,
    corner(10, 10, 1, 1), corner(w - 10, 10, -1, 1), corner(10, h - 10, 1, -1), corner(w - 10, h - 10, -1, -1),
    `<text x="24" y="35" font-size="21" font-weight="400" letter-spacing="-.05em" fill="${ink}">Unkillable</text>`,
    `<text x="24" y="55" font-size="21" font-weight="400" letter-spacing="-.05em" fill="${ink}">Companies</text>`,
    `<circle cx="${w - 24 - product.length * 7.4 - 12}" cy="29" r="3.5" fill="${ACCENT}"/>`,
    `<text x="${w - 24}" y="33" font-size="11" font-weight="500" letter-spacing=".16em" fill="${ink}" text-anchor="end">${esc(product.toUpperCase())}</text>`,
    `<text x="${w - 24}" y="53" font-size="11" letter-spacing="-.01em" fill="${P.dim}" text-anchor="end">${esc(line)}</text>`,
    '</svg>',
  ].join('')
}
