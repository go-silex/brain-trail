/// <reference lib="dom" />
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { brain } from '../../hooks/scene3d'
import { kindColors } from '../../hooks/map'
import { LOGOS } from '../../hooks/logos'
import {
  dragAction,
  dragZoom,
  heldBesides,
  heldIn,
  pointerButton,
  wheelRows,
  wheelZoom,
  type DragAction,
  type PointerButton,
} from '../../hooks/pointer'
import { ZOOM_MAX, ZOOM_MIN } from '../../hooks/spin'
import type { Scene3dProps } from '../../types/view'

type Pose = {
  position: THREE.Vector3
  target: THREE.Vector3
  quaternion: THREE.Quaternion
}
// A press of the pointer on the scene. Mouse and pen drags are the scene's own (`action`);
// touch turns and pans stay OrbitControls'. A drag goes on in stretches: `from` is the camera
// the current one started from, at the pointer's (x, y); `wrote` the camera it last set, with
// the pointer at `at`. `mixed`: another button joined the press, which is then never a click.
type Press = {
  pointerId: number
  button: PointerButton
  action?: DragAction
  x: number
  y: number
  at: { x: number; y: number }
  mixed: boolean
  from?: Pose
  wrote?: Pose
}

// A scene belongs to one mounted map, not to an individual render of the pane.
export class WebGLScene {
  private readonly renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
  })
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(52, 1, 0.5, 30000)
  private readonly controls = new OrbitControls(
    this.camera,
    this.renderer.domElement,
  )
  private readonly composer = new EffectComposer(this.renderer)
  private readonly bloom = new UnrealBloomPass(
    new THREE.Vector2(1, 1),
    0.85,
    0.5,
    0.32,
  )
  private readonly output = new OutputPass()
  private readonly content = new THREE.Group()
  private readonly background = new THREE.Group()
  private backgroundLayout?: Scene3dProps['layout']
  private backgroundColor = ''
  private backgroundLight?: boolean
  private readonly ray = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly labels = document.createElement('div')
  private readonly tip = document.createElement('div')
  private labelItems: { element: HTMLElement; position: THREE.Vector3 }[] = []
  private hoverNames = true
  private adjusted = false
  // An OrbitControls touch turn or pan in progress: the spin waits for it, then resumes if it was on.
  private gesturing = false
  private readonly observer: ResizeObserver
  private points?: THREE.Points
  private readonly halo = this.makeHalo()
  private readonly logos = new Map<string, THREE.Texture>()
  private comets: {
    sprite: THREE.Sprite
    curve: THREE.QuadraticBezierCurve3
    offset: number
    speed: number
  }[] = []
  private props: Scene3dProps
  private frame = 0
  private width = 0
  private height = 0
  private press?: Press
  // the camera's distance for the whole picture: the zoom limits are relative to it, as on the SVG maps
  private fitted = 1
  private openTimer?: number
  private tween?: {
    start: number
    from: THREE.Vector3
    targetFrom: THREE.Vector3
    to: THREE.Vector3
    target: THREE.Vector3
  }
  private stoppingFollow = false
  private readonly velocity = new THREE.Vector3()
  private keys = new Set<string>()
  private last = 0
  private focused = -1
  private disposed = false

  constructor(
    private readonly element: HTMLElement,
    props: Scene3dProps,
  ) {
    this.props = props
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.domElement.tabIndex = 0
    this.renderer.domElement.setAttribute('aria-label', 'Interactive 3D map')
    element.appendChild(this.renderer.domElement)
    this.labels.className = 'bt-scene-labels'
    element.appendChild(this.labels)
    this.tip.className = 'bt-tip'
    this.tip.hidden = true
    element.appendChild(this.tip)
    this.scene.add(this.content)
    this.scene.add(this.background)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.composer.addPass(this.bloom)
    this.composer.addPass(this.output)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.07
    this.controls.rotateSpeed = 0.55
    this.controls.enableZoom = false
    this.controls.screenSpacePanning = true
    // Mouse and pen drags follow the maps' shared policy (`drag`), whatever modifier is held:
    // OrbitControls keeps touch and the spin, none of its button or modifier mappings.
    this.controls.mouseButtons = { LEFT: null, MIDDLE: null, RIGHT: null }
    this.controls.addEventListener('start', this.grab)
    this.controls.addEventListener('end', this.release)
    this.renderer.domElement.addEventListener('pointerdown', this.pointerDown)
    this.renderer.domElement.addEventListener('pointerup', this.pointerUp)
    this.renderer.domElement.addEventListener(
      'pointercancel',
      this.pointerCancel,
    )
    this.renderer.domElement.addEventListener(
      'lostpointercapture',
      this.pointerCancel,
    )
    this.renderer.domElement.addEventListener('mousedown', this.mouseDown)
    this.renderer.domElement.addEventListener('pointermove', this.pointerMove)
    this.renderer.domElement.addEventListener('pointerleave', this.pointerLeave)
    this.renderer.domElement.addEventListener('dblclick', this.doubleClick)
    this.renderer.domElement.addEventListener('wheel', this.wheel, {
      passive: false,
    })
    this.renderer.domElement.addEventListener('keydown', this.keyDown)
    this.renderer.domElement.addEventListener('keyup', this.keyUp)
    this.renderer.domElement.addEventListener('blur', this.blur)
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(element)
    this.build()
    this.fit()
    this.resize()
    this.follow()
    this.positionLabels()
    this.frame = requestAnimationFrame(this.tick)
  }

  update(props: Scene3dProps) {
    const previous = this.props
    this.props = props
    const changedLayout = previous.layout !== props.layout
    if (
      changedLayout ||
      previous.trail !== props.trail ||
      previous.palette !== props.palette
    )
      this.build()
    if (changedLayout) this.fit()
    const before = previous.state.cam3d,
      after = props.state.cam3d
    if (before.yaw !== after.yaw) {
      const offset = this.camera.position.clone().sub(this.controls.target)
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), after.yaw - before.yaw)
      this.camera.position.copy(this.controls.target).add(offset)
      this.adjusted = true
    }
    if (before.zoom !== after.zoom && before.zoom > 0 && after.zoom > 0) {
      this.zoomAbout(this.controls.target, before.zoom / after.zoom)
      this.adjusted = true
    }
    if (previous.state.zoomed && !props.state.zoomed && before === after)
      this.focused = -1
    if (!previous.state.zoomed && props.state.zoomed) this.focused = -1
    if (
      previous.state.camera !== null &&
      props.state.camera === null &&
      !props.state.zoomed
    )
      this.fit()
    this.follow()
    this.positionLabels()
  }

  private makeHalo() {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 64
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('Cannot create scene texture')
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32)
    gradient.addColorStop(0, 'rgba(255,255,255,1)')
    gradient.addColorStop(0.25, 'rgba(255,255,255,.55)')
    gradient.addColorStop(1, 'rgba(255,255,255,0)')
    context.fillStyle = gradient
    context.fillRect(0, 0, 64, 64)
    return new THREE.CanvasTexture(canvas)
  }

  private clearGroup(group: THREE.Group) {
    group.traverse((obj) => {
      if (
        obj instanceof THREE.Points ||
        obj instanceof THREE.Line ||
        obj instanceof THREE.Mesh ||
        obj instanceof THREE.Sprite
      ) {
        if (!(obj instanceof THREE.Sprite)) obj.geometry.dispose()
        const materials = Array.isArray(obj.material)
          ? obj.material
          : [obj.material]
        for (const material of materials) material.dispose()
      }
    })
    group.clear()
  }
  private clear() {
    this.clearGroup(this.content)
    this.points = undefined
    this.labels.replaceChildren()
    this.labelItems = []
    this.comets = []
  }

  private build() {
    this.clear()
    const { layout, trail, palette, semantics } = this.props
    const shape = brain(layout),
      colors = kindColors(palette)
    const background = new THREE.Color(palette.bg)
    this.scene.background = background
    const lightBackground =
      0.2126 * background.r + 0.7152 * background.g + 0.0722 * background.b >
      0.5
    // Bloom adds the bright background back over the entire light scene.
    this.bloom.enabled = !lightBackground
    const positions = new Float32Array(layout.files.length * 3)
    const color = new Float32Array(positions.length)
    const sizes = new Float32Array(layout.files.length)
    const phases = lightBackground
      ? undefined
      : new Float32Array(layout.files.length)
    const glows = lightBackground
      ? undefined
      : new Float32Array(layout.files.length)
    const c = new THREE.Color(),
      foreground = new THREE.Color(palette.fg)
    const random = (i: number) => {
      let t = Math.imul(i + 1, 2654435761) >>> 0
      t ^= t >>> 15
      t = Math.imul(t, 2246822519) >>> 0
      t ^= t >>> 13
      t = Math.imul(t, 3266489917) >>> 0
      t ^= t >>> 16
      return (t >>> 0) / 4294967296
    }
    const current = trail.moves.at(-1)?.n
    for (let i = 0; i < layout.files.length; i++) {
      positions.set([shape.X[i]!, shape.Y[i]!, shape.Z[i]!], i * 3)
      c.set(colors[semantics.kinds.get(i) ?? 'node'])
      if (!semantics.kinds.has(i)) c.lerp(foreground, 0.35)
      if (phases && glows) {
        phases[i] = random(i * 3 + 5)
        const touched = semantics.touched.has(i)
        glows[i] =
          i === current || touched ? 1 : semantics.kinds.has(i) ? 0.2 : 0
        sizes[i] =
          i === current
            ? 30
            : touched
              ? 16 + Math.log2((trail.state.get(i)?.count ?? 0) + 1) * 5
              : semantics.kinds.has(i)
                ? 9
                : 7 + random(i * 5) * 3
      } else {
        sizes[i] = semantics.kinds.has(i) ? 18 : 11
      }
      color.set([c.r, c.g, c.b], i * 3)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(color, 3))
    geometry.setAttribute('pointSize', new THREE.BufferAttribute(sizes, 1))
    if (phases && glows) {
      geometry.setAttribute('phase', new THREE.BufferAttribute(phases, 1))
      geometry.setAttribute('glow', new THREE.BufferAttribute(glows, 1))
    }
    this.points = new THREE.Points(
      geometry,
      new THREE.ShaderMaterial({
        uniforms: {
          scale: { value: Math.max(1, this.height) * 1.3 },
          time: { value: 0 },
        },
        vertexShader: lightBackground
          ? 'attribute float pointSize; uniform float scale; uniform float time; varying vec3 vColor; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); float pulse = 0.9 + 0.1*sin(time*1.1 + position.x*.02 + position.z*.01); gl_PointSize = clamp(pointSize * pulse * scale / -mv.z, 3.0, 70.0); gl_Position = projectionMatrix * mv; vColor = color * pulse; }'
          : 'attribute float pointSize; attribute float phase; attribute float glow; uniform float scale; uniform float time; varying vec3 vColor; varying float vGlow; varying float vFar; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); float tw = 0.8 + 0.2 * sin(time * 1.1 + phase * 6.283); float pulse = 1.0 + glow * 0.28 * sin(time * 2.6 + phase * 6.283); gl_PointSize = clamp(pointSize * pulse * scale / -mv.z, 3.0, 70.0); gl_Position = projectionMatrix * mv; vColor = color * mix(tw, 1.0, glow); vGlow = glow; vFar = 1.0 - smoothstep(1400.0, 9000.0, -mv.z); }',
        fragmentShader: lightBackground
          ? 'varying vec3 vColor; void main(){ float d = length(gl_PointCoord - vec2(0.5)); if (d > 0.5) discard; float a = pow(1.0 - d * 2.0, 1.5); gl_FragColor = vec4(vColor, a); }'
          : 'varying vec3 vColor; varying float vGlow; varying float vFar; void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; float core = 1.0 - smoothstep(0.0, 0.5, d); float a = pow(core, mix(2.2, 1.3, vGlow)); gl_FragColor = vec4(vColor, a * mix(0.5, 1.0, vGlow) * mix(0.35, 1.0, vFar)); }',
        transparent: true,
        depthWrite: false,
        blending: lightBackground
          ? THREE.NormalBlending
          : THREE.AdditiveBlending,
        vertexColors: true,
      }),
    )
    this.content.add(this.points)
    const point = (n: number) =>
      new THREE.Vector3(shape.X[n]!, shape.Y[n]!, shape.Z[n]!)
    const curves: THREE.QuadraticBezierCurve3[] = []
    if (
      this.backgroundLayout !== layout ||
      this.backgroundColor !== palette.fg ||
      this.backgroundLight !== lightBackground
    ) {
      this.clearGroup(this.background)
      this.backgroundLayout = layout
      this.backgroundColor = palette.fg
      this.backgroundLight = lightBackground
      // Synapses use the shared file positions; folder membership only selects neighbours.
      const folders = new Map<string, number[]>()
      layout.files.forEach(([path], i) => {
        const directory = path.slice(0, Math.max(0, path.lastIndexOf('/')))
        const list = folders.get(directory)
        if (list) list.push(i)
        else folders.set(directory, [i])
      })
      const segments: number[] = []
      for (const list of folders.values()) {
        for (const i of list) {
          let first = -1,
            second = -1,
            d1 = Infinity,
            d2 = Infinity
          for (const j of list) {
            if (i === j) continue
            const dx = shape.X[i]! - shape.X[j]!,
              dy = shape.Y[i]! - shape.Y[j]!,
              dz = shape.Z[i]! - shape.Z[j]!
            const distance = dx * dx + dy * dy + dz * dz
            if (distance < d1) {
              d2 = d1
              second = first
              d1 = distance
              first = j
            } else if (distance < d2) {
              d2 = distance
              second = j
            }
          }
          for (const j of [first, second])
            if (j > i)
              segments.push(
                shape.X[i]!,
                shape.Y[i]!,
                shape.Z[i]!,
                shape.X[j]!,
                shape.Y[j]!,
                shape.Z[j]!,
              )
        }
      }
      const synapses = new THREE.BufferGeometry()
      synapses.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(segments, 3),
      )
      this.background.add(
        new THREE.LineSegments(
          synapses,
          new THREE.LineBasicMaterial({
            color: lightBackground ? palette.fg : '#9fb6c4',
            transparent: true,
            opacity: lightBackground ? 0.08 : 0.045,
            blending: lightBackground
              ? THREE.NormalBlending
              : THREE.AdditiveBlending,
            depthWrite: false,
          }),
        ),
      )
      const rim = (color: string, opacity: number) =>
        new THREE.ShaderMaterial({
          uniforms: {
            tint: { value: new THREE.Color(color) },
            strength: { value: opacity },
          },
          vertexShader:
            'varying vec3 n; varying vec3 v; void main(){ vec4 p = modelViewMatrix * vec4(position,1.0); n = normalize(normalMatrix * normal); v = normalize(-p.xyz); gl_Position = projectionMatrix * p; }',
          fragmentShader:
            'uniform vec3 tint; uniform float strength; varying vec3 n; varying vec3 v; void main(){ float f = pow(1.0 - abs(dot(n,v)),4.5) * strength; gl_FragColor = vec4(tint*f,f); }',
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        })
      const membrane = new THREE.Mesh(
        new THREE.SphereGeometry(1, 64, 32),
        rim('#35b0ff', 0.1),
      )
      membrane.scale.set(
        shape.rMax * 1.08,
        Math.max(35, shape.yMax * 0.7),
        shape.rMax * 1.08,
      )
      membrane.position.y = shape.yMax * 0.3
      this.background.add(membrane)
      for (const label of shape.labels) {
        const lobe = new THREE.Mesh(
          new THREE.SphereGeometry(1, 32, 16),
          rim('#8fb0c4', 0.13),
        )
        lobe.position.set(
          label.u * Math.cos(label.a),
          label.v * 0.48,
          label.u * Math.sin(label.a),
        )
        lobe.scale.set(
          label.size,
          Math.max(30, label.v * 0.55),
          label.size * 1.15,
        )
        this.background.add(lobe)
      }
      const dust = new Float32Array(1400 * 3)
      for (let i = 0; i < 1400; i++) {
        const angle = i * 2.3999632297,
          y = 1 - ((i + 0.5) * 2) / 1400
        const radius = 5000 + (((i * 2654435761) >>> 0) / 4294967296) * 5000
        const ring = Math.sqrt(1 - y * y)
        dust.set(
          [
            Math.cos(angle) * ring * radius,
            y * radius,
            Math.sin(angle) * ring * radius,
          ],
          i * 3,
        )
      }
      const dustGeometry = new THREE.BufferGeometry()
      dustGeometry.setAttribute('position', new THREE.BufferAttribute(dust, 3))
      this.background.add(
        new THREE.Points(
          dustGeometry,
          new THREE.PointsMaterial({
            color: '#5b6b75',
            size: 14,
            transparent: true,
            opacity: 0.45,
            depthWrite: false,
          }),
        ),
      )
    }
    for (let i = 1; i < trail.moves.length; i++) {
      const a = trail.moves[i - 1]!,
        b = trail.moves[i]!
      if (
        a.n >= layout.files.length ||
        b.n >= layout.files.length ||
        a.n < 0 ||
        b.n < 0
      )
        continue
      const start = point(a.n),
        end = point(b.n),
        mid = start.clone().add(end).multiplyScalar(0.5)
      mid.y += 30 + start.distanceTo(end) * 0.16
      const curve = new THREE.QuadraticBezierCurve3(start, mid, end)
      curves.push(curve)
      const material = b.gap
        ? new THREE.LineDashedMaterial({
            color: colors.gap,
            dashSize: 10,
            gapSize: 8,
            transparent: true,
            opacity: Math.max(0.2, 1 - (trail.moves.length - i) / 35),
          })
        : new THREE.LineBasicMaterial({
            color: colors.read,
            transparent: true,
            opacity: Math.max(0.2, 1 - (trail.moves.length - i) / 35),
          })
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(curve.getPoints(40)),
        material,
      )
      if (b.gap) line.computeLineDistances()
      this.content.add(line)
    }
    const addLabel = (text: string, position: THREE.Vector3) => {
      const element = document.createElement('span')
      element.textContent = text
      this.labels.appendChild(element)
      this.labelItems.push({ element, position })
    }
    for (const label of shape.labels)
      addLabel(
        label.name,
        new THREE.Vector3(
          label.u * Math.cos(label.a),
          label.v,
          label.u * Math.sin(label.a),
        ),
      )
    const recent = trail.moves.at(-1)?.n
    if (recent !== undefined && recent >= 0 && recent < layout.files.length)
      addLabel(layout.files[recent]![0].split('/').pop() ?? '', point(recent))
    const services = [...trail.perSvc.entries()]
    const stations = new Map<string, THREE.Vector3>()
    services.forEach(([name, count], i) => {
      const angle =
        -Math.PI / 2 +
        (i - (services.length - 1) / 2) *
          Math.min(0.55, (Math.PI * 1.2) / Math.max(1, services.length))
      const position = new THREE.Vector3(
        Math.cos(angle) * shape.rMax,
        shape.yMax + layout.size * 0.18,
        Math.sin(angle) * shape.rMax,
      )
      stations.set(name, position)
      addLabel(`${name} · ${count}`, position)
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.halo,
          color: '#35b0ff',
          transparent: true,
          opacity: 0.55,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      )
      halo.position.copy(position)
      halo.scale.set(150, 150, 1)
      this.content.add(halo)
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(8, layout.size / 120), 12, 8),
        new THREE.MeshBasicMaterial({ color: '#35b0ff' }),
      )
      marker.position.copy(position)
      this.content.add(marker)
      const src = LOGOS[name]
      if (src !== undefined) {
        let texture = this.logos.get(src)
        if (texture === undefined) {
          texture = new THREE.TextureLoader().load(src)
          texture.colorSpace = THREE.SRGBColorSpace
          this.logos.set(src, texture)
        }
        const logo = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthWrite: false,
          }),
        )
        logo.position.copy(position)
        logo.scale.set(64, 64, 1)
        this.content.add(logo)
      }
    })
    for (const call of trail.calls) {
      const end = stations.get(call.svc)
      if (!end) continue
      const start =
        call.from !== undefined &&
        call.from >= 0 &&
        call.from < layout.files.length
          ? point(call.from)
          : new THREE.Vector3(0, shape.yMax, 0)
      const middle = start.clone().add(end).multiplyScalar(0.5)
      middle.y += 30 + start.distanceTo(end) * 0.16
      const curve = new THREE.QuadraticBezierCurve3(start, middle, end)
      curves.push(curve)
      this.content.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(curve.getPoints(24)),
          new THREE.LineBasicMaterial({
            color: call.err ? colors.gap : '#35b0ff',
            transparent: true,
            opacity: 0.6,
          }),
        ),
      )
    }
    curves.slice(-8).forEach((curve, i) => {
      for (let j = 0; j < 2; j++) {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: this.halo,
            color: '#ffc9a8',
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
        )
        sprite.scale.set(26, 26, 1)
        this.content.add(sprite)
        this.comets.push({
          sprite,
          curve,
          offset: (i * 0.37 + j * 0.5) % 1,
          speed: 0.35 + (i % 3) * 0.07,
        })
      }
    })
  }

  resetCamera() {
    if (this.stoppingFollow) return
    this.adjusted = false
    this.tween = undefined
    this.fit()
    this.focused = this.props.trail.moves.at(-1)?.n ?? -1
  }

  private fit() {
    const { layout, trail } = this.props
    const shape = brain(layout)
    const target = new THREE.Vector3(0, shape.yMax / 2, 0)
    const direction = new THREE.Vector3(0, 0.55, 1).normalize()
    const up = new THREE.Vector3(0, direction.z, -direction.y)
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    const tanH = tanV * Math.max(0.1, this.camera.aspect)
    let distance = 100
    const include = (x: number, y: number, z: number, padding = 0) => {
      const dy = y - target.y
      const depth = dy * direction.y + z * direction.z
      const vertical = dy * up.y + z * up.z
      distance = Math.max(
        distance,
        depth + ((Math.abs(x) + padding) * 1.12) / tanH,
        depth + ((Math.abs(vertical) + padding) * 1.12) / tanV,
      )
    }
    for (let i = 0; i < layout.files.length; i++)
      include(shape.X[i]!, shape.Y[i]!, shape.Z[i]!, 12)
    for (let i = 1; i < trail.moves.length; i++) {
      const a = trail.moves[i - 1]!.n,
        b = trail.moves[i]!.n
      if (
        a < 0 ||
        b < 0 ||
        a >= layout.files.length ||
        b >= layout.files.length
      )
        continue
      const dx = shape.X[a]! - shape.X[b]!,
        dy = shape.Y[a]! - shape.Y[b]!,
        dz = shape.Z[a]! - shape.Z[b]!
      include(
        (shape.X[a]! + shape.X[b]!) / 2,
        (shape.Y[a]! + shape.Y[b]!) / 2 +
          (30 + Math.hypot(dx, dy, dz) * 0.16) / 2,
        (shape.Z[a]! + shape.Z[b]!) / 2,
        12,
      )
    }
    for (const label of shape.labels)
      include(
        label.u * Math.cos(label.a),
        label.v,
        label.u * Math.sin(label.a),
        24,
      )
    const services = [...trail.perSvc.keys()]
    services.forEach((_, i) => {
      const angle =
        -Math.PI / 2 +
        (i - (services.length - 1) / 2) *
          Math.min(0.55, (Math.PI * 1.2) / Math.max(1, services.length))
      include(
        Math.cos(angle) * shape.rMax,
        shape.yMax + layout.size * 0.18,
        Math.sin(angle) * shape.rMax,
        75,
      )
    })
    this.controls.target.copy(target)
    this.camera.position.copy(target).addScaledVector(direction, distance)
    this.fitted = distance
    this.camera.far = Math.max(30000, distance * 4)
    this.camera.updateProjectionMatrix()
    this.controls.update()
    this.focused = -1
  }

  private resize() {
    if (this.disposed) return
    const width = this.element.clientWidth,
      height = this.element.clientHeight
    if (width <= 0 || height <= 0) return
    const first = this.width === 0 || this.height === 0
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height, false)
    this.composer.setSize(width, height)
    if (this.points?.material instanceof THREE.ShaderMaterial)
      this.points.material.uniforms.scale!.value = height * 1.3
    if ((first || !this.adjusted) && !this.props.state.zoomed) this.fit()
  }

  private follow() {
    if (!this.props.state.zoomed) return
    const n = this.props.trail.moves.at(-1)?.n
    if (
      n === undefined ||
      n === this.focused ||
      n < 0 ||
      n >= this.props.layout.files.length
    )
      return
    const shape = brain(this.props.layout)
    const target = new THREE.Vector3(shape.X[n]!, shape.Y[n]!, shape.Z[n]!)
    const direction = this.camera.position
      .clone()
      .sub(this.controls.target)
      .normalize()
    this.controls.target.copy(target)
    this.camera.position
      .copy(target)
      .addScaledVector(direction, Math.max(100, shape.rMax * 0.65))
    this.focused = n
  }

  setHover(enabled: boolean) {
    this.hoverNames = enabled
    if (!enabled) this.pointerLeave()
  }
  private grab = () => {
    this.gesturing = true
    this.manual()
  }
  private release = () => {
    this.gesturing = false
  }
  // Moving the camera by hand stops following Claude; the spin choice stays the person's.
  private manual = () => {
    this.adjusted = true
    this.tween = undefined
    if (this.props.state.zoomed && !this.stoppingFollow) {
      this.stoppingFollow = true
      void this.props
        .onIntent({ kind: 'follow', following: true })
        .finally(() => {
          this.stoppingFollow = false
        })
    }
  }
  // A press ends once: on its button's release, a cancel or a lost capture, or, when that
  // release was lost, at the next press, the first move or another button's release that no
  // longer holds its button. Only its own release, never dragged nor chorded, is a click.
  private pointerDown = (event: PointerEvent) => {
    this.renderer.domElement.focus()
    const button = pointerButton(event.button)
    if (button === undefined) return
    // no autoscroll: the middle button zooms
    if (button === 'middle') event.preventDefault()
    this.press = {
      pointerId: event.pointerId,
      button,
      action:
        event.pointerType === 'touch' ? undefined : dragAction(button, true),
      x: event.clientX,
      y: event.clientY,
      at: { x: event.clientX, y: event.clientY },
      mixed: false,
    }
    this.renderer.domElement.setPointerCapture(event.pointerId)
  }
  private pointerCancel = (event: PointerEvent) => {
    if (this.press?.pointerId === event.pointerId) this.press = undefined
  }
  private mouseDown = (event: MouseEvent) => {
    if (event.button === 1) event.preventDefault()
  }
  private pose(): Pose {
    return {
      position: this.camera.position.clone(),
      target: this.controls.target.clone(),
      quaternion: this.camera.quaternion.clone(),
    }
  }
  // whether the camera left a pose, beyond rounding
  private leftPose(pose: Pose) {
    const near = (1e-6 * this.fitted) ** 2
    return (
      this.camera.position.distanceToSquared(pose.position) > near ||
      this.controls.target.distanceToSquared(pose.target) > near
    )
  }
  // A drag applies the shared policy to the camera its stretch started from, with the pointer's
  // whole travel since then: left turns around the target, right pans, middle zooms on the
  // middle of the view (up in, down out). The projection is the scene's own.
  private drag(press: Press, event: PointerEvent) {
    if (press.action === undefined) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    if (press.from === undefined) {
      // a click until the pointer travels
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 5)
        return
      press.from = this.pose()
      this.manual()
    } else if (press.wrote !== undefined && this.leftPose(press.wrote)) {
      // Something else moved the camera since the drag did (the wheel, a key, a button): the
      // drag goes on from there, with the pointer's travel since it was last seen.
      press.from = this.pose()
      press.x = press.at.x
      press.y = press.at.y
    }
    const from = press.from,
      dx = event.clientX - press.x,
      dy = event.clientY - press.y
    const offset = from.position.clone().sub(from.target)
    this.controls.target.copy(from.target)
    if (press.action === 'orbit') {
      // as OrbitControls turns: a full turn for the view's height over the rotate speed
      const turn = (2 * Math.PI * this.controls.rotateSpeed) / rect.height
      const s = new THREE.Spherical().setFromVector3(offset)
      s.theta -= dx * turn
      s.phi = Math.max(
        this.controls.minPolarAngle,
        Math.min(this.controls.maxPolarAngle, s.phi - dy * turn),
      )
      s.makeSafe()
      this.camera.position.copy(from.target).add(offset.setFromSpherical(s))
    } else if (press.action === 'pan') {
      // the point at the target's depth stays under the pointer
      const unit =
        (2 *
          offset.length() *
          Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) /
        rect.height
      const move = new THREE.Vector3(-dx * unit, dy * unit, 0).applyQuaternion(
        from.quaternion,
      )
      this.controls.target.add(move)
      this.camera.position.copy(from.position).add(move)
    } else {
      this.camera.position.copy(from.position)
      this.zoomAbout(from.target, dragZoom(dy / rect.height))
    }
    press.wrote = this.pose()
    press.at = { x: event.clientX, y: event.clientY }
  }
  // Zooms by the shared factor `f` (> 1 out) around a point at the target's depth, which keeps
  // its place on the screen. The distance to the target stays within the SVG maps' zoom limits,
  // relative to the whole picture; a camera already beyond them only comes back.
  private zoomAbout(point: THREE.Vector3, f: number) {
    const distance = this.camera.position.distanceTo(this.controls.target)
    if (!(distance > 0) || !Number.isFinite(f) || f === 1) return
    const near = Math.min(this.fitted / ZOOM_MAX, distance),
      far = Math.max(this.fitted / ZOOM_MIN, distance),
      k = Math.max(near, Math.min(far, distance * f)) / distance
    if (k === 1) return
    const anchor = point.clone()
    this.camera.position.sub(anchor).multiplyScalar(k).add(anchor)
    this.controls.target.sub(anchor).multiplyScalar(k).add(anchor)
  }
  private pick(x: number, y: number) {
    if (!this.points) return undefined
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (!rect.width || !rect.height) return undefined
    this.pointer.set(
      ((x - rect.left) / rect.width) * 2 - 1,
      (-(y - rect.top) / rect.height) * 2 + 1,
    )
    this.ray.params.Points = {
      threshold: Math.max(
        3,
        this.camera.position.distanceTo(this.controls.target) * 0.012,
      ),
    }
    this.ray.setFromCamera(this.pointer, this.camera)
    return this.ray.intersectObject(this.points)[0]?.index
  }
  private pointerMove = (event: PointerEvent) => {
    const press = this.press
    if (press !== undefined && press.pointerId === event.pointerId) {
      if (heldIn(press.button, event.buttons)) {
        if (heldBesides(press.button, event.buttons)) press.mixed = true
        this.drag(press, event)
        return
      }
      this.press = undefined
    }
    if (this.press !== undefined || !this.hoverNames) return
    const n = this.pick(event.clientX, event.clientY)
    const path = n === undefined ? undefined : this.props.layout.files[n]?.[0]
    this.tip.hidden = path === undefined
    this.renderer.domElement.style.cursor = path === undefined ? '' : 'pointer'
    if (path !== undefined) {
      this.tip.textContent = path
      const rect = this.element.getBoundingClientRect()
      this.tip.style.left = `${Math.min(this.element.clientWidth - this.tip.offsetWidth, event.clientX - rect.left + 14)}px`
      this.tip.style.top = `${event.clientY - rect.top + 12}px`
    }
  }
  private pointerLeave = () => {
    this.tip.hidden = true
    this.renderer.domElement.style.cursor = ''
  }
  private pointerUp = (event: PointerEvent) => {
    const press = this.press
    if (press === undefined || press.pointerId !== event.pointerId) return
    // Another button came up: the press goes on while its own button is held; otherwise
    // its release went unseen and the press ends here, without a click.
    if (pointerButton(event.button) !== press.button) {
      if (heldIn(press.button, event.buttons)) press.mixed = true
      else this.press = undefined
      return
    }
    this.press = undefined
    // only a left click opens a note
    if (
      press.button !== 'left' ||
      press.mixed ||
      press.from !== undefined ||
      Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5
    )
      return
    const n = this.pick(event.clientX, event.clientY)
    const path = n === undefined ? undefined : this.props.layout.files[n]?.[0]
    if (path !== undefined) {
      clearTimeout(this.openTimer)
      this.openTimer = window.setTimeout(() => {
        void this.props.onOpen({ p: path })
      }, 260)
    }
  }
  private doubleClick = (event: MouseEvent) => {
    clearTimeout(this.openTimer)
    const n = this.pick(event.clientX, event.clientY)
    if (n === undefined) return
    this.manual()
    const shape = brain(this.props.layout)
    const target = new THREE.Vector3(shape.X[n]!, shape.Y[n]!, shape.Z[n]!)
    const direction = this.camera.position
      .clone()
      .sub(this.controls.target)
      .normalize()
    this.tween = {
      start: performance.now(),
      from: this.camera.position.clone(),
      targetFrom: this.controls.target.clone(),
      target,
      to: target.clone().addScaledVector(direction, 70),
    }
  }
  // The wheel zooms by the shared factor around the point under the pointer, at the target's depth.
  private wheel = (event: WheelEvent) => {
    event.preventDefault()
    const f = wheelZoom(wheelRows(event.deltaY, event.deltaMode))
    if (f === 1) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    this.manual()
    this.camera.updateMatrixWorld()
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.ray.setFromCamera(this.pointer, this.camera)
    const forward = this.camera.getWorldDirection(new THREE.Vector3()),
      depth = this.controls.target
        .clone()
        .sub(this.camera.position)
        .dot(forward),
      along = this.ray.ray.direction.dot(forward)
    if (!(depth > 0) || !(along > 0)) return
    this.zoomAbout(
      this.ray.ray.origin
        .clone()
        .addScaledVector(this.ray.ray.direction, depth / along),
      f,
    )
  }
  private keyDown = (event: KeyboardEvent) => {
    if (
      ![
        'KeyW',
        'KeyZ',
        'KeyS',
        'KeyA',
        'KeyQ',
        'KeyD',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Space',
        'ShiftLeft',
        'ShiftRight',
        'KeyE',
        'KeyC',
      ].includes(event.code)
    )
      return
    this.keys.add(event.code)
    this.manual()
    event.preventDefault()
  }
  private keyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code)
  }
  private blur = () => {
    this.keys.clear()
  }
  private positionLabels() {
    this.camera.updateMatrixWorld()
    const projected = new THREE.Vector3()
    for (const item of this.labelItems) {
      projected.copy(item.position).project(this.camera)
      const visible =
        projected.z >= -1 &&
        projected.z <= 1 &&
        Math.abs(projected.x) <= 1 &&
        Math.abs(projected.y) <= 1
      item.element.hidden = !visible
      if (visible) {
        item.element.style.left = `${(projected.x + 1) * 50}%`
        item.element.style.top = `${(1 - projected.y) * 50}%`
      }
    }
  }

  private tick = (now: number) => {
    if (this.disposed) return
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0
    this.last = now
    const forward = new THREE.Vector3()
    this.camera.getWorldDirection(forward)
    const right = new THREE.Vector3()
      .crossVectors(forward, this.camera.up)
      .normalize()
    const move = new THREE.Vector3()
    const has = (...keys: string[]) => keys.some((key) => this.keys.has(key))
    if (has('KeyW', 'KeyZ', 'ArrowUp')) move.add(forward)
    if (has('KeyS', 'ArrowDown')) move.sub(forward)
    if (has('KeyD', 'ArrowRight')) move.add(right)
    if (has('KeyA', 'KeyQ', 'ArrowLeft')) move.sub(right)
    if (has('Space', 'KeyE')) move.y++
    if (has('ShiftLeft', 'ShiftRight', 'KeyC')) move.y--
    if (move.lengthSq())
      move
        .normalize()
        .multiplyScalar(
          Math.max(
            60,
            Math.min(
              this.camera.position.distanceTo(this.controls.target),
              2400,
            ) * 0.9,
          ),
        )
    this.velocity.lerp(move, Math.min(1, dt * 7))
    if (this.velocity.lengthSq() > 0.01) {
      const step = this.velocity.clone().multiplyScalar(dt)
      this.camera.position.add(step)
      this.controls.target.add(step)
    }
    if (this.tween !== undefined) {
      const t = Math.min(1, (now - this.tween.start) / 1300)
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
      this.camera.position.lerpVectors(this.tween.from, this.tween.to, eased)
      this.controls.target.lerpVectors(
        this.tween.targetFrom,
        this.tween.target,
        eased,
      )
      if (t >= 1) this.tween = undefined
    }
    this.controls.autoRotate =
      this.props.state.cam3d.spin &&
      !this.gesturing &&
      this.press?.from === undefined &&
      this.tween === undefined &&
      !this.props.state.zoomed &&
      !this.keys.size
    this.controls.autoRotateSpeed = 0.35
    this.controls.update()
    if (this.points?.material instanceof THREE.ShaderMaterial)
      this.points.material.uniforms.time!.value = now / 1000
    for (const comet of this.comets)
      comet.curve.getPoint(
        ((now / 1000) * comet.speed + comet.offset) % 1,
        comet.sprite.position,
      )
    this.positionLabels()
    if (this.width && this.height) this.composer.render()
    this.frame = requestAnimationFrame(this.tick)
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.observer.disconnect()
    this.controls.removeEventListener('start', this.grab)
    this.controls.removeEventListener('end', this.release)
    this.controls.dispose()
    const canvas = this.renderer.domElement
    canvas.removeEventListener('pointerdown', this.pointerDown)
    canvas.removeEventListener('pointerup', this.pointerUp)
    canvas.removeEventListener('pointercancel', this.pointerCancel)
    canvas.removeEventListener('lostpointercapture', this.pointerCancel)
    canvas.removeEventListener('mousedown', this.mouseDown)
    canvas.removeEventListener('pointermove', this.pointerMove)
    canvas.removeEventListener('pointerleave', this.pointerLeave)
    canvas.removeEventListener('dblclick', this.doubleClick)
    canvas.removeEventListener('wheel', this.wheel)
    canvas.removeEventListener('keydown', this.keyDown)
    canvas.removeEventListener('keyup', this.keyUp)
    canvas.removeEventListener('blur', this.blur)
    clearTimeout(this.openTimer)
    this.tip.remove()
    this.clear()
    this.clearGroup(this.background)
    this.bloom.dispose()
    this.output.dispose()
    this.composer.dispose()
    this.halo.dispose()
    for (const texture of this.logos.values()) texture.dispose()
    this.logos.clear()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.labels.remove()
    canvas.remove()
  }
}
