import type { Index } from '../hooks/files'
import type { Layout, Palette } from '../hooks/map'
import type { MapFrame } from '../hooks/pointer'
import type { FigureId } from '../hooks/readout'
import type { Cam, SpinView } from '../hooks/spin'
import type { SceneSemantics } from '../hooks/scene3d'
import type {
  Camera,
  Coach,
  Lang,
  Meter,
  Play,
  PreviewRef,
  Tab,
  TrailEvent,
  TrailSettings,
  Trail,
} from './model'

export type ViewState = {
  tab: Tab
  open: string[]
  zoomed: boolean
  camera: Camera
  play: Play
  view3d: boolean
  cam3d: Cam
  preview: PreviewRef | null
}
export type SharedView = Pick<ViewState, 'preview' | 'zoomed' | 'play'>
export type SettingsPatch = Partial<Omit<TrailSettings, 'planUsd'>> & {
  planUsd?: number | null
}
export type Scene3dProps = {
  key?: string
  layout: Layout
  semantics: SceneSemantics
  trail: Trail
  palette: Palette
  state: MapState
  now: number
  lang: Lang
  filesWord: string
  outside: number
  onIntent: (intent: ViewIntent) => Promise<void>
  onOpen: (ref: PreviewRef) => Promise<void>
}
export type Step = {
  [K in keyof ViewState]: { key: K; next: (v: ViewState[K]) => ViewState[K] }
}[keyof ViewState]

export type BreakdownFacts = {
  rawMaxTokens: number
  isAutoCompactEnabled: boolean
  autoCompactThreshold?: number
  categories: readonly { kind: string; name: string; tokens: number }[]
  memoryFiles: readonly { path: string; type: string; tokens: number }[]
  mcpTools: readonly { name: string; tokens: number; isLoaded: boolean }[]
  skills?: { includedSkills: number; totalSkills: number; tokens: number }
  agents: readonly { agentType: string }[]
}
export type CostHistory = {
  median: number | undefined
  count: number
  monthUsd: number
}
export type InstructionFile = 'AGENTS.md' | 'CLAUDE.md'
export type FoldFacts = {
  index: Index | undefined
  linked: ReadonlySet<string>
  connected: ReadonlyMap<string, Set<string>>
}
export type PreviewFacts = {
  ref: PreviewRef
  text: string | undefined
  settings: TrailSettings
  apps: readonly string[]
}
export type MapState = Pick<
  ViewState,
  'zoomed' | 'camera' | 'play' | 'view3d' | 'cam3d'
>
export type TabSnapshot =
  | {
      tab: 'context'
      breakdown: BreakdownFacts | undefined
      costHistory: CostHistory
      settings: TrailSettings
    }
  | {
      tab: 'files'
      breakdown: BreakdownFacts | undefined
      fold: FoldFacts
      preview: PreviewFacts | null
    }
  | { tab: 'map'; kind: 'loading'; seconds: number }
  | { tab: 'map'; kind: 'failed'; message: string }
  | {
      tab: 'map'
      kind: 'ready'
      layout: Layout
      shallow: boolean
      fold: FoldFacts & { index: Index }
      state: MapState
    }
  | { tab: 'goal'; connected: ReadonlyMap<string, Set<string>> }
  | {
      tab: 'coach'
      breakdown: BreakdownFacts | undefined
      fold: FoldFacts
      coach: Coach
      instructionFile: InstructionFile
    }
  | { tab: 'settings'; settings: TrailSettings; apps: readonly string[] }
export type ViewSnapshot = {
  now: number
  widthPx: number
  lang: Lang
  assistant: string
  costInfoCommand: string
  palette: Palette
  meter: Meter
  events: TrailEvent[]
  open: readonly string[]
  body: TabSnapshot
  // A host that docks the pane in a frame of `rows` gets a header, a body and a footer over them:
  // the map fills what the two others leave, a box `mapAspect` times as tall as it is wide.
  // Absent, the pane takes the height of what it shows.
  fill?: {
    rows: number
    mapAspect: number
    body?: {
      stamp: string
      offset: number
      viewport: number
      content: number
      reach: number
    }
    chrome?: {
      stamp: string
      header: number
      footer: number
      headerReach: number
      footerReach: number
      notice: boolean
    }
  }
}

export type ViewChild<N> =
  | N
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly ViewChild<N>[]
export type ViewProps = Record<string, unknown>
export type ViewTag<P extends ViewProps, N> = (
  props: P & { children?: ViewChild<N> },
) => N
type Keyed = { key?: string }
export type ViewSpace = number | 'xs' | 'sm' | 'md'
export type ViewBoxProps = Keyed & {
  flexDirection?: 'row' | 'column'
  flexWrap?: 'wrap' | 'nowrap'
  flexGrow?: number
  flexShrink?: number
  alignItems?: 'center' | 'flex-end' | 'stretch'
  justifyContent?: 'center' | 'flex-end' | 'space-between'
  gap?: ViewSpace
  columnGap?: ViewSpace
  rowGap?: ViewSpace
  padding?: ViewSpace
  paddingX?: ViewSpace
  paddingLeft?: ViewSpace
  marginTop?: ViewSpace
  minWidth?: number | string
  width?: number | string
  height?: number | string
  minHeight?: number | string
  borderStyle?: 'single'
  borderColor?: string
  position?: 'relative' | 'absolute'
  overflow?: 'hidden'
  top?: number
  left?: number
  right?: number
  bottom?: number
}
export type ViewTextProps = Keyed & {
  size?: 'caption' | 'heading' | 'title'
  weight?: 'regular' | 'medium'
  dimColor?: boolean
  tabular?: boolean
  mono?: boolean
  wrap?: 'wrap' | 'truncate-start' | 'truncate-end'
  color?: string
}
export type ViewButtonProps<Press> = Keyed & {
  label?: string
  variant?: 'primary'
  plain?: true
  dimColor?: boolean
  onPress: (press: Press) => void
}
export type ViewInputProps = {
  key: string
  placeholder?: string
  value?: string
  submitLabel?: string
  onSubmit: (value: string) => void
}
export type ViewLinkProps = Keyed & { href: string; label: string }
export type ViewSvgProps = Keyed & {
  source: string
  alt: string
  width?: number
  height?: number
}
export type ViewMarkdownProps = Keyed & { text: string }
export type ViewCodeProps = Keyed & {
  source: string
  path?: string
  language?: string
}
export type ViewRuntime<N, Press> = {
  h: <P extends ViewProps>(
    tag: ViewTag<P, N>,
    props: NoInfer<P> | null,
    ...children: ViewChild<N>[]
  ) => N
  Box: ViewTag<ViewBoxProps, N>
  Text: ViewTag<ViewTextProps, N>
  Button: ViewTag<ViewButtonProps<Press>, N>
  Input: ViewTag<ViewInputProps, N>
  Link: ViewTag<ViewLinkProps, N>
  Svg: ViewTag<ViewSvgProps, N> | undefined
  Markdown: ViewTag<ViewMarkdownProps, N> | undefined
  Code: ViewTag<ViewCodeProps, N> | undefined
  MapHit: ViewTag<Keyed, N> | undefined
  Scene3d?: ViewTag<Scene3dProps, N>
  Measure?: ViewTag<
    Keyed & {
      stamp: string
      expectedRows: number
      reach: number
      kind: 'viewport' | 'content' | 'header' | 'footer'
    },
    N
  >
}

export type ViewIntent =
  | { kind: 'tab'; tab: Tab }
  | { kind: 'toggle-open'; key: string }
  | { kind: 'figure'; id: FigureId }
  | { kind: 'legend'; id: FigureId }
  | { kind: 'preview'; ref: PreviewRef | null }
  | { kind: 'replay-play'; steps: number }
  | { kind: 'replay-pause' }
  | { kind: 'replay-live' }
  | { kind: 'replay-step'; by: -1 | 1; steps: number }
  | { kind: 'replay-reset' }
  | { kind: 'toggle-3d' }
  | { kind: 'follow'; following: boolean }
  | { kind: 'whole' }
  | { kind: 'zoom-2d'; fx: number; fy: number; f: number }
  | { kind: 'turn-3d'; by: number }
  | { kind: 'spin-3d' }
  | { kind: 'zoom-3d'; dir: 'in' | 'out' }
export type SharedViewIntent = Extract<
  ViewIntent,
  {
    kind:
      | 'preview'
      | 'replay-play'
      | 'replay-pause'
      | 'replay-live'
      | 'replay-step'
      | 'replay-reset'
      | 'follow'
      | 'whole'
  }
>
export type CompactOutcome =
  | { kind: 'done' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed' }
export type ViewActions<Press> = {
  scrollBody?: (to: 'first' | 'previous' | 'next' | 'last') => void
  intent: (i: ViewIntent) => Promise<void>
  openFile: (ref: PreviewRef) => Promise<void>
  openIn: (ref: PreviewRef, app: string) => Promise<void>
  copy: (text: string, press: Press) => Promise<boolean>
  toast: (text: string) => void
  compact: () => Promise<CompactOutcome>
  refreshMeter: () => Promise<void>
  saveSettings: (patch: SettingsPatch) => Promise<void>
  setLang: (lang: Lang) => Promise<void>
  clearTrail: () => Promise<void>
  retryLayout: () => void
  open3d: () => Promise<boolean>
  analyseCoach: (lang: Lang, file: InstructionFile) => Promise<void>
  applyCoach: (file: InstructionFile, patch: string) => Promise<boolean>
}

export type MapGesture =
  | { kind: 'hover'; fx: number; fy: number; x: number; y: number }
  | { kind: 'leave' }
  | { kind: 'click'; fx: number; fy: number; right: boolean }
  | {
      kind: 'drag'
      press: number
      fx: number
      fy: number
      sfx: number
      sfy: number
    }
  | { kind: 'dragend' }
export type MapTip = { text: string; x: number; y: number }
export type Drawn2d = { view: MapFrame; layout: Layout; touched: Set<number> }
export type Drawn3d = { view: SpinView; layout: Layout; touched: Set<number> }
export type DrawnMap =
  | { kind: '2d'; frame: Drawn2d }
  | { kind: '3d'; frame: Drawn3d }
export type DrawnFrames = { d2: Drawn2d | undefined; d3: Drawn3d | undefined }
export type GestureMemory = {
  hover: { fx: number; fy: number } | undefined
  drag2d: { press: number; view: MapFrame } | undefined
  drag3d: { press: number; yaw: number; pitch: number } | undefined
}
export type GestureResult = {
  memory: GestureMemory
  steps: Step[]
  tip: MapTip | null
  open: PreviewRef | undefined
}
