import type { Tab } from '../types/model'
import type {
  DrawnMap,
  ViewActions,
  ViewRuntime,
  ViewSnapshot,
} from '../types/view'
import { strings } from './i18n'
import { banner, type MapRenderer } from './map'
import { zoneOf } from './readout'
import { TITLE, weather } from './view-common'
import { renderContext } from './view-context'
import { renderFiles } from './view-files'
import { renderGoal, renderCoach } from './view-insights'
import { renderMap } from './view-map'
import { renderSettings } from './view-settings'

export { TITLE, weather } from './view-common'
const TABS: Exclude<Tab, 'settings'>[] = [
  'map',
  'goal',
  'context',
  'files',
  'coach',
]

export function renderPane<N, Press>(
  R: ViewRuntime<N, Press>,
  s: ViewSnapshot,
  act: ViewActions<Press>,
  maps: MapRenderer,
): { node: N; drawn: DrawnMap | undefined } {
  const S = strings(s.lang, s.assistant)
  const P = s.palette
  const m = s.meter
  const pct = m.percent ?? 0
  const zone = zoneOf(pct)
  const tab = s.body.tab
  const compact = s.fill !== undefined && s.fill.rows < 24
  const header = R.h(
    R.Box,
    { flexDirection: 'column', gap: compact ? 'xs' : 'sm' },
    compact
      ? null
      : R.Svg
        ? R.h(R.Svg, {
            key: 'brand',
            source: banner(TITLE, S.tagline, P, s.widthPx),
            alt: `Unkillable Companies · ${TITLE}`,
          })
        : R.h(
            R.Box,
            { flexDirection: 'column' },
            R.h(R.Text, { weight: 'medium' }, 'Unkillable Companies'),
            R.h(
              R.Text,
              { size: 'caption', dimColor: true },
              TITLE.toUpperCase(),
              ' · ',
              S.tagline,
            ),
          ),
    R.h(
      R.Box,
      {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
      },
      R.h(
        R.Box,
        { flexDirection: 'row', columnGap: 'sm', alignItems: 'center' },
        R.h(
          R.Text,
          {
            size: 'title',
            weight: 'regular',
            dimColor: m.percent === undefined,
            tabular: true,
          },
          m.percent !== undefined ? `${m.estimated ? '≈ ' : ''}${pct} %` : '–',
        ),
        R.h(
          R.Box,
          { flexDirection: 'column' },
          compact && m.percent !== undefined
            ? R.h(
                R.Text,
                { size: 'caption', dimColor: true },
                S.window,
                ` · ${weather(pct)}`,
              )
            : R.h(R.Text, { size: 'caption', dimColor: true }, S.window),
          !compact &&
            m.percent !== undefined &&
            R.h(R.Text, null, weather(pct)),
        ),
      ),
      R.h(
        R.Box,
        { flexDirection: 'row', columnGap: 'xs', alignItems: 'center' },
        m.percent !== undefined &&
          zone !== 'ok' &&
          R.h(R.Button, {
            key: 'hdr-compact',
            label: `☀️ ${S.compactNow}`,
            variant: zone === 'bad' ? 'primary' : undefined,
            onPress: async () => {
              const result = await act.compact()
              act.toast(
                result.kind === 'failed'
                  ? S.compactBusy
                  : result.kind === 'skipped'
                    ? result.reason
                    : S.compactDone,
              )
              await act.refreshMeter().catch(() => {})
            },
          }),
        R.h(R.Button, {
          key: 'settings',
          label: '⚙',
          variant: tab === 'settings' ? 'primary' : undefined,
          onPress: () =>
            act.intent({
              kind: 'tab',
              tab: tab === 'settings' ? 'map' : 'settings',
            }),
        }),
      ),
    ),
  )
  const tabs = R.h(
    R.Box,
    { flexDirection: 'row', flexWrap: 'wrap', gap: 'xs' },
    TABS.map((t) =>
      R.h(R.Button, {
        key: `t-${t}`,
        label: S.tabs[t].toUpperCase(),
        variant: t === tab ? 'primary' : undefined,
        onPress: () => act.intent({ kind: 'tab', tab: t }),
      }),
    ),
  )
  const credit = R.h(
    R.Box,
    {
      flexDirection: 'row',
      columnGap: 'xs',
      flexWrap: 'wrap',
      alignItems: 'center',
    },
    R.h(
      R.Text,
      { size: 'caption', dimColor: true },
      S.madeBy,
      ' Unkillable Companies ·',
    ),
    R.h(R.Link, {
      key: 'site',
      href: 'https://unkillablecompanies.com',
      label: S.site,
    }),
  )
  const b = s.body
  let body: N
  let drawn: DrawnMap | undefined
  // what the body seats in the footer, above the credit: the map's legend in a framed pane
  let seated: N | undefined
  let mapHeader: N | undefined
  switch (b.tab) {
    case 'context':
      body = renderContext(R, s, b, act)
      break
    case 'files':
      body = renderFiles(R, s, b, act)
      break
    case 'map': {
      const out = renderMap(R, s, b, act, maps)
      body = out.node
      drawn = out.drawn
      seated = out.footer
      mapHeader = out.header
      break
    }
    case 'settings':
      body = renderSettings(R, s, b, act)
      break
    case 'goal':
      body = renderGoal(R, s, b, act)
      break
    case 'coach':
      body = renderCoach(R, s, b, act)
      break
  }
  const footer =
    seated === undefined
      ? R.h(R.Box, { flexDirection: 'column', gap: 'xs' }, credit)
      : R.h(R.Box, { flexDirection: 'column', gap: 'xs' }, seated, credit)
  const fill = s.fill
  if (fill === undefined)
    return {
      node: R.h(
        R.Box,
        { flexDirection: 'column', gap: 'sm' },
        header,
        tabs,
        body,
        footer,
      ),
      drawn,
    }
  const window = fill.body
  const navigation =
    window !== undefined && act.scrollBody !== undefined
      ? R.h(
          R.Box,
          {
            key: 'body-navigation',
            flexDirection: 'column',
          },
          R.h(
            R.Box,
            {
              flexDirection: 'row',
              flexWrap: 'wrap',
              alignItems: 'center',
              columnGap: 'xs',
            },
            ...(['first', 'previous', 'next', 'last'] as const).map((to) =>
              R.h(R.Button, {
                key: `body-${to}`,
                label: S.bodyPages[to],
                onPress: () => act.scrollBody?.(to),
              }),
            ),
          ),
          R.h(
            R.Box,
            { height: 1, overflow: 'hidden' },
            R.h(
              R.Text,
              { size: 'caption', tabular: true, wrap: 'truncate-end' },
              `${Math.min(window.offset + 1, window.content)}–${Math.min(window.offset + window.viewport, window.content)} / ${window.content}`,
            ),
          ),
        )
      : undefined
  const probe = (
    kind: 'viewport' | 'content' | 'header' | 'footer',
    stamp: string,
    expectedRows: number,
    reach: number,
  ) =>
    R.Measure &&
    R.h(
      R.Box,
      {
        key: `${kind}-probe-holder`,
        position: 'absolute',
        top: 0,
        left: 0,
        width: 0,
        height: '100%',
      },
      R.h(R.Measure, {
        key: `${kind}-probe`,
        kind,
        stamp,
        expectedRows,
        reach,
      }),
    )
  const chrome = fill.chrome
  const paneHeader = R.h(
    R.Box,
    {
      key: 'pane-header',
      position: 'relative',
      flexDirection: 'column',
      flexShrink: 0,
      gap: compact ? 'xs' : 'sm',
    },
    header,
    tabs,
    mapHeader,
    chrome && probe('header', chrome.stamp, chrome.header, chrome.headerReach),
  )
  const paneFooter = R.h(
    R.Box,
    {
      key: 'pane-footer',
      position: 'relative',
      flexDirection: 'column',
      flexShrink: 0,
      gap: 'xs',
    },
    navigation,
    footer,
    chrome && probe('footer', chrome.stamp, chrome.footer, chrome.footerReach),
  )
  if (chrome?.notice)
    return {
      node: R.h(
        R.Box,
        { position: 'relative', height: fill.rows, overflow: 'hidden' },
        R.h(R.Text, { wrap: 'wrap' }, S.enlargePane),
        R.h(
          R.Box,
          {
            key: 'chrome-measuring',
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 0,
            overflow: 'hidden',
          },
          R.h(
            R.Box,
            {
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              flexDirection: 'column',
            },
            paneHeader,
            paneFooter,
          ),
        ),
      ),
      drawn: undefined,
    }
  return {
    node: R.h(
      R.Box,
      {
        flexDirection: 'column',
        height: fill.rows,
        overflow: 'hidden',
        gap: compact ? 'xs' : 'sm',
      },
      paneHeader,
      R.h(
        R.Box,
        {
          key: 'pane-body',
          flexDirection: 'column',
          position: 'relative',
          height: 0,
          minHeight: 0,
          flexGrow: 1,
          overflow: 'hidden',
        },
        window === undefined
          ? body
          : [
              probe('viewport', window.stamp, window.viewport, fill.rows),
              R.h(
                R.Box,
                {
                  key: 'body-content',
                  position: 'absolute',
                  top: -window.offset,
                  left: 0,
                  right: 0,
                  flexDirection: 'column',
                },
                body,
                probe('content', window.stamp, window.content, window.reach),
              ),
            ],
      ),
      paneFooter,
    ),
    drawn,
  }
}
