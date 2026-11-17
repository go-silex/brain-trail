import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps'
import type { AppAuth, Bootstrap, Reply, ViewState } from '../../types/apps'
import { parseChatEnvelope, parseStrictJSON } from '../../types/apps'
import { startPage } from '../browser/page'
import '../browser/app.css'
import { appTransport, type ToolCall } from './transport'
import { resetMountedView } from './reset'
import {
  attached,
  bootstrap as validBootstrap,
  detached,
  mounted,
  nil,
  reply,
} from './wire'

declare const __BRAIN_TRAIL_UI_BUILD_ID__: string

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (element === null)
    throw new Error('Brain Trail dashboard page is incomplete')
  return element
}
const root = requiredElement('app')
const status = requiredElement('status')
const toast = requiredElement('toast')

const app = new App({ name: 'Brain Trail', version: '1.0.0' }, {})
const controls = document.createElement('section')
controls.className = 'bt-app-controls'
const description = document.createElement('span')
const input = document.createElement('textarea')
input.placeholder = 'Paste the one-use Chat pairing envelope'
input.setAttribute('aria-label', 'Chat pairing envelope')
input.rows = 2
const pair = document.createElement('button')
pair.textContent = 'Pair with Chat'
const detach = document.createElement('button')
detach.textContent = 'Detach'
const reset = document.createElement('button')
reset.textContent = 'Reset view'
for (const button of [pair, detach, reset]) button.className = 'bt-button'
controls.append(description, input, pair, detach, reset)
document.body.insertBefore(controls, root)
document.body.classList.add('bt-app-shell')

const identity = {
  v: 1 as const,
  wireRevision: 1 as const,
  uiBuildId: __BRAIN_TRAIL_UI_BUILD_ID__,
}
let auth: AppAuth | undefined
let view: ViewState = { kind: 'detached' }
let disposePage: (() => void) | undefined
let lifecycle = 0
let connected = false
let busy = false
let closed = false
let receivedBootstrap = false
let pendingBootstrap: Bootstrap | undefined
let canPair = false

function renderControls() {
  description.textContent =
    view.kind === 'attached'
      ? `Connected: ${view.source.label} (${view.source.owner.host})`
      : view.kind === 'pending'
        ? 'Waiting for native session approval'
        : 'Not paired'
  input.hidden = view.kind === 'attached' || auth === undefined || !canPair
  pair.hidden = input.hidden
  detach.hidden = auth === undefined || (view.kind === 'detached' && canPair)
  for (const button of [pair, detach, reset])
    button.disabled = busy || !connected || closed
  input.disabled = busy || !connected || closed
}
function clearPage() {
  disposePage?.()
  disposePage = undefined
  input.value = ''
  root.replaceChildren()
  toast.textContent = ''
}
const call: ToolCall = async <T>(
  name: string,
  args: Record<string, unknown>,
  validate: (value: unknown) => value is T,
): Promise<Reply<T>> => {
  const result = await app.callServerTool({ name, arguments: args })
  const value = reply(result._meta?.brainTrail, validate)
  if (value === undefined || Boolean(result.isError) === value.ok)
    throw new Error('Invalid app response')
  return value
}
function reportFailure(error: string) {
  status.textContent = `Brain Trail: ${error}`
}
function showState(next: ViewState) {
  view = next
  if (next.kind === 'attached') {
    canPair = false
    input.value = ''
  }
  if (next.kind === 'detached') {
    clearPage()
    status.textContent = 'Detached'
  } else
    status.textContent =
      next.kind === 'pending' ? 'Waiting for native session approval' : ''
  renderControls()
}
function showPage(initial: ViewState) {
  if (auth === undefined || initial.kind === 'detached') {
    showState(initial)
    return
  }
  clearPage()
  view = initial
  canPair = initial.kind === 'pending'
  const transport = appTransport(auth, call, initial, showState, () => {
    view = { kind: 'detached' }
    canPair = false
    input.value = ''
    renderControls()
  })
  disposePage = startPage(root, status, toast, transport)
  renderControls()
}
async function mount(value: Bootstrap, mine: number) {
  if (
    value.uiBuildId !== identity.uiBuildId ||
    value.wireRevision !== identity.wireRevision
  ) {
    reportFailure(
      'This view build is stale. Open a current Brain Trail resource.',
    )
    return
  }
  const result = await call(
    'brain_trail_mount',
    {
      ...identity,
      assetDigest: value.assetDigest,
      serverEpoch: value.serverEpoch,
      viewKey: value.viewKey,
    },
    mounted,
  )
  if (mine !== lifecycle || closed) {
    if (result.ok) {
      const abandoned = {
        v: 1 as const,
        serverEpoch: value.serverEpoch,
        viewKey: value.viewKey,
        mountKey: result.value.mountKey,
      }
      void call('brain_trail_unmount', abandoned, nil).catch(() => {})
    }
    return
  }
  if (!result.ok) {
    reportFailure(result.error)
    return
  }
  auth = {
    v: 1,
    serverEpoch: value.serverEpoch,
    viewKey: value.viewKey,
    mountKey: result.value.mountKey,
  }
  canPair = result.value.state.kind !== 'attached'
  showPage(result.value.state)
}
async function begin(value: Bootstrap) {
  const mine = ++lifecycle
  busy = true
  renderControls()
  try {
    await mount(value, mine)
  } catch {
    if (mine === lifecycle) reportFailure('Connection unavailable')
  } finally {
    if (mine === lifecycle) {
      busy = false
      renderControls()
    }
  }
}
app.ontoolresult = (result) => {
  if (receivedBootstrap || closed) return
  receivedBootstrap = true
  const value = result._meta?.brainTrail
  if (!validBootstrap(value)) {
    reportFailure(
      'No valid bootstrap. Reset this view or open a fresh Brain Trail resource.',
    )
    return
  }
  if (connected) void begin(value)
  else pendingBootstrap = value
}
app.onhostcontextchanged = (context) => {
  if (context.theme) applyDocumentTheme(context.theme)
  if (context.styles?.variables)
    applyHostStyleVariables(context.styles.variables)
}
async function unmount() {
  const previous = auth
  auth = undefined
  canPair = false
  ++lifecycle
  clearPage()
  view = { kind: 'detached' }
  renderControls()
  if (previous !== undefined) await call('brain_trail_unmount', previous, nil)
}
app.onteardown = async () => {
  closed = true
  try {
    await unmount()
  } catch {}
  return {}
}
window.addEventListener(
  'pagehide',
  () => {
    if (closed) return
    closed = true
    void unmount().catch(() => {})
  },
  { once: true },
)
pair.addEventListener('click', async () => {
  if (busy || auth === undefined || view.kind === 'attached' || !canPair) return
  let envelope
  try {
    envelope = parseChatEnvelope(parseStrictJSON(input.value))
  } catch {
    envelope = undefined
  }
  input.value = ''
  if (envelope === undefined) {
    reportFailure('Invalid pairing envelope')
    return
  }
  const mine = ++lifecycle
  canPair = false
  busy = true
  renderControls()
  try {
    const result = await call(
      'brain_trail_pair',
      { ...auth, envelope },
      attached,
    )
    if (mine !== lifecycle || closed) return
    if (!result.ok) reportFailure(result.error)
    else showPage(result.value)
  } catch {
    if (mine === lifecycle) reportFailure('Connection unavailable')
  } finally {
    if (mine === lifecycle) {
      busy = false
      renderControls()
    }
  }
})
detach.addEventListener('click', async () => {
  if (busy || auth === undefined || (view.kind === 'detached' && canPair))
    return
  const previous = auth
  const mine = ++lifecycle
  busy = true
  clearPage()
  view = { kind: 'detached' }
  renderControls()
  try {
    const result = await call('brain_trail_detach', previous, detached)
    if (mine !== lifecycle || closed) return
    if (!result.ok) {
      reportFailure(result.error)
      return
    }
    canPair = true
    showState(result.value)
  } catch {
    if (mine === lifecycle) reportFailure('Connection unavailable')
  } finally {
    if (mine === lifecycle) {
      busy = false
      renderControls()
    }
  }
})
reset.addEventListener('click', async () => {
  if (busy) return
  receivedBootstrap = true
  pendingBootstrap = undefined
  const previous = auth
  const mine = ++lifecycle
  busy = true
  canPair = false
  clearPage()
  view = { kind: 'detached' }
  renderControls()
  try {
    const result = await resetMountedView(
      call,
      identity,
      previous,
      () => {
        auth = undefined
      },
      () => mine === lifecycle && !closed,
    )
    if (result === undefined || mine !== lifecycle || closed) return
    if (!result.ok) {
      reportFailure(result.error)
      return
    }
    await mount(result.value.bootstrap, mine)
  } catch {
    if (mine === lifecycle) reportFailure('Connection unavailable')
  } finally {
    if (mine === lifecycle) {
      busy = false
      renderControls()
    }
  }
})
renderControls()
void app
  .connect()
  .then(() => {
    if (closed) return
    connected = true
    const context = app.getHostContext()
    if (context?.theme) applyDocumentTheme(context.theme)
    if (context?.styles?.variables)
      applyHostStyleVariables(context.styles.variables)
    renderControls()
    if (pendingBootstrap !== undefined) {
      const value = pendingBootstrap
      pendingBootstrap = undefined
      void begin(value)
    }
  })
  .catch(() => {
    if (!closed) reportFailure('Connection unavailable')
  })
