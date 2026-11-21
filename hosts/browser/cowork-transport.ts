/// <reference lib="dom" />
import { parseCoworkReceipt, projectCowork } from '../../hooks/cowork'
import type { CoworkReceipt } from '../../hooks/cowork'
import { isStep } from '../../hooks/fold'
import { packFiles } from '../../hooks/map'
import {
  reduceSharedView,
  replayTick,
  sharedView,
  STEP_MS,
  timerEffect,
  VIEW_STATE0,
} from '../../hooks/view-controller'
import type {
  CommandRefusal,
  CommandReplies,
  FactsWire,
  HostCommand,
} from '../../types/browser'
import type { Lang, TrailSettings } from '../../types/model'
import type { DashboardTransport } from './transport'

const SETTINGS_KEY = 'brain-trail-cowork-settings'
const LANG_KEY = 'brain-trail-cowork-lang'
export function coworkNotices(
  coverage: FactsWire['coworkCoverage'],
  lang: FactsWire['lang'],
): string {
  const notices: string[] = []
  if (coverage?.status === 'reconnecting')
    notices.push(lang === 'fr' ? 'Reconnexion en cours' : 'Reconnecting')
  else if (coverage?.status === 'unavailable')
    notices.push(lang === 'fr' ? 'Tâche indisponible' : 'Task unavailable')
  else if (coverage?.status === 'closed')
    notices.push(lang === 'fr' ? 'Visionneuse fermée' : 'Viewer closed')
  if (coverage?.truncated)
    notices.push(lang === 'fr' ? 'Historique plafonné' : 'History capped')
  if (coverage?.partialInventory)
    notices.push(lang === 'fr' ? 'Inventaire partiel' : 'Partial inventory')
  return notices.join(' · ')
}

function savedSettings(): TrailSettings {
  const settings: TrailSettings = {
    openMd: 'default',
    openOther: 'default',
    hover: true,
  }
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
    if (typeof saved.hover === 'boolean') settings.hover = saved.hover
    if (typeof saved.band === 'boolean') settings.band = saved.band
  } catch {
    /* Storage can be unavailable. */
  }
  return settings
}
function savedLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY)
    if (saved === 'fr' || saved === 'en') return saved
  } catch {
    /* Storage can be unavailable. */
  }
  return (globalThis.navigator?.language ?? '').toLowerCase().startsWith('fr')
    ? 'fr'
    : 'en'
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* State remains local to this page. */
  }
}

export function coworkTransport(session: string): DashboardTransport {
  let sink: Parameters<DashboardTransport['listen']>[0] | undefined
  let active = false
  let controller: AbortController | undefined
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let replayTimer: ReturnType<typeof setInterval> | undefined
  let cursor = 0,
    revision = 0,
    layoutRev = 0
  let instance: number | undefined
  let receipts: CoworkReceipt[] = []
  let projection = projectCowork(receipts)
  let projectionKey = ''
  let layoutKey = ''
  let shared = sharedView(VIEW_STATE0)
  let settings = savedSettings()
  let lang = savedLang()
  let truncated = false
  let pollStatus: 'reconnecting' | 'unavailable' | 'closed' | undefined
  const stopReplay = () => {
    clearInterval(replayTimer)
    replayTimer = undefined
  }
  const publish = () => {
    if (!active || !sink) return
    const facts: FactsWire = {
      ownerHost: 'cowork',
      assistant: 'Claude',
      lang,
      meter: { window: 0 },
      events: projection.events,
      settings,
      coach: { text: '', at: 0, busy: false },
      coworkCoverage: {
        truncated,
        partialInventory: projection.partialInventory,
        status: pollStatus,
      },
      workspace:
        projection.paths.length || projection.connected.length
          ? { kind: 'ready', layoutRev, shallow: false }
          : { kind: 'failed', message: 'No files observed yet' },
      linked: [],
      connected: projection.connected,
      costHistory: { median: undefined, count: 0, monthUsd: 0 },
      apps: [],
      instructionFile: 'CLAUDE.md',
    }
    sink.event({
      v: 1,
      kind: 'snapshot',
      generation: 1,
      revision: ++revision,
      facts,
      shared,
    })
  }
  const refreshProjection = () => {
    const next = projectCowork(receipts)
    const nextLayoutKey = JSON.stringify([
      next.root,
      next.paths,
      next.paths.length === 0 && next.connected.length > 0,
    ])
    const nextKey = JSON.stringify(next)
    projection = next
    if (layoutKey !== nextLayoutKey) {
      layoutKey = nextLayoutKey
      if (next.paths.length || next.connected.length) {
        layoutRev++
        const title =
          next.root.replace(/\\/g, '/').split('/').filter(Boolean).pop() ||
          'Cowork'
        sink?.event({
          v: 1,
          kind: 'layout',
          generation: 1,
          layout: {
            layoutRev,
            root: next.root,
            paths: next.paths,
            layout: packFiles(next.paths, title),
          },
        })
      }
    }
    if (projectionKey !== nextKey) {
      projectionKey = nextKey
      publish()
    }
  }
  const poll = async () => {
    if (!active) return
    controller = new AbortController()
    let response: Response
    try {
      response = await fetch(
        `cowork/receipts?session=${encodeURIComponent(session)}&after=${cursor}`,
        {
          signal: controller.signal,
          referrerPolicy: 'no-referrer',
        },
      )
    } catch {
      if (!active) return
      if (pollStatus !== 'reconnecting') {
        pollStatus = 'reconnecting'
        publish()
      }
      pollTimer = setTimeout(poll, 5000)
      return
    }
    if (!active) return
    if (!response.ok) {
      const nextStatus =
        response.status === 401 || response.status === 403
          ? 'closed'
          : response.status === 404
            ? 'unavailable'
            : 'reconnecting'
      if (pollStatus !== nextStatus) {
        pollStatus = nextStatus
        publish()
      }
      if (nextStatus !== 'closed') pollTimer = setTimeout(poll, 5000)
      return
    }
    try {
      let body: unknown
      try {
        body = await response.json()
      } catch (error) {
        if (error instanceof SyntaxError) throw error
        if (!active) return
        if (pollStatus !== 'reconnecting') {
          pollStatus = 'reconnecting'
          publish()
        }
        pollTimer = setTimeout(poll, 5000)
        return
      }
      if (!active) return
      if (typeof body !== 'object' || body === null || Array.isArray(body))
        throw new Error('Invalid receipts')
      const data = body as Record<string, unknown>
      if (
        data.session !== session ||
        !Array.isArray(data.receipts) ||
        !Number.isSafeInteger(data.instance) ||
        !Number.isSafeInteger(data.next) ||
        (data.next as number) < cursor ||
        typeof data.ended !== 'boolean' ||
        typeof data.truncated !== 'boolean' ||
        typeof data.more !== 'boolean' ||
        (data.more && data.next === cursor)
      )
        throw new Error('Invalid receipts')
      const rawLast = data.receipts[data.receipts.length - 1]
      if (
        data.next !==
        (data.receipts.length === 0
          ? cursor
          : typeof rawLast === 'object' &&
              rawLast !== null &&
              !Array.isArray(rawLast)
            ? (rawLast as Record<string, unknown>).n
            : undefined)
      )
        throw new Error('Invalid receipts')
      const statusChanged = pollStatus !== undefined
      pollStatus = undefined
      const changedInstance =
        instance !== undefined && instance !== data.instance
      if (changedInstance) {
        cursor = 0
        receipts = []
        projection = projectCowork(receipts)
        projectionKey = ''
        layoutKey = ''
        truncated = false
        stopReplay()
        shared = sharedView(VIEW_STATE0)
      }
      instance = data.instance as number
      if (changedInstance) {
        refreshProjection()
        pollTimer = setTimeout(poll, 0)
        return
      }
      const batch: CoworkReceipt[] = []
      let last = cursor
      for (const value of data.receipts) {
        const n =
          typeof value === 'object' && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>).n
            : undefined
        if (
          !Number.isSafeInteger(n) ||
          (n as number) <= last ||
          (n as number) > (data.next as number)
        )
          continue
        last = n as number
        const receipt = parseCoworkReceipt(value)
        if (receipt) batch.push(receipt)
      }
      receipts = receipts.concat(batch)
      cursor = data.next as number
      const coverageChanged = !truncated && data.truncated
      truncated ||= data.truncated
      if (batch.length > 0 || revision === 0) {
        const previousRevision = revision
        refreshProjection()
        if ((coverageChanged || statusChanged) && revision === previousRevision)
          publish()
      } else if (coverageChanged || statusChanged) publish()
      pollTimer = setTimeout(poll, data.more ? 0 : data.ended ? 5000 : 1000)
    } catch {
      if (!active) return
      active = false
      stopReplay()
      sink?.closed('disconnected')
    }
  }
  return {
    listen(nextSink) {
      sink = nextSink
      active = true
      nextSink.ready()
      void poll()
      return () => {
        active = false
        controller?.abort()
        clearTimeout(pollTimer)
        stopReplay()
        sink = undefined
      }
    },
    async execute<C extends HostCommand>(request: {
      v: 1
      generation: number
      command: C
    }): Promise<CommandReplies[C['kind']] | CommandRefusal> {
      if (!active) return { ok: false, error: 'disconnected' }
      if (request.generation !== 1)
        return { ok: false, error: 'stale-generation' }
      const command = request.command
      if (command.kind === 'view') {
        shared = reduceSharedView(
          shared,
          command.intent,
          projection.events.filter(isStep).length,
        )
        const effect = timerEffect(command.intent)
        if (effect !== 'none') stopReplay()
        if (effect === 'start' && shared.play.playing) {
          replayTimer = setInterval(() => {
            shared = {
              ...shared,
              play: replayTick(projection.events.filter(isStep).length)(
                shared.play,
              ),
            }
            if (!shared.play.playing) stopReplay()
            publish()
          }, STEP_MS)
        }
        publish()
      } else if (command.kind === 'lang') {
        lang = command.lang
        save(LANG_KEY, lang)
        publish()
      } else if (command.kind === 'settings') {
        const { hover, band, ...unsupported } = command.patch
        if (
          Object.keys(unsupported).length ||
          (hover !== undefined && typeof hover !== 'boolean') ||
          (band !== undefined && typeof band !== 'boolean')
        )
          return { ok: false, error: 'unsupported' }
        settings = {
          ...settings,
          ...(hover === undefined ? {} : { hover }),
          ...(band === undefined ? {} : { band }),
        }
        save(
          SETTINGS_KEY,
          JSON.stringify({ hover: settings.hover, band: settings.band }),
        )
        publish()
      } else return { ok: false, error: 'unsupported' }
      return { ok: true } as CommandReplies[C['kind']]
    },
  }
}
