import type {
  ExtensionContext,
  ExtensionFactory,
} from '@oh-my-pi/pi-coding-agent'
import { strings } from '../../hooks/i18n'
import { limitOf, usd } from '../../hooks/readout'
import { TITLE, weather } from '../../hooks/view-common'
import { registerCapture } from './capture'
import { startDashboardServer, type DashboardServer } from './server'
import type { DashboardFeed, FactsWire } from './wire'

const factory: ExtensionFactory = (pi) => {
  let server: DashboardServer | undefined
  let starting: Promise<DashboardServer> | undefined
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
  ): Promise<DashboardServer> => {
    if (stopped) throw new Error('Brain Trail has shut down')
    if (server) return server
    starting ??= startDashboardServer(feed)
    const ready = await starting
    if (stopped) {
      await ready.stop()
      throw new Error('Brain Trail has shut down')
    }
    server = ready
    return ready
  }
  const openBrowser = async (url: string) => {
    const command =
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'rundll32.exe'
          : 'xdg-open'
    const args =
      process.platform === 'win32'
        ? ['url.dll,FileProtocolHandler', url]
        : [url]
    const result = await pi.exec(command, args, { timeout: 5000 })
    if (result.code !== 0)
      throw new Error(result.stderr || 'The browser could not be opened')
  }
  const announce = async (ctx: ExtensionContext, current: DashboardServer) => {
    if (!ctx.hasUI) {
      process.stderr.write(`Brain Trail: ${current.url}\n`)
      return
    }
    ctx.ui.notify(`Brain Trail: ${current.url}`, 'info')
    try {
      await openBrowser(current.url)
    } catch (error) {
      ctx.ui.notify(`${String(error)} — ${current.url}`, 'warning')
    }
  }
  const feed = registerCapture(pi, {
    async onRootStart(ctx, current, autoOpen) {
      bandContext = ctx
      bandRendered = false
      updateBand(current.current().facts)
      const ready = await ensureServer(current)
      if (!ctx.hasUI || autoOpen) await announce(ctx, ready)
    },
    async onRootStop() {
      stopped = true
      stopBand()
      if (bandContext?.hasUI) bandContext.ui.setWidget('brain-trail', undefined)
      bandContext = undefined
      const active = server ?? (await starting)
      server = undefined
      if (active) await active.stop()
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
      await announce(ctx, await ensureServer(feed))
    },
  })
}

export default factory
