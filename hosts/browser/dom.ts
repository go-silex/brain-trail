/// <reference lib="dom" />
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import { marked } from 'marked'
import { WebGLScene } from './scene3d'
import {
  heldBesides,
  heldIn,
  pointerButton,
  wheelRows,
  type PointerButton,
} from '../../hooks/pointer'
import type {
  MapGesture,
  Scene3dProps,
  MapTip,
  ViewBoxProps,
  ViewButtonProps,
  ViewChild,
  ViewCodeProps,
  ViewInputProps,
  ViewLinkProps,
  ViewMarkdownProps,
  ViewProps,
  ViewRuntime,
  ViewSpace,
  ViewSvgProps,
  ViewTag,
  ViewTextProps,
} from '../../types/view'

type Kind =
  | 'box'
  | 'text'
  | 'button'
  | 'input'
  | 'link'
  | 'svg'
  | 'markdown'
  | 'code'
  | 'map'
  | 'scene3d'
export type VNode = {
  kind: Kind
  props: ViewProps
  children: (VNode | string)[]
  key: string | undefined
}
type Slot = {
  value: VNode | string
  node: Node
  children: Slot[]
  scene?: WebGLScene
  observer?: ResizeObserver
}
export type MapHandlers = {
  gesture: (g: MapGesture) => MapTip | null
  wheel: (by: number, fx: number, fy: number) => boolean
  resize: (width: number, height: number) => void
}

const flatten = (input: ViewChild<VNode>, out: (VNode | string)[]) => {
  if (Array.isArray(input)) {
    for (const child of input) flatten(child, out)
  } else if (typeof input === 'string' || typeof input === 'number')
    out.push(String(input))
  else if (typeof input === 'object' && input !== null && 'kind' in input)
    out.push(input)
}
const tag =
  <P extends ViewProps>(kind: Kind): ViewTag<P, VNode> =>
  (props) => {
    const children: (VNode | string)[] = []
    if (props.children !== undefined) flatten(props.children, children)
    const key = typeof props.key === 'string' ? props.key : undefined
    return { kind, props, children, key }
  }
export const runtime: ViewRuntime<VNode, MouseEvent> = {
  h: (component, props, ...children) =>
    component(Object.assign({}, props, children.length ? { children } : {})),
  Box: tag('box'),
  Text: tag('text'),
  Button: tag('button'),
  Input: tag('input'),
  Link: tag('link'),
  Svg: tag('svg'),
  Markdown: tag('markdown'),
  Code: tag('code'),
  MapHit: tag('map'),
  Scene3d: tag('scene3d'),
}
const space = (value: ViewSpace | undefined, axis: 'x' | 'y') => {
  if (value === undefined) return ''
  const n =
    typeof value === 'number'
      ? value * (axis === 'x' ? 8 : 16)
      : { xs: 4, sm: 8, md: 16 }[value]
  return `${n}px`
}
const dimension = (value: string | number | undefined, axis: 'x' | 'y') =>
  value === undefined
    ? ''
    : typeof value === 'number'
      ? `${value * (axis === 'x' ? 8 : 16)}px`
      : value
const safeLink = (href: string) => {
  if (href.trim() === '') return ''
  try {
    const url = new URL(href, location.href)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : ''
  } catch {
    return ''
  }
}
const sanitize = (html: string) =>
  DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'],
    FORBID_ATTR: ['style', 'srcset'],
  })
const links = (el: HTMLElement) => {
  for (const a of el.querySelectorAll('a')) {
    const href = safeLink(a.getAttribute('href') ?? '')
    if (href === '') a.removeAttribute('href')
    else {
      a.href = href
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
    }
  }
}
const language = (p: ViewCodeProps) => {
  const ext = p.path?.split('.').pop()?.toLowerCase()
  const aliases: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    sh: 'bash',
    md: 'markdown',
    yml: 'yaml',
    rs: 'rust',
    html: 'xml',
  }
  return p.language ?? (ext === undefined ? undefined : (aliases[ext] ?? ext))
}

export class DomRenderer {
  private root: Slot | undefined
  private mapPressSequence = 0
  hoverNames = true
  constructor(
    private readonly container: HTMLElement,
    private readonly map: MapHandlers,
  ) {}
  render(value: VNode) {
    this.root = this.patch(this.container, this.root, value)
    if (this.container.firstChild !== this.root.node)
      this.container.appendChild(this.root.node)
  }
  resetScene() {
    const visit = (slot: Slot) => {
      slot.scene?.resetCamera()
      for (const child of slot.children) visit(child)
    }
    if (this.root !== undefined) visit(this.root)
  }
  dispose() {
    if (this.root !== undefined) this.disposeSlot(this.root)
    this.root = undefined
    this.container.replaceChildren()
  }
  private disposeSlot(slot: Slot) {
    slot.scene?.dispose()
    slot.observer?.disconnect()
    for (const child of slot.children) this.disposeSlot(child)
  }
  private patch(
    parent: Node,
    old: Slot | undefined,
    value: VNode | string,
  ): Slot {
    const compatible =
      old !== undefined &&
      ((typeof old.value === 'string' && typeof value === 'string') ||
        (typeof old.value !== 'string' &&
          typeof value !== 'string' &&
          old.value.kind === value.kind &&
          old.value.key === value.key))
    if (!compatible) {
      const node =
        typeof value === 'string'
          ? document.createTextNode(value)
          : this.create(value.kind)
      const slot: Slot = { value, node, children: [] }
      if (old !== undefined) {
        this.disposeSlot(old)
        parent.replaceChild(node, old.node)
      } else parent.appendChild(node)
      if (typeof value !== 'string') this.update(slot, value, undefined)
      return slot
    }
    if (old === undefined) throw new Error('Missing DOM slot')
    if (typeof value === 'string') {
      if (old.value !== value) old.node.textContent = value
      old.value = value
      return old
    }
    const previous = typeof old.value === 'string' ? undefined : old.value
    this.update(old, value, previous)
    old.value = value
    return old
  }
  private create(kind: Kind): HTMLElement {
    const element = document.createElement(
      kind === 'button'
        ? 'button'
        : kind === 'link'
          ? 'a'
          : kind === 'svg'
            ? 'img'
            : kind === 'input'
              ? 'form'
              : kind === 'text'
                ? 'span'
                : 'div',
    )
    if (kind === 'map') this.installMap(element)
    return element
  }
  private update(slot: Slot, value: VNode, previous: VNode | undefined) {
    const el = slot.node as HTMLElement
    if (value.kind === 'scene3d') {
      el.className = 'bt-scene3d'
      const props = value.props as Scene3dProps
      if (slot.scene === undefined) slot.scene = new WebGLScene(el, props)
      else slot.scene.update(props)
      slot.scene.setHover(this.hoverNames)
      return
    }
    if (value.key !== undefined) el.dataset.key = value.key
    else delete el.dataset.key
    el.className = `bt-${value.kind}`
    if (value.key === 'map-wrap' && slot.observer === undefined) {
      slot.observer = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect
        if (rect && rect.width > 0 && rect.height > 0)
          this.map.resize(rect.width, rect.height)
      })
      slot.observer.observe(el)
    }
    if (value.kind === 'box') {
      const p = value.props as ViewBoxProps,
        s = el.style
      s.flexDirection = p.flexDirection ?? 'column'
      s.flexWrap = p.flexWrap ?? ''
      s.flexGrow = p.flexGrow?.toString() ?? ''
      s.flexShrink = p.flexShrink?.toString() ?? ''
      s.alignItems = p.alignItems ?? ''
      s.justifyContent = p.justifyContent ?? ''
      s.columnGap = space(p.columnGap ?? p.gap, 'x')
      s.rowGap = space(p.rowGap ?? p.gap, 'y')
      s.padding =
        p.padding === undefined
          ? ''
          : `${space(p.padding, 'y')} ${space(p.padding, 'x')}`
      if (p.paddingX !== undefined) {
        s.paddingLeft = space(p.paddingX, 'x')
        s.paddingRight = space(p.paddingX, 'x')
      }
      if (p.paddingLeft !== undefined) s.paddingLeft = space(p.paddingLeft, 'x')
      s.marginTop = space(p.marginTop, 'y')
      s.width = dimension(p.width, 'x')
      s.height = dimension(p.height, 'y')
      s.minWidth = dimension(p.minWidth, 'x')
      s.minHeight = dimension(p.minHeight, 'y')
      s.overflow = p.overflow ?? ''
      s.position = p.position ?? ''
      s.top = dimension(p.top, 'y')
      s.bottom = dimension(p.bottom, 'y')
      s.left = dimension(p.left, 'x')
      s.right = dimension(p.right, 'x')
      s.border =
        p.borderStyle === 'single'
          ? `1px solid ${p.borderColor ?? 'var(--line)'}`
          : ''
    } else if (value.kind === 'text') {
      const p = value.props as ViewTextProps
      el.className += `${p.size ? ` bt-${p.size}` : ''}${p.weight === 'medium' ? ' bt-medium' : ''}${p.dimColor ? ' bt-dim' : ''}${p.mono ? ' bt-mono' : ''}${p.tabular ? ' bt-tabular' : ''}${p.wrap ? ` bt-${p.wrap}` : ''}`
      el.style.color = p.color === 'error' ? 'var(--error)' : (p.color ?? '')
    } else if (value.kind === 'button') {
      const p = value.props as ViewButtonProps<MouseEvent>,
        button = el as HTMLButtonElement
      button.type = 'button'
      button.className += `${p.plain ? ' bt-plain' : ''}${p.variant === 'primary' ? ' bt-primary' : ''}${p.dimColor ? ' bt-dim' : ''}`
      button.onclick = (event) => p.onPress(event)
      if (value.children.length === 0) button.textContent = p.label ?? ''
    } else if (value.kind === 'input') {
      const p = value.props as ViewInputProps
      let input = el.querySelector('input')
      if (input === null) {
        input = document.createElement('input')
        el.appendChild(input)
      }
      input.placeholder = p.placeholder ?? ''
      const old = previous?.props as ViewInputProps | undefined
      if (p.value !== old?.value && p.value !== undefined) input.value = p.value
      el.onsubmit = (event) => {
        event.preventDefault()
        p.onSubmit(input.value)
      }
      let button = el.querySelector('button')
      if (p.submitLabel !== undefined) {
        if (button === null) {
          button = document.createElement('button')
          button.type = 'submit'
          el.appendChild(button)
        }
        button.textContent = p.submitLabel
      } else button?.remove()
      return
    } else if (value.kind === 'link') {
      const p = value.props as ViewLinkProps,
        a = el as HTMLAnchorElement,
        href = safeLink(p.href)
      if (href) {
        a.href = href
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
      } else a.removeAttribute('href')
      a.textContent = p.label
      return
    } else if (value.kind === 'svg') {
      const p = value.props as ViewSvgProps,
        img = el as HTMLImageElement,
        old = previous?.props as ViewSvgProps | undefined
      if (p.source !== old?.source)
        img.src = `data:image/svg+xml,${encodeURIComponent(p.source)}`
      img.alt = p.alt
      img.style.width = p.width === undefined ? '100%' : `${p.width}px`
      img.style.height = p.height === undefined ? 'auto' : `${p.height}px`
      return
    } else if (value.kind === 'markdown') {
      const p = value.props as ViewMarkdownProps,
        old = previous?.props as ViewMarkdownProps | undefined
      if (p.text !== old?.text) {
        el.innerHTML = sanitize(marked(p.text, { async: false, gfm: true }))
        for (const code of el.querySelectorAll('pre code')) {
          const languageClass = Array.from(code.classList).find((name) =>
            name.startsWith('language-'),
          )
          const lang = languageClass?.slice('language-'.length)
          if (lang !== undefined && hljs.getLanguage(lang)) {
            const highlighted = hljs.highlight(code.textContent ?? '', {
              language: lang,
              ignoreIllegals: true,
            })
            code.innerHTML = sanitize(highlighted.value)
            code.classList.add('hljs')
          }
        }
        links(el)
      }
      return
    } else if (value.kind === 'code') {
      const p = value.props as ViewCodeProps,
        old = previous?.props as ViewCodeProps | undefined
      if (
        p.source !== old?.source ||
        p.language !== old?.language ||
        p.path !== old?.path
      ) {
        const lang = language(p),
          result =
            lang !== undefined && hljs.getLanguage(lang)
              ? hljs.highlight(p.source, {
                  language: lang,
                  ignoreIllegals: true,
                })
              : hljs.highlightAuto(p.source)
        el.innerHTML = `<pre><code>${sanitize(result.value)}</code></pre>`
      }
      return
    } else if (value.kind === 'map') return
    this.children(el, slot, value.children)
  }
  private children(parent: HTMLElement, slot: Slot, next: (VNode | string)[]) {
    const old = slot.children,
      used = new Set<Slot>(),
      keys = new Map<string, Slot>()
    for (const child of old)
      if (typeof child.value !== 'string' && child.value.key !== undefined)
        keys.set(child.value.key, child)
    const result: Slot[] = []
    next.forEach((value, index) => {
      const key = typeof value === 'string' ? undefined : value.key
      const positional = old[index]
      const candidate =
        key === undefined
          ? positional !== undefined &&
            (typeof positional.value === 'string' ||
              positional.value.key === undefined)
            ? positional
            : undefined
          : keys.get(key)
      const selected =
        candidate !== undefined && !used.has(candidate) ? candidate : undefined
      if (selected !== undefined) used.add(selected)
      const child = this.patch(parent, selected, value)
      const at = parent.childNodes[index]
      if (at !== child.node) parent.insertBefore(child.node, at ?? null)
      result.push(child)
    })
    for (const child of old)
      if (!used.has(child) && child.node.parentNode === parent) {
        this.disposeSlot(child)
        parent.removeChild(child.node)
      }
    slot.children = result
  }
  private installMap(el: HTMLElement) {
    const tip = document.createElement('div')
    tip.className = 'bt-tip'
    tip.hidden = true
    el.appendChild(tip)
    let down:
        | {
            x: number
            y: number
            fx: number
            fy: number
            button: PointerButton
            press: number
            // another button joined the press: it is then never a click
            mixed: boolean
          }
        | undefined,
      dragging = false
    const point = (e: PointerEvent | WheelEvent) => {
      const r = el.getBoundingClientRect()
      return {
        fx: (e.clientX - r.left) / Math.max(1, r.width),
        fy: (e.clientY - r.top) / Math.max(1, r.height),
        x: e.clientX - r.left,
        y: e.clientY - r.top,
      }
    }
    const show = (t: MapTip | null) => {
      tip.hidden = t === null
      if (t !== null) {
        tip.textContent = t.text
        tip.style.left = `${Math.max(0, Math.min(el.clientWidth - tip.offsetWidth, t.x + 8))}px`
        tip.style.top = `${Math.max(0, t.y - 16)}px`
      }
    }
    // A press ends once: on its button's release, a cancel or a lost capture, or, when that
    // release was lost, at the next press, the first move or another button's release that no
    // longer holds its button. Only its own release, never dragged nor chorded, is a click.
    const release = () => {
      if (dragging) show(this.map.gesture({ kind: 'dragend' }))
      down = undefined
      dragging = false
    }
    el.oncontextmenu = (event) => event.preventDefault()
    // The middle button zooms the map: no autoscroll, no paste, no middle click.
    el.onmousedown = (event) => {
      if (event.button === 1) event.preventDefault()
    }
    el.onauxclick = (event) => event.preventDefault()
    el.onpointerdown = (event) => {
      const button = pointerButton(event.button)
      if (button === undefined) return
      release()
      if (button === 'middle') event.preventDefault()
      const p = point(event)
      this.mapPressSequence =
        this.mapPressSequence >= Number.MAX_SAFE_INTEGER
          ? 1
          : this.mapPressSequence + 1
      down = { ...p, button, press: this.mapPressSequence, mixed: false }
      dragging = false
      el.setPointerCapture(event.pointerId)
    }
    el.onpointermove = (event) => {
      const p = point(event)
      if (down !== undefined && !heldIn(down.button, event.buttons)) release()
      if (down !== undefined && heldBesides(down.button, event.buttons))
        down.mixed = true
      if (down !== undefined) {
        if (
          dragging ||
          Math.abs(p.x - down.x) >= 8 ||
          Math.abs(p.y - down.y) >= 16
        ) {
          dragging = true
          show(
            this.map.gesture({
              kind: 'drag',
              press: down.press,
              button: down.button,
              fx: p.fx,
              fy: p.fy,
              sfx: down.fx,
              sfy: down.fy,
            }),
          )
        }
      } else show(this.map.gesture({ kind: 'hover', ...p }))
    }
    el.onpointerup = (event) => {
      if (down === undefined) return
      if (pointerButton(event.button) !== down.button) {
        if (heldIn(down.button, event.buttons)) down.mixed = true
        else release()
        return
      }
      if (dragging || down.mixed) {
        release()
        return
      }
      const p = point(event),
        button = down.button
      down = undefined
      show(this.map.gesture({ kind: 'click', fx: p.fx, fy: p.fy, button }))
    }
    el.onpointercancel = () => release()
    el.onlostpointercapture = () => release()
    el.onpointerleave = () => {
      if (down === undefined) show(this.map.gesture({ kind: 'leave' }))
    }
    el.addEventListener(
      'wheel',
      (event) => {
        const p = point(event),
          by = wheelRows(event.deltaY, event.deltaMode)
        if (by !== 0 && this.map.wheel(by, p.fx, p.fy)) event.preventDefault()
      },
      { passive: false },
    )
  }
}
