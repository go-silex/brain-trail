/// <reference lib="dom" />
import { makeIndex, type Index } from '../../hooks/files'
import { createMapRenderer, DARK, LIGHT } from '../../hooks/map'
import {
  cameraDuringGesture,
  GESTURE0,
  VIEW_STATE0,
  mapGesture,
  isSharedViewIntent,
  mapWheel,
  openTarget,
  plan,
} from '../../hooks/view-controller'
import { renderPane } from '../../hooks/views'
import type { PreviewRef } from '../../types/model'
import type {
  DrawnFrames,
  GestureMemory,
  Step,
  TabSnapshot,
  ViewActions,
  ViewIntent,
  ViewSnapshot,
  ViewState,
} from '../../types/view'
import type {
  CommandReplies,
  FactsWire,
  HostCommand,
  LayoutWire,
  ServerEvent,
} from '../../types/browser'
import { DomRenderer, runtime } from './dom'

export function startPage(
  container: HTMLElement,
  status: HTMLElement,
  toastElement: HTMLElement,
) {
  const handoffUrl = new URL(window.location.href)
  const rawGeneration = handoffUrl.searchParams.get('generation')
  const path = handoffUrl.searchParams.get('file')
  const hadHandoff = rawGeneration !== null || path !== null
  const requestedGeneration =
    rawGeneration !== null && /^[1-9]\d*$/.test(rawGeneration)
      ? Number(rawGeneration)
      : 0
  let pendingFile =
    Number.isSafeInteger(requestedGeneration) &&
    requestedGeneration > 0 &&
    path !== null &&
    path !== ''
      ? { generation: requestedGeneration, p: path }
      : undefined
  if (hadHandoff) {
    handoffUrl.searchParams.delete('generation')
    handoffUrl.searchParams.delete('file')
    history.replaceState(history.state, '', handoffUrl)
  }
  let state: ViewState = { ...VIEW_STATE0, view3d: true },
    memory: GestureMemory = { ...GESTURE0 }
  let generation = 0,
    revision = 0,
    facts: FactsWire | undefined,
    layout: LayoutWire | undefined,
    index: Index | undefined
  let frames: DrawnFrames = { d2: undefined, d3: undefined },
    maps = createMapRenderer()
  let mapWidth = 0,
    mapHeight = 0
  let toastTimer: number | undefined
  let preview:
      | { ref: PreviewRef; status: 'pending' }
      | { ref: PreviewRef; status: 'ready'; text: string | undefined }
      | { ref: PreviewRef; status: 'failed' }
      | undefined,
    previewSerial = 0,
    ended = false
  const theme = matchMedia('(prefers-color-scheme: light)')
  const toast = (message: string) => {
    toastElement.textContent = message
    clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      toastElement.textContent = ''
    }, 5000)
  }
  if (hadHandoff && pendingFile === undefined) toast('Invalid file link')
  const reset = (next: number) => {
    generation = next
    revision = 0
    facts = undefined
    layout = undefined
    index = undefined
    state = { ...VIEW_STATE0, view3d: true }
    memory = { ...GESTURE0 }
    frames = { d2: undefined, d3: undefined }
    maps = createMapRenderer()
    preview = undefined
    previewSerial++
    ended = false
    dom.dispose()
  }
  const apply = (steps: Step[]) => {
    for (const step of steps)
      switch (step.key) {
        case 'tab':
          state = { ...state, tab: step.next(state.tab) }
          break
        case 'open':
          state = { ...state, open: step.next(state.open) }
          break
        case 'zoomed':
          state = { ...state, zoomed: step.next(state.zoomed) }
          break
        case 'camera':
          state = { ...state, camera: step.next(state.camera) }
          break
        case 'play':
          state = { ...state, play: step.next(state.play) }
          break
        case 'view3d':
          state = { ...state, view3d: step.next(state.view3d) }
          break
        case 'cam3d':
          state = { ...state, cam3d: step.next(state.cam3d) }
          break
        case 'preview':
          state = { ...state, preview: step.next(state.preview) }
          break
      }
  }
  const command = async <C extends HostCommand>(
    cmd: C,
  ): Promise<CommandReplies[C['kind']] | undefined> => {
    if (ended || generation === 0) {
      toast('Session unavailable')
      return undefined
    }
    const currentGeneration = generation
    try {
      const response = await fetch('command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ v: 1, generation, command: cmd }),
        referrerPolicy: 'no-referrer',
      })
      const result: CommandReplies[C['kind']] | { ok: false; error: string } =
        await response.json()
      if (ended || generation !== currentGeneration) return undefined
      if (!result.ok) {
        toast(result.error)
        return undefined
      }
      return result
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Command failed')
      return undefined
    }
  }
  const sameRef = (a: PreviewRef | null | undefined, b: PreviewRef) =>
    a?.p === b.p && Boolean(a.out) === Boolean(b.out)
  const loadPreview = async (ref: PreviewRef) => {
    const serial = ++previewSerial,
      currentGeneration = generation
    preview = { ref, status: 'pending' }
    const result = await command({ kind: 'preview-read', ref })
    if (
      ended ||
      generation !== currentGeneration ||
      serial !== previewSerial ||
      !sameRef(state.preview, ref)
    )
      return
    preview =
      result === undefined
        ? { ref, status: 'failed' }
        : { ref, status: 'ready', text: result.text ?? undefined }
    render()
  }
  const intent = async (i: ViewIntent) => {
    if (ended || generation === 0) return
    if (isSharedViewIntent(i)) {
      const result = await command({ kind: 'view', intent: i })
      if (result === undefined) return
      apply(
        plan(i, { now: Date.now(), frames, view3d: state.view3d }).filter(
          (step) =>
            step.key !== 'zoomed' &&
            step.key !== 'play' &&
            step.key !== 'preview',
        ),
      )
      render()
      // after the scene took the new props (a zoom change scales its camera): it fits the whole
      // brain again, whatever its own camera did, even when the props did not change; a reset
      // of the 2D map leaves the 3D scene's camera alone
      if (
        (i.kind === 'whole' && state.view3d) ||
        (i.kind === 'follow' && i.following)
      )
        dom.resetScene()
      return
    }
    const steps = plan(i, { now: Date.now(), frames, view3d: state.view3d })
    if (steps.some((step) => step.key === 'zoomed') && state.zoomed) {
      if (
        (await command({ kind: 'view', intent: { kind: 'whole' } })) ===
        undefined
      )
        return
    }
    apply(
      steps.filter(
        (step) =>
          step.key !== 'zoomed' &&
          step.key !== 'play' &&
          step.key !== 'preview',
      ),
    )
    if (state.tab !== 'map' || i.kind === 'toggle-3d') memory = GESTURE0
    render()
  }
  const openFile = async (ref: PreviewRef) => {
    if (facts === undefined) return
    const target = openTarget(facts.settings, index, ref)
    if (target.kind === 'preview')
      await intent({ kind: 'preview', ref: target.ref })
    else await command({ kind: 'open', ref, app: target.app })
  }
  const drainFile = () => {
    if (
      pendingFile === undefined ||
      ended ||
      facts === undefined ||
      facts.workspace.kind !== 'ready' ||
      layout === undefined ||
      layout.layoutRev !== facts.workspace.layoutRev ||
      index === undefined
    )
      return
    const file = pendingFile
    pendingFile = undefined
    if (!index.ids.has(file.p)) {
      toast('File is no longer in this workspace')
      return
    }
    void openFile({ p: file.p })
  }
  const actions: ViewActions<MouseEvent> = {
    intent,
    openFile,
    openIn: async (ref, app) => {
      await command({ kind: 'open', ref, app })
    },
    copy: async (text) => {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Clipboard unavailable')
        return false
      }
    },
    toast,
    compact: async () =>
      (await command({ kind: 'compact' }))?.outcome ?? { kind: 'failed' },
    refreshMeter: async () => {
      await command({ kind: 'refresh-meter' })
    },
    saveSettings: async (patch) => {
      await command({ kind: 'settings', patch })
    },
    setLang: async (lang) => {
      await command({ kind: 'lang', lang })
    },
    clearTrail: async () => {
      await command({ kind: 'clear-trail' })
    },
    retryLayout: () => {
      void command({ kind: 'retry-layout' })
    },
    open3d: async () => {
      if (ended) return false
      try {
        if (document.fullscreenElement) await document.exitFullscreen()
        else await document.documentElement.requestFullscreen()
        return true
      } catch {
        toast('Fullscreen unavailable')
        return false
      }
    },
    analyseCoach: async () => {
      await command({ kind: 'coach-analyse' })
    },
    applyCoach: async () =>
      (await command({ kind: 'coach-apply' }))?.filled ?? false,
  }
  const dom = new DomRenderer(container, {
    gesture: (gesture) => {
      if (ended || facts === undefined || state.tab !== 'map') return null
      const result = mapGesture(gesture, state, memory, frames, {
        now: Date.now(),
        hoverNames: facts.settings.hover,
      })
      memory = result.memory
      if (result.steps.some((step) => step.key === 'zoomed') && state.zoomed)
        void command({ kind: 'view', intent: { kind: 'whole' } })
      apply(
        result.steps.filter(
          (step) =>
            step.key !== 'zoomed' &&
            step.key !== 'play' &&
            step.key !== 'preview',
        ),
      )
      if (result.open !== undefined) void openFile(result.open)
      if (result.steps.length > 0) render()
      return result.tip
    },
    wheel: (by, fx, fy) => {
      if (ended || state.tab !== 'map') return false
      const result = mapWheel(
        by,
        state.view3d,
        { fx, fy },
        memory,
        frames,
        Date.now(),
      )
      memory = result.memory
      const steps = result.steps
      if (!steps.length) return false
      if (steps.some((step) => step.key === 'zoomed') && state.zoomed)
        void command({ kind: 'view', intent: { kind: 'whole' } })
      apply(
        steps.filter(
          (step) =>
            step.key !== 'zoomed' &&
            step.key !== 'play' &&
            step.key !== 'preview',
        ),
      )
      render()
      return true
    },
    resize: (width, height) => {
      if (
        Math.abs(width - mapWidth) < 0.5 &&
        Math.abs(height - mapHeight) < 0.5
      )
        return
      mapWidth = width
      mapHeight = height
      render()
    },
  })
  function render() {
    if (facts === undefined || ended) return
    container.dataset.tab = state.tab
    const f = facts,
      connected = new Map(f.connected.map(([k, v]) => [k, new Set(v)])),
      fold = { index, connected, linked: new Set(f.linked) }
    let body: TabSnapshot
    switch (state.tab) {
      case 'context':
        body = {
          tab: 'context',
          breakdown: f.breakdown,
          costHistory: f.costHistory,
          settings: f.settings,
        }
        break
      case 'goal':
        body = { tab: 'goal', connected }
        break
      case 'coach':
        body = {
          tab: 'coach',
          breakdown: f.breakdown,
          fold,
          coach: f.coach,
          instructionFile: f.instructionFile,
        }
        break
      case 'settings':
        body = { tab: 'settings', settings: f.settings, apps: f.apps }
        break
      case 'files':
        if (f.workspace.kind === 'loading') return
        body = {
          tab: 'files',
          breakdown: f.breakdown,
          fold,
          preview:
            state.preview === null
              ? null
              : {
                  ref: state.preview,
                  text:
                    preview !== undefined &&
                    sameRef(state.preview, preview.ref) &&
                    preview.status === 'ready'
                      ? preview.text
                      : undefined,
                  pending:
                    preview === undefined ||
                    !sameRef(state.preview, preview.ref) ||
                    preview.status === 'pending',
                  settings: f.settings,
                  apps: f.apps,
                },
        }
        break
      case 'map':
        if (f.workspace.kind === 'failed')
          body = { tab: 'map', kind: 'failed', message: f.workspace.message }
        else if (f.workspace.kind === 'loading')
          body = {
            tab: 'map',
            kind: 'loading',
            seconds: Math.max(
              0,
              Math.round((Date.now() - f.workspace.since) / 1000),
            ),
          }
        else if (
          layout === undefined ||
          index === undefined ||
          layout.layoutRev !== f.workspace.layoutRev
        )
          return
        else {
          const cam3d = cameraDuringGesture(state.cam3d, memory)
          body = {
            tab: 'map',
            kind: 'ready',
            layout: layout.layout,
            shallow: f.workspace.shallow,
            fold: { ...fold, index },
            state: cam3d === state.cam3d ? state : { ...state, cam3d },
          }
        }
        break
    }
    const style = getComputedStyle(container)
    const availableHeight = Math.max(
      1,
      container.clientHeight -
        parseFloat(style.paddingTop) -
        parseFloat(style.paddingBottom),
    )
    const snapshot: ViewSnapshot = {
      now: Date.now(),
      widthPx: Math.max(
        240,
        Math.floor(mapWidth || container.clientWidth - 24),
      ),
      lang: f.lang,
      assistant: f.assistant,
      costInfoCommand: '/session info',
      palette: theme.matches ? LIGHT : DARK,
      meter: f.meter,
      events: f.events,
      open: state.open,
      body,
      fill: {
        rows: availableHeight / 16,
        mapAspect:
          mapWidth > 0 && mapHeight > 0
            ? mapHeight / mapWidth
            : Math.max(
                0.1,
                availableHeight /
                  Math.max(
                    1,
                    container.clientWidth -
                      parseFloat(style.paddingLeft) -
                      parseFloat(style.paddingRight),
                  ),
              ),
      },
    }
    const out = renderPane(runtime, snapshot, actions, maps)
    if (out.drawn?.kind === '2d') frames = { ...frames, d2: out.drawn.frame }
    else if (out.drawn?.kind === '3d')
      frames = { ...frames, d3: out.drawn.frame }
    dom.hoverNames = f.settings.hover
    dom.render(out.node)
  }
  const events = new EventSource('events')
  events.onopen = () => {
    status.textContent = ''
  }
  events.onerror = () => {
    events.close()
    ended = true
    previewSerial++
    container.inert = true
    dom.dispose()
    status.textContent = 'Connection lost. Reopen from the host.'
  }
  events.onmessage = (message) => {
    if (ended) return
    let event: ServerEvent
    try {
      event = JSON.parse(message.data) as ServerEvent
    } catch {
      toast('Invalid dashboard event')
      return
    }
    if (event.v !== 1 || event.generation < generation) return
    if (
      pendingFile !== undefined &&
      (event.generation !== pendingFile.generation || event.kind === 'ended')
    ) {
      pendingFile = undefined
      toast('Session changed; file link discarded')
    }
    if (event.generation > generation) reset(event.generation)
    if (event.kind === 'ended') {
      ended = true
      previewSerial++
      container.inert = true
      dom.dispose()
      status.textContent = 'Session ended'
      events.close()
      return
    }
    if (event.kind === 'layout') {
      if (layout !== undefined && event.layout.layoutRev <= layout.layoutRev)
        return
      layout = event.layout
      index = makeIndex(layout.root, layout.paths)
      render()
      drainFile()
      return
    }
    if (event.kind === 'snapshot' && event.revision > revision) {
      revision = event.revision
      facts = event.facts
      const previousPreview = state.preview
      const enableFollow = !state.zoomed && event.shared.zoomed
      state = {
        ...state,
        ...event.shared,
        ...(enableFollow ? { camera: null } : {}),
      }
      if (state.preview === null) {
        previewSerial++
        preview = undefined
      } else if (!sameRef(previousPreview, state.preview)) {
        void loadPreview(state.preview)
      }
      render()
      drainFile()
    }
  }
  const resizeObserver = new ResizeObserver(render)
  resizeObserver.observe(container)
  theme.addEventListener('change', render)
  const redraw = window.setInterval(() => {
    if (!ended && facts?.workspace.kind === 'loading') render()
  }, 1000)
  window.addEventListener(
    'pagehide',
    () => {
      ended = true
      events.close()
      resizeObserver.disconnect()
      theme.removeEventListener('change', render)
      clearInterval(redraw)
      clearTimeout(toastTimer)
      dom.dispose()
    },
    { once: true },
  )
}
