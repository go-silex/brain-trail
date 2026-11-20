import type { Lang, Tab } from '../types/model'
import type { ViewSnapshot } from '../types/view'
import { BANNER_ASPECT, BANNER_MAX } from './map'

type Cells = { columns: number; rows: number }
type BodyWindow = {
  stamp: string
  dimensions: string
  paneRows: number
  tab: Tab
  offset: number
  viewport: number
  measured: number
  reach: number
  end: boolean
}
type Chrome = {
  shape: string
  stamp: string
  header: number
  footer: number
  headerReach: number
  footerReach: number
}
type Destination = 'first' | 'previous' | 'next' | 'last' | number
export type NativeLayout = {
  render(input: { columns: number; rows: number; tab: Tab; lang: Lang; fill: boolean }): {
    fill?: ViewSnapshot['fill']
    hitBox?: { box: string; reach: number }
  }
  measure(element: string, data: unknown): boolean
  scroll(to: Destination): boolean
  wheel(input: { by: number; bodyRows: number; contentRows: number; tab: Tab }): boolean
  mapMeasurement(data: unknown): boolean
}

// One instance belongs to one native registration generation. Its stamps reject
// measurements from a prior frame and its state never leaks into browser views.
export function createNativeLayout(): NativeLayout {
  let body: BodyWindow | undefined
  let chrome: Chrome | undefined
  let bodyGeneration = 0
  let chromeGeneration = 0
  let mapChrome: { columns: number; chrome: Cells } | undefined
  let hitBox: { box: string; reach: number } | undefined

  const limit = () => body === undefined ? 0 : Math.max(0, body.measured + 1 - body.viewport)
  const visibleOffset = () => {
    if (body === undefined) return 0
    if (body.measured === 0 || body.viewport === 0) return body.offset
    return body.end ? limit() : Math.min(body.offset, limit())
  }
  const scroll = (to: Destination): boolean => {
    if (body === undefined) return false
    const end = to === 'last'
    const page = Math.max(1, body.viewport)
    const current = visibleOffset()
    const offset = Math.max(0, Math.min(limit(), typeof to === 'number' ? current + to : to === 'first' ? 0 : end ? limit() : current + (to === 'next' ? page : -page)))
    const changed = body.offset !== offset || body.end !== end
    body.offset = offset
    body.end = end
    return changed
  }

  return {
    render({ columns, rows, tab, lang, fill }: { columns: number; rows: number; tab: Tab; lang: Lang; fill: boolean }): { fill?: ViewSnapshot['fill']; hitBox?: { box: string; reach: number } } {
      rows = Math.max(0, rows)
      if (!fill) {
        body = undefined
        hitBox = undefined
        return {}
      }
      const estimated = Math.round((Math.min(Math.max(240, columns * 8 - 24), BANNER_MAX) * BANNER_ASPECT) / (8 * 2.46)) + 10
      const mapMargin = mapChrome?.columns === columns ? mapChrome.chrome : { columns: 0, rows: estimated }
      const mapBox = { columns: Math.max(0, columns - mapMargin.columns), rows: Math.max(0, rows - mapMargin.rows) }
      const mapAspect = ((mapBox.rows + 0.5) * 2.46) / (mapBox.columns + 0.5)
      hitBox = { box: `${columns}x${rows}/${mapBox.columns}x${mapBox.rows}`, reach: rows }
      const dimensions = `${tab}/${columns}x${rows}`
      if (tab !== 'map') {
        if (body?.dimensions !== dimensions) body = {
          stamp: `${dimensions}/${++bodyGeneration}`, dimensions, paneRows: rows, tab,
          offset: body?.tab === tab ? body.offset : 0, viewport: 0, measured: 0,
          reach: Math.max(1, rows), end: body?.tab === tab && body.end,
        }
      } else body = undefined
      const bodyFill = body === undefined ? undefined : {
        stamp: body.stamp, offset: visibleOffset(), viewport: body.viewport,
        content: body.measured, reach: body.reach,
      }
      const shape = JSON.stringify([columns, rows, rows < 24, tab, lang])
      if (chrome?.shape !== shape) chrome = {
        shape, stamp: `${++chromeGeneration}`, header: chrome?.header ?? 0, footer: chrome?.footer ?? 0,
        headerReach: Math.max(chrome?.headerReach ?? 1, rows), footerReach: Math.max(chrome?.footerReach ?? 1, rows),
      }
      const chromeFill = {
        stamp: chrome.stamp, header: chrome.header, footer: chrome.footer,
        headerReach: chrome.headerReach, footerReach: chrome.footerReach,
        notice: chrome.header > 0 && chrome.footer > 0
          ? chrome.header + 1 + chrome.footer + 1 + (rows < 24 ? 1 : 2) >= rows
          : rows < 6,
      }
      return { fill: { rows, mapAspect, body: bodyFill, chrome: chromeFill }, hitBox }
    },
    measure(element: string, data: unknown): boolean {
      if (typeof data !== 'object' || data === null) return false
      const d = data as { kind?: unknown; stamp?: unknown; rows?: unknown }
      if (typeof d.rows !== 'number' || !Number.isSafeInteger(d.rows) || d.rows <= 0 || `${d.kind}-probe` !== element) return false
      if ((d.kind === 'header' || d.kind === 'footer') && chrome !== undefined && d.stamp === chrome.stamp) {
        const reachKey = d.kind === 'header' ? 'headerReach' : 'footerReach'
        const reach = chrome[reachKey]
        const changed = chrome[d.kind] !== d.rows || d.rows >= reach
        chrome[d.kind] = d.rows
        if (d.rows >= reach) chrome[reachKey] = Math.max(d.rows + 1, reach * 2)
        return changed
      }
      if ((d.kind === 'viewport' || d.kind === 'content') && body !== undefined && d.stamp === body.stamp) {
        if (d.kind === 'viewport') {
          const changed = body.viewport !== d.rows
          body.viewport = d.rows
          return changed
        }
        const changed = body.measured !== d.rows || d.rows >= body.reach
        body.measured = d.rows
        if (d.rows >= body.reach) body.reach = Math.max(body.reach * 2, d.rows + 1)
        return changed
      }
      return false
    },
    scroll,
    wheel({ by, bodyRows, contentRows, tab }: { by: number; bodyRows: number; contentRows: number; tab: Tab }): boolean {
      if (body === undefined || by === 0 || contentRows !== bodyRows || bodyRows !== body.paneRows || tab !== body.tab) return false
      scroll(Math.abs(by) >= bodyRows ? Math.sign(by) * Math.max(1, body.viewport) : by)
      return true
    },
    mapMeasurement(data: unknown): boolean {
      if (hitBox === undefined || typeof data !== 'object' || data === null) return false
      const d = data as { kind?: unknown; for?: unknown; columns?: unknown; rows?: unknown }
      if (d.kind !== 'box' || d.for !== hitBox.box || typeof d.columns !== 'number' || typeof d.rows !== 'number' || !Number.isSafeInteger(d.columns) || !Number.isSafeInteger(d.rows) || d.columns <= 0 || d.rows < 0) return false
      const pane = /^(\d+)x(\d+)\//.exec(hitBox.box)
      if (!pane) return false
      const columns = Number(pane[1]), rows = Number(pane[2])
      if (columns <= 0 || rows <= 0 || !Number.isSafeInteger(columns) || !Number.isSafeInteger(rows)) return false
      const measured = { columns: columns - d.columns, rows: rows - d.rows }
      if (mapChrome?.columns === columns && mapChrome.chrome.columns === measured.columns && mapChrome.chrome.rows === measured.rows) return false
      mapChrome = { columns, chrome: measured }
      return true
    },
  }
}
