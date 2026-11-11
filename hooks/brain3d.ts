// The brain in 3D: a page the mod writes next to its cache and opens in the browser, where WebGL can run.
// The page is static (the folder's notes); a small data file next to it carries the session, rewritten
// as Claude works, and the page reads it again every second and a half.
import type { Layout } from './map'
import type { Trail } from '../types/model'

export type Base3d = {
  title: string
  root: string
  vault: boolean
  files: [string, number, number, number, number][]  // path, x, y, folder index, sub-folder index (-1: none)
  groups: [number, string, number, number, number][]  // depth, name, x, y, r
  S: Record<string, string>
}

const STRINGS = {
  en: {
    notes: 'notes', files: 'files', read: 'read by Claude', follow: 'Follow Claude', following: 'Following Claude', overview: 'Overview',
    help: 'Drag: turn · Wheel: move forward · WASD or arrows: move · Space / Shift: up / down · Double click: dive to a note · Click: open it',
    live: 'Live', stale: 'Waiting for the session', now: 'Claude is on', prompt: 'Request',
  },
  fr: {
    notes: 'notes', files: 'fichiers', read: 'lues par Claude', follow: 'Suivre Claude', following: 'Suit Claude', overview: "Vue d'ensemble",
    help: 'Glisser : tourner · Molette : avancer · ZQSD ou flèches : se déplacer · Espace / Maj : monter / descendre · Double-clic : plonger vers une note · Clic : l’ouvrir',
    live: 'En direct', stale: 'En attente de la session', now: 'Claude est sur', prompt: 'Demande',
  },
}

export const base3d = (L: Layout, o: { root: string; vault: boolean; lang: 'en' | 'fr' }): Base3d => {
  const g1 = L.groups.map((g, i) => ({ g, i })).filter(x => x.g.depth === 1)
  const g2 = L.groups.map((g, i) => ({ g, i })).filter(x => x.g.depth === 2)
  const inside = (x: number, y: number, list: typeof g1) => list.find(({ g }) => Math.hypot(g.x - x, g.y - y) <= g.r)?.i ?? -1
  const S = { ...STRINGS[o.lang], word: o.vault ? STRINGS[o.lang].notes : STRINGS[o.lang].files }
  return {
    title: L.title,
    root: o.root,
    vault: o.vault,
    files: L.files.map(([p, x, y]) => [p, Math.round(x), Math.round(y), inside(x, y, g1), inside(x, y, g2)]),
    groups: L.groups.map(g => [g.depth, g.depth === 1 ? g.name.charAt(0).toUpperCase() + g.name.slice(1).toLowerCase() : g.name, Math.round(g.x), Math.round(g.y), Math.round(g.r)]),
    S,
  }
}

// the session as the page draws it: touched notes, Claude's path, the services it called
export const data3d = (T: Trail, o: { v: number | string; logos: Record<string, string>; prompt?: string }) => {
  const services = [...T.perSvc.keys()]
  const K = { link: 0, hit: 0, read: 1, write: 2 } as const
  const d = {
    v: o.v,
    state: [...T.state.entries()].map(([n, s]) => [n, K[s.k], s.count]),
    moves: T.moves.slice(-80).map(m => [m.n, m.gap ? 1 : 0]),
    services: services.map(s => [s, o.logos[s] ?? '', T.perSvc.get(s) ?? 0]),
    calls: T.calls.slice(-12).map(c => [services.indexOf(c.svc), c.from ?? -1, c.err ? 1 : 0]),
    prompt: o.prompt ?? '',
  }
  return `window.BT_DATA=${JSON.stringify(d).replace(/</g, '\\u003c')};`
}

export const page3d = (B: Base3d) => [
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
  `<title>Brain Trail 3D · ${B.title.replace(/</g, '')}</title>`,
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">',
  `<style>${CSS}</style></head><body>`,
  HUD,
  `<script>window.BT_BASE=${JSON.stringify(B).replace(/</g, '\\u003c')};</script>`,
  '<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>',
  `<script type="module">${JS}</script>`,
  '</body></html>',
].join('')

const CSS = String.raw`
:root{--bg:#07090b;--fg:#ededed;--dim:rgba(237,237,237,.55);--line:rgba(255,255,255,.12);--ember:#e8875b;--accent:#35b0ff}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font-family:'General Sans',Inter,system-ui,sans-serif;overflow:hidden}
canvas{display:block;outline:none}
.hud{position:fixed;pointer-events:none;z-index:2}
.tl{top:20px;left:24px}.tr{top:18px;right:20px;display:flex;gap:8px;pointer-events:auto}.bl{bottom:18px;left:24px;right:220px}.br{bottom:18px;right:24px}
.eyebrow{font-size:11px;letter-spacing:.16em;font-weight:500;display:flex;align-items:center;gap:8px}
.eyebrow i{width:7px;height:7px;border-radius:50%;background:var(--accent);display:inline-block}
.brand{font-size:22px;letter-spacing:-.04em;line-height:1.05;margin:6px 0 10px}
.stat{font:12px 'JetBrains Mono',ui-monospace,monospace;color:var(--dim)}
.prompt{margin-top:10px;max-width:420px;font-size:13px;color:var(--fg);opacity:.85;line-height:1.4}
.prompt b{display:block;font-size:10px;letter-spacing:.14em;color:var(--dim);font-weight:500;margin-bottom:2px;text-transform:uppercase}
button{font:500 13px Inter,system-ui,sans-serif;color:var(--fg);background:rgba(20,24,27,.72);border:1px solid var(--line);border-radius:9px;padding:8px 13px;cursor:pointer;backdrop-filter:blur(8px)}
button:hover{border-color:rgba(255,255,255,.3)}button.on{background:var(--fg);color:#0b0e10;border-color:var(--fg)}
.help{font-size:12px;color:var(--dim);line-height:1.5}
.live{font:12px 'JetBrains Mono',monospace;color:var(--dim);display:flex;align-items:center;gap:7px}
.live i{width:7px;height:7px;border-radius:50%;background:#555}.live.ok i{background:#3fbf7f;box-shadow:0 0 8px #3fbf7f}
#labels{position:fixed;inset:0;pointer-events:none;z-index:1}
.lab{position:absolute;transform:translate(-50%,-100%);font:500 12px 'JetBrains Mono',monospace;color:rgba(237,237,237,.75);white-space:nowrap;text-shadow:0 0 6px #000,0 0 12px #000;letter-spacing:.02em}
.lab.note{font:500 12px Inter,sans-serif;color:#ffd9c4;transform:translate(10px,-50%)}
.lab.svc{font:500 11px 'JetBrains Mono',monospace;color:#bfe6ff;transform:translate(-50%,24px)}
.lab.cur{background:rgba(11,14,16,.85);border:1px solid var(--ember);border-radius:7px;padding:4px 9px;color:#fff;font-size:13px}
#tip{position:fixed;z-index:3;pointer-events:none;background:rgba(11,14,16,.92);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px;display:none;max-width:360px}
#tip small{display:block;color:var(--dim);font:11px 'JetBrains Mono',monospace;margin-top:2px}
.vign{position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse at 50% 45%,transparent 55%,rgba(0,0,0,.55));z-index:1}
`

const HUD = [
  '<div class="vign"></div><div id="labels"></div><div id="tip"></div>',
  '<div class="hud tl"><div class="eyebrow"><i></i>BRAIN TRAIL</div><div class="brand">Unkillable<br>Companies</div><div class="stat" id="stat"></div><div class="prompt" id="prompt"></div></div>',
  '<div class="hud tr"><button id="follow"></button><button id="overview"></button></div>',
  '<div class="hud bl help" id="help"></div>',
  '<div class="hud br live" id="live"><i></i><span></span></div>',
].join('')

// The page's code: no template literals in it, so it can live in this raw string.
const JS = String.raw`
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

const B = window.BT_BASE, S = B.S
const $ = id => document.getElementById(id)
$('help').textContent = S.help
$('overview').textContent = S.overview

// ---------- 3D positions: the folder disc becomes a brain ----------
const C = 900, root = B.groups.find(g => g[0] === 0) || [0, '', 900, 900, 900], R = root[4]
const rnd = i => { let t = Math.imul(i + 1, 2654435761) >>> 0; t ^= t >>> 15; t = Math.imul(t, 2246822519) >>> 0; t ^= t >>> 13; t = Math.imul(t, 3266489917) >>> 0; t ^= t >>> 16; return (t >>> 0) / 4294967296 }
const dome = (d, r) => Math.sqrt(Math.max(0, 1 - (d / r) * (d / r)))
const N = B.files.length
const pos = new Float32Array(N * 3)
const fold = new Int32Array(N)
for (let i = 0; i < N; i++) {
  const f = B.files[i], x = f[1], y = f[2], a = B.groups[f[3]], b = B.groups[f[4]]
  fold[i] = f[3]
  let X = x - C, Z = (y - C) * 1.18
  X += Math.sign(X) * 46  // the two hemispheres
  let Y = R * 0.34 * dome(Math.hypot(x - C, y - C), R)
  if (a) Y += a[4] * 0.5 * dome(Math.hypot(a[2] - x, a[3] - y), a[4])
  if (b) Y += (rnd(i) - 0.5) * 2 * b[4] * 0.8 * dome(Math.hypot(b[2] - x, b[3] - y), b[4])
  else if (a) Y += (rnd(i) - 0.5) * a[4] * 0.35 * dome(Math.hypot(a[2] - x, a[3] - y), a[4])
  // a little jitter, so notes are not on a grid
  X += (rnd(i * 7 + 1) - 0.5) * 6; Z += (rnd(i * 13 + 2) - 0.5) * 6
  pos[i * 3] = X; pos[i * 3 + 1] = Y; pos[i * 3 + 2] = Z
}
let maxY = 0; for (let i = 0; i < N; i++) maxY = Math.max(maxY, pos[i * 3 + 1])
const P = i => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])

// ---------- scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.setClearColor(0x07090b, 1)
document.body.prepend(renderer.domElement)
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x07090b)  // a background, not a clear colour: the bloom pass keeps it black
const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.5, 30000)
const home = { pos: new THREE.Vector3(0, R * 0.75, R * 2.1), target: new THREE.Vector3(0, maxY * 0.28, 0) }
camera.position.copy(home.pos).multiplyScalar(2.6)  // the page opens from afar and flies in
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.copy(home.target)
controls.enableDamping = true; controls.dampingFactor = 0.07; controls.rotateSpeed = 0.55; controls.panSpeed = 0.8
controls.enableZoom = false  // the wheel flies forward instead, through the brain
controls.autoRotate = true; controls.autoRotateSpeed = 0.35
controls.screenSpacePanning = true

const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(scene, camera))
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.85, 0.5, 0.32)
composer.addPass(bloom)
composer.addPass(new OutputPass())

// ---------- the notes: soft glowing points ----------
const col = new Float32Array(N * 3), size = new Float32Array(N), phase = new Float32Array(N), glow = new Float32Array(N)
const tint = []
for (let g = 0; g < B.groups.length; g++) { const h = 0.55 + (rnd(g * 31) - 0.5) * 0.12; tint.push(new THREE.Color().setHSL(h, 0.18, 0.62)) }
const idle = i => tint[fold[i]] || tint[0]
for (let i = 0; i < N; i++) { phase[i] = rnd(i * 3 + 5); size[i] = 5 + rnd(i * 5) * 2.5 }
const geo = new THREE.BufferGeometry()
geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
geo.setAttribute('size', new THREE.BufferAttribute(size, 1))
geo.setAttribute('phase', new THREE.BufferAttribute(phase, 1))
geo.setAttribute('glow', new THREE.BufferAttribute(glow, 1))
const pointMat = new THREE.ShaderMaterial({
  uniforms: { time: { value: 0 }, scale: { value: innerHeight * 1.3 } },
  vertexShader: [
    'attribute float size; attribute vec3 color; attribute float phase; attribute float glow;',
    'uniform float time; uniform float scale;',
    'varying vec3 vColor; varying float vGlow; varying float vFar;',
    'void main(){',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  float tw = 0.8 + 0.2 * sin(time * 1.1 + phase * 6.283);',
    '  float pulse = 1.0 + glow * 0.28 * sin(time * 2.6 + phase * 6.283);',
    '  gl_PointSize = clamp(size * pulse * scale / -mv.z, 1.6, 70.0);',
    '  gl_Position = projectionMatrix * mv;',
    '  vColor = color * mix(tw, 1.0, glow); vGlow = glow; vFar = smoothstep(9000.0, 1400.0, -mv.z);',
    '}'].join('\n'),
  fragmentShader: [
    'varying vec3 vColor; varying float vGlow; varying float vFar;',
    'void main(){',
    '  float d = length(gl_PointCoord - 0.5);',
    '  if (d > 0.5) discard;',
    '  float core = smoothstep(0.5, 0.0, d);',
    '  float a = pow(core, mix(2.2, 1.3, vGlow));',
    '  gl_FragColor = vec4(vColor * a, a * mix(0.5, 1.0, vGlow) * mix(0.35, 1.0, vFar));',
    '}'].join('\n'),
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
})
const points = new THREE.Points(geo, pointMat)
scene.add(points)

// ---------- synapses: each note linked to its two nearest neighbours in the same folder ----------
{
  const segs = []
  const byFold = new Map()
  for (let i = 0; i < N; i++) { const k = B.files[i][4] >= 0 ? B.files[i][4] : fold[i]; if (!byFold.has(k)) byFold.set(k, []); byFold.get(k).push(i) }
  for (const list of byFold.values()) {
    for (const i of list) {
      let best = [[Infinity, -1], [Infinity, -1]]
      for (const j of list) { if (j === i) continue; const dx = pos[i*3]-pos[j*3], dy = pos[i*3+1]-pos[j*3+1], dz = pos[i*3+2]-pos[j*3+2], d = dx*dx+dy*dy+dz*dz; if (d < best[1][0]) { best[1] = [d, j]; best.sort((a, b) => a[0] - b[0]) } }
      for (const [, j] of best) if (j > i) segs.push(pos[i*3], pos[i*3+1], pos[i*3+2], pos[j*3], pos[j*3+1], pos[j*3+2])
    }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3))
  scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x9fb6c4, transparent: true, opacity: 0.045, blending: THREE.AdditiveBlending, depthWrite: false })))
}

// ---------- membranes: a faint rim of light around each lobe and around the whole brain ----------
const rimMat = (c, k) => new THREE.ShaderMaterial({
  uniforms: { c: { value: new THREE.Color(c) }, k: { value: k } },
  vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
  fragmentShader: 'uniform vec3 c; uniform float k; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 4.5); gl_FragColor = vec4(c * f * k, f * k); }',
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
})
const centers = new Map()
for (let g = 0; g < B.groups.length; g++) {
  const gr = B.groups[g]; if (gr[0] !== 1) continue
  let sx = 0, sy = 0, sz = 0, n = 0, top = 0, low = Infinity
  for (let i = 0; i < N; i++) if (fold[i] === g) { sx += pos[i*3]; sy += pos[i*3+1]; sz += pos[i*3+2]; n++; top = Math.max(top, pos[i*3+1]); low = Math.min(low, pos[i*3+1]) }
  if (n === 0) continue
  const c = new THREE.Vector3(sx / n, (top + low) / 2, sz / n)
  centers.set(g, { c, top, name: gr[1], r: gr[4], n })
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), rimMat(0x8fb0c4, 0.12))
  m.scale.set(gr[4] * 1.02, Math.max(30, (top - low) / 2 + 18), gr[4] * 1.2)
  m.position.copy(c)
  scene.add(m)
}
{
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), rimMat(0x35b0ff, 0.07))
  m.scale.set(R + 60, maxY * 0.62 + 40, (R + 60) * 1.18); m.position.set(0, maxY * 0.32, 0); scene.add(m)
}
// dust, far away, for depth
{
  const n = 1400, a = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) { const u = rnd(i * 11 + 9) * 2 - 1, t = rnd(i * 17 + 3) * Math.PI * 2, r = 5000 + rnd(i * 19) * 5000, s = Math.sqrt(1 - u * u); a[i*3] = r * s * Math.cos(t); a[i*3+1] = r * u; a[i*3+2] = r * s * Math.sin(t) }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(a, 3))
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x5b6b75, size: 14, sizeAttenuation: true, transparent: true, opacity: 0.5, depthWrite: false })))
}

// ---------- the session: Claude's path, its pulses, the services ----------
const trail = new THREE.Group(); scene.add(trail)
const svcGroup = new THREE.Group(); scene.add(svcGroup)
let curve = null, comets = [], current = -1, curves = []
const EMBER = new THREE.Color(0xe8875b), HOT = new THREE.Color(1.9, 1.35, 1.05), WRITE = new THREE.Color(2.2, 1.2, 0.7)
const lift = (a, b) => { const m = a.clone().add(b).multiplyScalar(0.5); m.y += 30 + a.distanceTo(b) * 0.16; return new THREE.QuadraticBezierCurve3(a, m, b) }
const disposeGroup = g => { while (g.children.length) { const c = g.children.pop(); c.geometry && c.geometry.dispose(); c.material && c.material.dispose && c.material.dispose() } }
const texCache = new Map()
const tex = src => { if (!texCache.has(src)) { const t = new THREE.TextureLoader().load(src); t.colorSpace = THREE.SRGBColorSpace; texCache.set(src, t) } return texCache.get(src) }
let svcPos = []
let D = null

const apply = d => {
  D = d
  // colours: idle notes in their folder's grey-blue, touched ones in ember, the current one white hot
  for (let i = 0; i < N; i++) { const c = idle(i); col[i*3] = c.r * 0.95; col[i*3+1] = c.g * 0.95; col[i*3+2] = c.b * 0.95; glow[i] = 0; size[i] = 7 + rnd(i * 5) * 3 }
  let reads = 0
  for (const [n, k, count] of d.state) {
    if (n >= N) continue
    const c = k === 0 ? EMBER.clone().multiplyScalar(0.7) : k === 2 ? WRITE : EMBER.clone().multiplyScalar(1.5)
    col[n*3] = c.r; col[n*3+1] = c.g; col[n*3+2] = c.b
    glow[n] = k === 0 ? 0.2 : 1; size[n] = k === 0 ? 9 : 16 + Math.log2(count + 1) * 5
    if (k > 0) reads++
  }
  const moves = d.moves.filter(m => m[0] < N)
  current = moves.length ? moves[moves.length - 1][0] : -1
  if (current >= 0) { col[current*3] = HOT.r; col[current*3+1] = HOT.g; col[current*3+2] = HOT.b; size[current] = 30; glow[current] = 1 }
  for (const k of ['color', 'size', 'glow']) geo.attributes[k].needsUpdate = true
  // the path: an arc lifted between each pair of notes, brighter as it is recent, red and dashed for a jump with no link
  disposeGroup(trail); curves = []
  for (let j = 1; j < moves.length; j++) {
    const a = P(moves[j-1][0]), b = P(moves[j][0]), cu = lift(a, b), age = moves.length - 1 - j
    const op = Math.max(0.12, 1 - age / 28)
    if (moves[j][1]) {
      const g = new THREE.BufferGeometry().setFromPoints(cu.getPoints(40))
      const l = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0xe5484d, dashSize: 10, gapSize: 8, transparent: true, opacity: op, depthWrite: false }))
      l.computeLineDistances(); trail.add(l)
    } else {
      const tube = new THREE.Mesh(new THREE.TubeGeometry(cu, 40, age < 3 ? 1.3 : 0.8, 6, false), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xe8875b).multiplyScalar(age < 3 ? 1.15 : 0.8), transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false }))
      trail.add(tube)
    }
    curves.push(cu)
  }
  // services: a ring of stations above the brain, each with its logo and its calls
  disposeGroup(svcGroup); svcPos = []
  const ns = d.services.length
  d.services.forEach((s, k) => {
    const ang = -Math.PI / 2 + (k - (ns - 1) / 2) * Math.min(0.55, (Math.PI * 1.2) / Math.max(ns, 1))
    const p = new THREE.Vector3(Math.cos(ang) * R * 0.95, maxY + 330, Math.sin(ang) * R * 0.95 - R * 0.15)
    svcPos.push(p)
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color: 0x35b0ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }))
    halo.scale.set(150, 150, 1); halo.position.copy(p); svcGroup.add(halo)
    if (s[1]) { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex(s[1]), transparent: true, depthWrite: false })); sp.scale.set(64, 64, 1); sp.position.copy(p); svcGroup.add(sp) }
  })
  d.calls.forEach((c, j) => {
    if (c[0] < 0 || !svcPos[c[0]]) return
    const a = c[1] >= 0 && c[1] < N ? P(c[1]) : new THREE.Vector3(0, maxY, 0), b = svcPos[c[0]].clone()
    const age = d.calls.length - 1 - j
    const cu = lift(a, b)
    svcGroup.add(new THREE.Mesh(new THREE.TubeGeometry(cu, 48, age === 0 ? 1.2 : 0.7, 6, false), new THREE.MeshBasicMaterial({ color: c[2] ? 0xe5484d : 0x35b0ff, transparent: true, opacity: Math.max(0.1, 0.85 - age * 0.08), blending: THREE.AdditiveBlending, depthWrite: false })))
    if (age < 3) curves.push(cu)
  })
  // pulses that run along the path, like signals between neurons
  comets.forEach(c => scene.remove(c.s)); comets = []
  const recent = curves.slice(-8)
  recent.forEach((cu, k) => { for (let m = 0; m < 2; m++) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color: 0xffc9a8, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })); s.scale.set(26, 26, 1); scene.add(s); comets.push({ s, cu, off: (k * 0.37 + m * 0.5) % 1, speed: 0.35 + rnd(k * 3 + m) * 0.25 }) } })
  // texts
  const nm = n => B.files[n][0].split('/').pop().replace(/\.md$/, '')
  $('stat').textContent = B.title + ' · ' + N.toLocaleString('fr-FR') + ' ' + S.word + ' · ' + reads + ' ' + S.read
  $('prompt').innerHTML = d.prompt ? '<b>' + S.prompt + '</b>' + esc(d.prompt) : ''
  noteLabels = [...new Set(moves.slice(-7).map(m => m[0]))].map(n => ({ n, text: nm(n), cur: n === current }))
  svcLabels = d.services.map((s, k) => ({ p: svcPos[k], text: s[0] + ' · ' + s[2] }))
  if (follow && current >= 0) setTimeout(() => { if (follow) flyTo(P(current), 780) }, Math.max(0, introEnd - performance.now()))
}
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
const haloTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const r = g.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,255,255,.55)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c) })()

// ---------- labels ----------
let noteLabels = [], svcLabels = []
const labels = $('labels')
const pool = []
const v = new THREE.Vector3()
const drawLabels = () => {
  const items = []
  for (const [, g] of centers) items.push({ p: new THREE.Vector3(g.c.x, g.top + 26, g.c.z), text: g.name, cls: 'lab', size: g.r })
  for (const l of noteLabels) items.push({ p: P(l.n), text: l.text, cls: l.cur ? 'lab note cur' : 'lab note' })
  for (const l of svcLabels) items.push({ p: l.p, text: l.text, cls: 'lab svc' })
  while (pool.length < items.length) { const e = document.createElement('div'); labels.appendChild(e); pool.push(e) }
  pool.forEach((e, k) => {
    const it = items[k]
    if (!it) { e.style.display = 'none'; return }
    v.copy(it.p).project(camera)
    const dist = camera.position.distanceTo(it.p)
    if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) { e.style.display = 'none'; return }
    let op = 1
    if (it.size) op = Math.min(1, Math.max(0, (it.size * 9 - dist) / (it.size * 4))) * Math.min(1, dist / 160)
    e.style.display = op > 0.03 ? 'block' : 'none'
    e.style.opacity = op
    e.className = it.cls
    if (e.textContent !== it.text) e.textContent = it.text
    e.style.left = ((v.x + 1) / 2 * innerWidth) + 'px'; e.style.top = ((1 - v.y) / 2 * innerHeight) + 'px'
  })
}

// ---------- moving around ----------
let follow = true, lastTouch = 0, tween = null
const followBtn = $('follow')
const setFollow = on => { follow = on; followBtn.textContent = on ? S.following : S.follow; followBtn.className = on ? 'on' : ''; if (on && current >= 0 && performance.now() > introEnd) flyTo(P(current), 780) }
followBtn.onclick = () => setFollow(!follow)
$('overview').onclick = () => { setFollow(false); tweenTo(home.pos.clone(), home.target.clone()); controls.autoRotate = true }
const touched = () => { lastTouch = performance.now(); controls.autoRotate = false; tween = null }
controls.addEventListener('start', () => { touched(); if (follow) setFollow(false) })
const tweenTo = (pos2, target2, ms = 1300) => { tween = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos2, t1: target2, start: performance.now(), ms } }
const flyTo = (p, dist) => { const dir = camera.position.clone().sub(controls.target).normalize(); if (dir.y < 0.25) { dir.y = 0.35; dir.normalize() } tweenTo(p.clone().add(dir.multiplyScalar(dist)), p.clone()) }
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

// the wheel flies the camera forward or back towards the pointer, through the brain
const ray = new THREE.Raycaster(); ray.params.Points.threshold = 9
const mouse = new THREE.Vector2()
renderer.domElement.addEventListener('wheel', e => {
  e.preventDefault(); touched(); if (follow) setFollow(false)
  mouse.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
  ray.setFromCamera(mouse, camera)
  const dist = camera.position.distanceTo(controls.target)
  const step = -Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) / 120 * Math.max(18, Math.min(dist, 2400) * 0.16)
  const move = ray.ray.direction.clone().multiplyScalar(step)
  camera.position.add(move); controls.target.add(move)
}, { passive: false })

// keyboard: forward, back, left, right, up, down (QWERTY and AZERTY), smoothed
const keys = new Set()
addEventListener('keydown', e => { if (['KeyW','KeyZ','KeyS','KeyA','KeyQ','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','ShiftLeft','ShiftRight','KeyE','KeyC'].includes(e.code)) { keys.add(e.code); touched(); if (follow) setFollow(false); e.preventDefault() } })
addEventListener('keyup', e => keys.delete(e.code))
const vel = new THREE.Vector3()
const fly = dt => {
  const f = new THREE.Vector3(); camera.getWorldDirection(f)
  const r = new THREE.Vector3().crossVectors(f, camera.up).normalize()
  const want = new THREE.Vector3()
  const on = (...c) => c.some(k => keys.has(k))
  if (on('KeyW', 'KeyZ', 'ArrowUp')) want.add(f)
  if (on('KeyS', 'ArrowDown')) want.sub(f)
  if (on('KeyD', 'ArrowRight')) want.add(r)
  if (on('KeyA', 'KeyQ', 'ArrowLeft')) want.sub(r)
  if (on('Space', 'KeyE')) want.y += 1
  if (on('ShiftLeft', 'ShiftRight', 'KeyC')) want.y -= 1
  const speed = Math.max(60, Math.min(camera.position.distanceTo(controls.target), 2400) * 0.9)
  if (want.lengthSq() > 0) want.normalize().multiplyScalar(speed)
  vel.lerp(want, Math.min(1, dt * 7))
  if (vel.lengthSq() > 0.01) { const m = vel.clone().multiplyScalar(dt); camera.position.add(m); controls.target.add(m) }
}

// hover a note for its name; click it to open; double click to dive to it
const tip = $('tip')
let hover = -1, downAt = null
const pickAt = (x, y) => {
  mouse.set(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1)
  ray.setFromCamera(mouse, camera)
  ray.params.Points.threshold = Math.max(3, camera.position.distanceTo(controls.target) * 0.012)
  const hits = ray.intersectObject(points)
  return hits.length ? hits[0].index : -1
}
renderer.domElement.addEventListener('pointermove', e => {
  hover = pickAt(e.clientX, e.clientY)
  if (hover < 0) { tip.style.display = 'none'; renderer.domElement.style.cursor = ''; return }
  const p = B.files[hover][0]
  tip.innerHTML = esc(p.split('/').pop()) + '<small>' + esc(p.split('/').slice(0, -1).join(' / ') || B.title) + '</small>'
  tip.style.display = 'block'; tip.style.left = (e.clientX + 14) + 'px'; tip.style.top = (e.clientY + 12) + 'px'
  renderer.domElement.style.cursor = 'pointer'
})
renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY, performance.now()] })
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || performance.now() - downAt[2] > 400) return
  const n = pickAt(e.clientX, e.clientY)
  if (n < 0) return
  clearTimeout(window.__open)
  window.__open = setTimeout(() => { const abs = B.root + '/' + B.files[n][0]; location.href = B.vault ? 'obsidian://open?path=' + encodeURIComponent(abs.normalize('NFD')) : 'file://' + encodeURI(abs) }, 260)
})
renderer.domElement.addEventListener('dblclick', e => {
  clearTimeout(window.__open)
  const n = pickAt(e.clientX, e.clientY)
  touched(); if (follow) setFollow(false)
  if (n >= 0) flyTo(P(n), 70)
})

// ---------- live data ----------
let lastV = -1, lastOk = 0
const live = $('live')
const poll = () => {
  const s = document.createElement('script')
  s.src = 'data.js?t=' + Date.now()
  s.onload = () => { s.remove(); lastOk = Date.now(); const d = window.BT_DATA; if (d && d.v !== lastV) { lastV = d.v; apply(d) } }
  s.onerror = () => s.remove()
  document.head.appendChild(s)
}
const introEnd = performance.now() + 2900
tweenTo(home.pos.clone(), home.target.clone(), 2800)
setInterval(poll, 1500); poll()
setInterval(() => { const ok = Date.now() - lastOk < 6000; live.className = 'hud br live' + (ok ? ' ok' : ''); live.lastChild.textContent = ok ? S.live : S.stale }, 1000)
setFollow(true)

// ---------- frame ----------
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight); pointMat.uniforms.scale.value = innerHeight * 1.3 })
const clock = new THREE.Clock()
const frame = () => {
  const dt = Math.min(0.05, clock.getDelta()), t = clock.elapsedTime
  pointMat.uniforms.time.value = t
  if (tween) {
    const k = Math.min(1, (performance.now() - tween.start) / tween.ms), e = ease(k)
    camera.position.lerpVectors(tween.p0, tween.p1, e); controls.target.lerpVectors(tween.t0, tween.t1, e)
    if (k >= 1) tween = null
  }
  if (!controls.autoRotate && !follow && performance.now() - lastTouch > 25000 && keys.size === 0) controls.autoRotate = true
  fly(dt)
  for (const c of comets) { const u = (c.off + t * c.speed) % 1; c.s.position.copy(c.cu.getPointAt(u)); const s = 18 + 14 * Math.sin(u * Math.PI); c.s.scale.set(s, s, 1); c.s.material.opacity = Math.sin(u * Math.PI) }
  controls.update()
  composer.render()
  drawLabels()
  requestAnimationFrame(frame)
}
frame()
window.BT = { dive: (n, d) => { setFollow(false); flyTo(P(n), d) } }
`
