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
  const header = R.h(
    R.Box,
    { flexDirection: 'column', gap: 'sm' },
    R.Svg
      ? R.h(R.Svg, {
          key: 'brand',
          source: banner(TITLE, S.tagline, P),
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
          R.h(R.Text, { size: 'caption', dimColor: true }, S.window),
          m.percent !== undefined && R.h(R.Text, null, weather(pct)),
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
  const footer = R.h(
    R.Box,
    { flexDirection: 'column', gap: 'xs' },
    R.h(
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
    ),
  )
  const b = s.body
  let body: N
  let drawn: DrawnMap | undefined
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
}
