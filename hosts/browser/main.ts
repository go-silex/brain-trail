/// <reference lib="dom" />
import './app.css'
import { startPage } from './page'
import {
  browserBootstrap,
  browserTransport,
  issueBrowserPair,
  PairingRefusal,
} from './browser-transport'
import { coworkTransport } from './cowork-transport'

const app = document.getElementById('app')
const status = document.getElementById('status')
const toast = document.getElementById('toast')
if (app === null || status === null || toast === null)
  throw new Error('Brain Trail dashboard page is incomplete')
let toastTimer: number | undefined
const notify = (message: string) => {
  toast.textContent = message
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toast.textContent = ''
  }, 5000)
}
if (new URL(window.location.href).searchParams.get('host') === 'cowork') {
  document.body.classList.add('bt-app-shell')
  let dispose: (() => void) | undefined
  let active = true
  const selectSession = (session: string) => {
    const url = new URL(window.location.href)
    url.searchParams.set('session', session)
    history.replaceState(history.state, '', url)
    app.replaceChildren()
    dispose = startPage(app, status, toast, coworkTransport(session))
  }
  const session = new URL(window.location.href).searchParams.get('session')
  if (session) selectSession(session)
  else {
    status.textContent = 'Loading Cowork tasks…'
    void fetch('cowork/sessions', { referrerPolicy: 'no-referrer' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to load Cowork tasks')
        return response.json() as Promise<{
          sessions: {
            id: string
            started: number
            last: number
            ended: boolean
            files: number
            connectors: number
          }[]
        }>
      })
      .then(({ sessions }) => {
        if (!active) return
        status.textContent = sessions.length
          ? 'Select a Cowork task'
          : 'No Cowork tasks found'
        for (const item of sessions) {
          const button = document.createElement('button')
          button.className = 'bt-button'
          button.textContent = `${new Date(item.last).toLocaleString()} · ${item.files} files · ${item.connectors} connectors · ${item.id.slice(0, 8)}${item.ended ? ' · ended' : ''}`
          button.addEventListener('click', () => selectSession(item.id), {
            once: true,
          })
          app.append(button)
        }
      })
      .catch(() => {
        if (active) status.textContent = 'Unable to load Cowork tasks'
      })
  }
  window.addEventListener(
    'pagehide',
    () => {
      active = false
      dispose?.()
      clearTimeout(toastTimer)
    },
    { once: true },
  )
} else {
  const { bootstrap, invalid } = browserBootstrap()
  if (invalid) notify('Invalid file link')
  const pairing = document.createElement('section')
  pairing.setAttribute('aria-label', 'Chat pairing')
  pairing.className = 'bt-browser-pair'
  const pairButton = document.createElement('button')
  pairButton.className = 'bt-button'
  pairButton.textContent = 'Pair with Chat'
  pairButton.disabled = true
  const panel = document.createElement('div')
  panel.hidden = true
  const instruction = document.createElement('p')
  instruction.textContent = 'Paste this one-use pairing envelope into Chat.'
  const envelope = document.createElement('textarea')
  envelope.readOnly = true
  envelope.setAttribute('aria-label', 'Chat pairing envelope')
  envelope.style.width = '100%'
  envelope.rows = 5
  const copy = document.createElement('button')
  copy.className = 'bt-button'
  copy.textContent = 'Copy'
  const dismiss = document.createElement('button')
  dismiss.className = 'bt-button'
  dismiss.textContent = 'Dismiss'
  const pairingStatus = document.createElement('p')
  pairingStatus.setAttribute('role', 'status')
  panel.append(instruction, envelope, copy, dismiss)
  pairing.append(pairButton, panel, pairingStatus)
  document.body.classList.add('bt-app-shell')
  document.body.insertBefore(pairing, app)

  let generation = 0
  let attempt = 0
  let pending: AbortController | undefined
  const clearPairing = () => {
    attempt++
    pending?.abort()
    pending = undefined
    envelope.value = ''
    panel.hidden = true
    pairingStatus.textContent = ''
    pairButton.disabled = generation === 0
  }
  dismiss.addEventListener('click', clearPairing)
  pairButton.addEventListener('click', async () => {
    if (generation === 0 || pending !== undefined) return
    clearPairing()
    const current = generation
    const serial = attempt
    const controller = new AbortController()
    pending = controller
    pairButton.disabled = true
    pairingStatus.textContent = 'Requesting pairing…'
    try {
      const result = await issueBrowserPair(current, controller.signal)
      if (attempt !== serial || generation !== current) return
      envelope.value = JSON.stringify(result)
      panel.hidden = false
      pairingStatus.textContent = ''
    } catch (error) {
      if (attempt !== serial) return
      clearPairing()
      pairingStatus.textContent =
        error instanceof PairingRefusal
          ? `Pairing refused: ${error.message}. Press Pair with Chat to try again.`
          : 'Pairing failed. Press Pair with Chat to try again.'
    } finally {
      if (attempt === serial) {
        pending = undefined
        pairButton.disabled = generation === 0
      }
    }
  })
  copy.addEventListener('click', async () => {
    if (envelope.value === '') return
    const serial = attempt
    try {
      await navigator.clipboard.writeText(envelope.value)
      if (attempt === serial) pairingStatus.textContent = 'Copied to clipboard.'
    } catch {
      if (attempt === serial)
        pairingStatus.textContent =
          'Could not copy. Select and copy the envelope manually.'
    }
  })
  const dispose = startPage(
    app,
    status,
    toast,
    browserTransport(() => notify('Invalid dashboard event'), {
      event(event) {
        if (
          event === null ||
          typeof event !== 'object' ||
          event.v !== 1 ||
          !Number.isSafeInteger(event.generation) ||
          event.generation <= 0 ||
          event.generation < generation ||
          (event.kind !== 'layout' &&
            event.kind !== 'snapshot' &&
            event.kind !== 'ended')
        )
          return
        if (event.generation !== generation) {
          generation = event.generation
          clearPairing()
        }
        if (event.kind === 'ended') {
          generation = 0
          clearPairing()
        }
      },
      closed() {
        generation = 0
        clearPairing()
      },
    }),
    bootstrap,
  )
  window.addEventListener(
    'pagehide',
    () => {
      generation = 0
      clearPairing()
      pairing.remove()
      clearTimeout(toastTimer)
      dispose()
    },
    { once: true },
  )
}
