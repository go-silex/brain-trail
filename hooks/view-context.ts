import type {
  TabSnapshot,
  ViewActions,
  ViewChild,
  ViewRuntime,
  ViewSnapshot,
} from '../types/view'
import { mcpServerRows, toolLabel } from './acts'
import { strings } from './i18n'
import { fileName, gauge } from './map'
import {
  costRatio,
  costsSinceCompact,
  fmt,
  limitOf,
  resetLabel,
  usd,
  usedStart,
  windowFacts,
} from './readout'
import { label2 } from './view-common'

export const renderContext = <N, Press>(
  R: ViewRuntime<N, Press>,
  s: ViewSnapshot,
  body: Extract<TabSnapshot, { tab: 'context' }>,
  act: ViewActions<Press>,
): N => {
  const S = strings(s.lang, s.assistant, s.costInfoCommand)
  const P = s.palette
  const m = s.meter
  const list = s.events
  const b = body.breakdown
  const hist = body.costHistory
  const set = body.settings
  const { pct, zone, win, compactAt } = windowFacts(m.percent, m.window, b)
  const gw = Math.max(200, s.widthPx - 40)
  const { startCats, startTotal, messages } = usedStart(b?.categories)
  const costs = costsSinceCompact(list)
  const tipFor = (tool: string) =>
    tool.startsWith('mcp__')
      ? S.tip.mcp
      : ((S.tip as Record<string, string>)[tool] ?? S.tip.other)
  const { byServer, mcpServers } = mcpServerRows(b?.mcpTools ?? [])
  const toolName = (tool: string) => toolLabel(tool, byServer)
  const svg = (
    key: string,
    source: string,
    w: number,
    height: number,
    alt: string,
  ): N =>
    R.Svg !== undefined
      ? w === 0
        ? R.h(R.Svg, { key, source, alt })
        : R.h(R.Svg, { key, source, width: w, height, alt })
      : R.h(R.Text, { dimColor: true }, S.mapOnlyDesktop)
  const card = (key: string, title: string, children: ViewChild<N>): N =>
    R.h(
      R.Box,
      {
        key,
        flexDirection: 'column',
        gap: 'xs',
        borderStyle: 'single',
        borderColor: P.line,
        padding: 'sm',
      },
      R.h(
        R.Text,
        { size: 'caption', weight: 'medium', dimColor: true },
        title.toUpperCase(),
      ),
      children,
    )
  const bar = (key: string, tokens: number, max: number, color: string) =>
    svg(
      key,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 6" width="100" height="6" preserveAspectRatio="none"><rect width="100" height="6" rx="3" fill="${P.line}"/><rect width="${Math.max(1.5, Math.min(100, (tokens / Math.max(max, 1)) * 100))}" height="6" rx="3" fill="${color}" fill-opacity=".8"/></svg>`,
      100,
      6,
      '',
    )
  const row = (
    key: string,
    name: string,
    tokens: number,
    color: string,
    max: number,
    note?: string,
  ) =>
    R.h(
      R.Box,
      { key, flexDirection: 'row', gap: 'sm', alignItems: 'center' },
      R.h(
        R.Box,
        { flexGrow: 1, flexShrink: 1, flexDirection: 'column' },
        R.h(R.Text, { size: 'caption', wrap: 'truncate-end' }, name),
        note !== undefined &&
          note !== '' &&
          R.h(
            R.Text,
            { size: 'caption', dimColor: true, wrap: 'truncate-end' },
            note,
          ),
      ),
      bar(`${key}-bar`, tokens, max, color),
      R.h(
        R.Box,
        { minWidth: 6, flexDirection: 'row', justifyContent: 'flex-end' },
        R.h(
          R.Text,
          { size: 'caption', mono: true, tabular: true, dimColor: true },
          fmt(tokens),
        ),
      ),
    )
  const prompts = Math.max(1, list.filter((ev) => ev.k === 'prompt').length)
  const ratio = costRatio(m.usd, hist.median, hist.count)
  const verdict =
    ratio === undefined
      ? S.verdictWait(hist.count)
      : ratio < 0.6
        ? S.verdictLight(ratio)
        : ratio <= 1.5
          ? S.verdictUsual
          : S.verdictHeavy(ratio)
  const open = s.open.includes('context')

  return R.h(
    R.Box,
    { flexDirection: 'column', gap: 'sm' },
    card(
      'window',
      S.whatToDo,
      R.h(
        R.Box,
        { flexDirection: 'column', gap: 'xs' },
        m.percent === undefined &&
          R.h(R.Text, { size: 'caption', dimColor: true }, S.noReading),
        svg('gauge', gauge(P, gw, pct, compactAt, [], 100), 0, 0, `${pct}%`),
        R.h(
          R.Text,
          { wrap: 'wrap', weight: zone === 'ok' ? undefined : 'medium' },
          S.zone[zone],
        ),
      ),
    ),
    (m.limits ?? []).some(
      (l) => l.kind === 'five_hour' || l.kind === 'seven_day',
    ) &&
      card(
        'plan-use',
        S.planUse,
        R.h(
          R.Box,
          { flexDirection: 'column', gap: 'sm' },
          (['five_hour', 'seven_day'] as const).map((kind) => {
            const l = limitOf(m, kind)
            if (l === undefined) return null
            const reset = resetLabel(l.resetsAt, s.lang)
            return R.h(
              R.Box,
              { key: `lim-${kind}`, flexDirection: 'column', gap: 'xs' },
              R.h(
                R.Box,
                { flexDirection: 'row', justifyContent: 'space-between' },
                R.h(
                  R.Text,
                  { size: 'caption', weight: 'medium' },
                  kind === 'five_hour' ? S.limit5h : S.limit7d,
                ),
                reset !== '' &&
                  R.h(
                    R.Text,
                    { size: 'caption', dimColor: true },
                    S.resetsAt(reset),
                  ),
              ),
              svg(
                `lim-bar-${kind}`,
                gauge(P, gw, l.percentUsed, undefined, [], 100),
                0,
                0,
                `${l.percentUsed}%`,
              ),
              R.h(
                R.Text,
                { size: 'caption', dimColor: true, tabular: true },
                S.usedPct(Math.round(l.percentUsed)),
              ),
            )
          }),
        ),
      ),
    card(
      'cost',
      S.costTitle,
      R.h(
        R.Box,
        { flexDirection: 'column', gap: 'xs' },
        m.usd === undefined
          ? R.h(
              R.Text,
              { size: 'caption', dimColor: true, wrap: 'wrap' },
              S.costNone,
            )
          : R.h(
              R.Box,
              { flexDirection: 'column', gap: 'xs' },
              R.h(
                R.Text,
                { size: 'title', weight: 'regular', tabular: true },
                usd(m.usd),
              ),
              R.h(
                R.Text,
                { size: 'caption', dimColor: true, wrap: 'wrap' },
                S.costWhat,
              ),
              R.h(R.Text, { wrap: 'wrap' }, verdict),
            ),
      ),
    ),
    R.h(
      R.Box,
      { key: 'more-context', flexDirection: 'row' },
      R.h(R.Button, {
        key: 'more-context',
        plain: true,
        dimColor: true,
        label: open ? S.lessDetails : S.moreDetails,
        onPress: () => {
          void act.intent({ kind: 'toggle-open', key: 'context' })
        },
      }),
    ),
    open &&
      card(
        'details-window',
        S.window,
        R.h(
          R.Box,
          { flexDirection: 'column', gap: 'xs' },
          R.h(
            R.Text,
            { size: 'caption', dimColor: true, tabular: true },
            S.ofTokens(fmt(m.tokens ?? 0), fmt(win)),
          ),
          R.h(
            R.Text,
            { size: 'caption', dimColor: true },
            compactAt !== undefined
              ? S.compactAt(compactAt)
              : b !== undefined && !b.isAutoCompactEnabled
                ? S.compactOff
                : '',
          ),
        ),
      ),
    open &&
      m.usd !== undefined &&
      card(
        'details-cost',
        S.costTitle,
        R.h(
          R.Box,
          { flexDirection: 'column', gap: 'xs' },
          R.h(
            R.Text,
            { size: 'caption', tabular: true },
            S.perRequest(usd(m.usd / prompts), prompts),
          ),
          R.h(
            R.Text,
            { size: 'caption', tabular: true },
            S.thisMonth(usd(hist.monthUsd)),
          ),
          set.planUsd !== undefined && set.planUsd > 0
            ? R.h(
                R.Text,
                { size: 'caption', weight: 'medium', wrap: 'wrap' },
                hist.monthUsd >= set.planUsd
                  ? S.saved(usd(hist.monthUsd - set.planUsd), usd(set.planUsd))
                  : S.notYet(
                      usd(set.planUsd - hist.monthUsd),
                      usd(set.planUsd),
                    ),
              )
            : R.h(
                R.Text,
                { size: 'caption', dimColor: true, wrap: 'wrap' },
                S.planHint,
              ),
          R.h(
            R.Text,
            { size: 'caption', dimColor: true, wrap: 'wrap' },
            S.costHow,
          ),
        ),
      ),
    open &&
      b !== undefined &&
      card(
        'start',
        `${S.startTitle} · ${fmt(startTotal)}`,
        R.h(
          R.Box,
          { flexDirection: 'column', gap: 'xs' },
          R.h(
            R.Text,
            { size: 'caption', dimColor: true, wrap: 'wrap' },
            S.startWhy,
          ),
          startCats.map((k) =>
            row(`cat-${k.name}`, k.name, k.tokens, P.fg, startTotal),
          ),
          b.memoryFiles.length > 0 &&
            R.h(R.Box, { marginTop: 'xs' }, label2(R, S.memory)),
          b.memoryFiles.map((f) =>
            R.h(
              R.Box,
              {
                key: `mem-${f.path}`,
                flexDirection: 'row',
                gap: 'sm',
                alignItems: 'center',
              },
              R.h(
                R.Box,
                { flexGrow: 1, flexShrink: 1, flexDirection: 'column' },
                R.h(
                  R.Button,
                  {
                    key: `open-mem-${f.path}`,
                    plain: true,
                    onPress: () => {
                      void act.openFile({ p: f.path, out: true })
                    },
                  },
                  fileName(f.path),
                  ' ',
                  R.h(R.Text, { dimColor: true }, f.type),
                ),
                R.h(
                  R.Text,
                  { size: 'caption', dimColor: true, wrap: 'truncate-start' },
                  f.path,
                ),
              ),
              R.h(
                R.Text,
                { size: 'caption', mono: true, tabular: true, dimColor: true },
                fmt(f.tokens),
              ),
            ),
          ),
          mcpServers.size > 0 &&
            R.h(
              R.Box,
              { marginTop: 'xs' },
              label2(
                R,
                `${S.mcp} · ${S.mcpLine(mcpServers.size, b.mcpTools.length)}`,
              ),
            ),
          [...mcpServers]
            .sort((a, z) => z[1].tokens - a[1].tokens)
            .slice(0, 8)
            .map(([server, v]) =>
              row(
                `mcp-${server}`,
                server,
                v.tokens,
                P.fg,
                startTotal,
                v.loaded < v.tools
                  ? `${v.tools} · ${S.deferred}`
                  : String(v.tools),
              ),
            ),
          b.skills !== undefined &&
            R.h(
              R.Box,
              { marginTop: 'xs' },
              label2(
                R,
                `${S.skills} · ${S.skillsLine(b.skills.includedSkills, b.skills.totalSkills)} · ${fmt(b.skills.tokens)}`,
              ),
            ),
          b.agents.length > 0 &&
            R.h(
              R.Text,
              { size: 'caption', dimColor: true },
              S.agents,
              ': ',
              b.agents.map((a) => a.agentType).join(', '),
            ),
        ),
      ),
    open &&
      card(
        'eaters',
        `${S.eaters}${messages ? ` · ${fmt(messages.tokens)}` : ''}`,
        R.h(
          R.Box,
          { flexDirection: 'column', gap: 'xs' },
          R.h(
            R.Text,
            { size: 'caption', dimColor: true, wrap: 'wrap' },
            S.eatersWhy,
          ),
          costs.length === 0 &&
            R.h(R.Text, { size: 'caption', dimColor: true }, S.noEaters),
          costs.map((ev, i) =>
            R.h(
              R.Box,
              { key: `eat-${i}`, flexDirection: 'column' },
              R.h(
                R.Box,
                { flexDirection: 'row', gap: 'sm' },
                R.h(
                  R.Text,
                  { size: 'caption', mono: true, tabular: true },
                  `≈${fmt(ev.tokens)}`.padStart(6),
                ),
                R.h(
                  R.Text,
                  { size: 'caption', weight: 'medium' },
                  toolName(ev.tool),
                ),
                R.h(
                  R.Text,
                  { size: 'caption', dimColor: true, wrap: 'truncate-start' },
                  ev.label,
                ),
              ),
              R.h(
                R.Text,
                { size: 'caption', dimColor: true, wrap: 'wrap' },
                tipFor(ev.tool),
              ),
            ),
          ),
        ),
      ),
  )
}
