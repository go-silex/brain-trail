import type {
  ExtensionContext,
  ExtensionFactory,
} from '@oh-my-pi/pi-coding-agent'
import { strings } from '../../hooks/i18n'
import { limitOf, usd } from '../../hooks/readout'
import { TITLE, weather } from '../../hooks/view-common'
import { RelayRefusal } from '../relay/client'
import { registerCapture } from './capture'
import { startDashboardServer, type DashboardServer } from './server'
import type { DashboardFeed, FactsWire } from '../../types/browser'

const factory: ExtensionFactory = (pi) => {
  let server: DashboardServer | undefined
  let starting: Promise<DashboardServer> | undefined
  let attempted = false
  let stopped = false
  let bandContext: ExtensionContext | undefined
  let bandRendered = false
  let bandText: string | undefined

  const updateBand = (facts: FactsWire) => {
    if (!bandContext?.hasUI) return
    const m = facts.meter
    let text: string | undefined
    if (facts.settings.band !== false && m.percent !== undefined) {
      const S = strings(facts.lang, facts.assistant)
      const parts = [`${weather(m.percent)} ${S.bandContext(m.percent)}`]
      if (m.usd !== undefined) parts.push(S.bandCost(usd(m.usd)))
      const fiveHour = limitOf(m, 'five_hour')
      const sevenDay = limitOf(m, 'seven_day')
      if (fiveHour) parts.push(S.band5h(Math.round(fiveHour.percentUsed)))
      if (sevenDay) parts.push(S.band7d(Math.round(sevenDay.percentUsed)))
      text = `${TITLE} · ${parts.join(' · ')}`
    }
    if (bandRendered && bandText === text) return
    bandContext.ui.setWidget(
      'brain-trail',
      text === undefined ? undefined : [text],
      { placement: 'aboveEditor' },
    )
    bandRendered = true
    bandText = text
  }

  const ensureServer = async (
    feed: DashboardFeed,
    explicit = false,
  ): Promise<DashboardServer> => {
    if (stopped) throw new Error('Brain Trail has shut down')
    if (server && !server.isClosed()) return server
    server = undefined
    if (!starting) {
      if (attempted && !explicit)
        throw new RelayRefusal(
          'disconnected',
          'Brain Trail relay disconnected; reopen it with /brain-trail',
        )
      attempted = true
      starting = startDashboardServer(feed, (error) => {
        const message = `Brain Trail relay ${error.code}: ${error.message}. Reopen with /brain-trail.`
        if (bandContext?.hasUI) bandContext.ui.notify(message, 'warning')
        else process.stderr.write(`${message}\n`)
      })
    }
    const pending = starting
    try {
      const ready = await pending
      if (stopped) {
        ready.close()
        throw new Error('Brain Trail has shut down')
      }
      server = ready
      return ready
    } finally {
      if (starting === pending) starting = undefined
    }
  }
  const announce = async (ctx: ExtensionContext, current: DashboardServer) => {
    try {
      if (ctx.hasUI) await current.openBrowser()
      else
        process.stderr.write(
          `Brain Trail launch file: ${await current.prepareBrowser()}\n`,
        )
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(String(error), 'warning')
      else process.stderr.write(`Brain Trail: ${String(error)}\n`)
    }
  }
  const feed = registerCapture(pi, {
    authority: () => ensureServer(feed),
    async onRootStart(ctx, current, autoOpen) {
      bandContext = ctx
      bandRendered = false
      updateBand(current.current().facts)
      try {
        const ready = await ensureServer(current)
        if (!ctx.hasUI || autoOpen) await announce(ctx, ready)
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(String(error), 'warning')
        else process.stderr.write(`Brain Trail: ${String(error)}\n`)
      }
    },
    async onRootStop() {
      stopped = true
      stopBand()
      if (bandContext?.hasUI) bandContext.ui.setWidget('brain-trail', undefined)
      bandContext = undefined
      const active = server ?? (await starting?.catch(() => undefined))
      server = undefined
      if (active) active.close()
    },
  })
  const stopBand = feed.subscribe((event) => {
    if (event.kind === 'snapshot') updateBand(event.facts)
  })
  pi.registerCommand('brain-trail', {
    description: 'Open the Brain Trail dashboard for this session',
    async handler(_args, ctx) {
      if (ctx.agent.kind !== 'main')
        throw new Error('Brain Trail opens from the main session only')
      try {
        const ready = await ensureServer(feed, true)
        await feed.refreshApps()
        await announce(ctx, ready)
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(String(error), 'warning')
        else process.stderr.write(`Brain Trail: ${String(error)}\n`)
      }
    },
  })
}

export default factory
