import type {
  TabSnapshot,
  ViewActions,
  ViewRuntime,
  ViewSnapshot,
} from '../types/view'
import { pairKey } from './files'
import { replay } from './fold'
import { strings } from './i18n'
import { fileName } from './map'
import { fileFigures, fileTree, fmt, projectFiles } from './readout'
import type { FileDir, FileEntry, FileFigure } from './readout'
import { card, more } from './view-common'
import { absOf } from './view-controller'

type FilesSnapshot = Extract<TabSnapshot, { tab: 'files' }>

export const renderFiles = <N, Press>(
  R: ViewRuntime<N, Press>,
  s: ViewSnapshot,
  b: FilesSnapshot,
  act: ViewActions<Press>,
): N => {
  const S = strings(s.lang, s.assistant),
    P = s.palette
  const isOpen = (key: string) => s.open.includes(key)

  if (b.preview !== null) {
    const { ref, text, settings, apps } = b.preview
    const abs = absOf(b.fold.index, ref)
    const body =
      text === undefined
        ? undefined
        : text.length > 40000
          ? `${text.slice(0, 40000)}\n\n…`
          : text
    const app =
      abs.endsWith('.md') && apps.includes('Obsidian')
        ? 'Obsidian'
        : settings.openOther !== 'preview' && settings.openOther !== 'default'
          ? settings.openOther
          : 'default'
    return R.h(
      R.Box,
      { flexDirection: 'column', gap: 'sm' },
      R.h(
        R.Box,
        { flexDirection: 'row', gap: 'xs', alignItems: 'center' },
        R.h(R.Button, {
          key: 'preview-back',
          label: `‹ ${S.back}`,
          onPress: () => act.intent({ kind: 'preview', ref: null }),
        }),
        R.h(R.Button, {
          key: 'preview-open',
          label: app === 'default' ? S.openElsewhere : S.openIn(app),
          onPress: () => act.openIn(ref, app),
        }),
      ),
      card(
        R,
        s,
        'preview',
        fileName(ref.p),
        R.h(
          R.Box,
          { flexDirection: 'column', gap: 'xs' },
          R.h(
            R.Text,
            { size: 'caption', dimColor: true, wrap: 'truncate-start' },
            ref.p,
          ),
          body === undefined
            ? R.h(R.Text, { dimColor: true }, S.cannotRead)
            : abs.endsWith('.md') && R.Markdown !== undefined
              ? R.h(R.Markdown, { text: body })
              : R.Code !== undefined
                ? R.h(R.Code, { source: body, path: abs })
                : R.h(R.Text, { wrap: 'wrap' }, body),
        ),
      ),
    )
  }

  const index = b.fold.index
  const entries = [
    ...projectFiles(
      s.events,
      b.breakdown?.memoryFiles ?? [],
      index?.root ?? '',
    ).values(),
  ]
  const { gaps } = replay(s.events, index, b.fold.linked, b.fold.connected)
  const copy: Record<FileFigure['id'], { label: string; why: string }> = {
    start: { label: S.gStart, why: S.gStartWhy },
    read: { label: S.gRead, why: S.gReadWhy },
    written: { label: S.gWritten, why: S.gWrittenWhy },
    found: { label: S.gFound, why: S.gFoundWhy },
    linked: { label: S.gLinked, why: S.gLinkedWhy },
    agent: { label: S.gAgent, why: S.gAgentWhy },
    missing: { label: S.missing, why: S.missingWhy },
  }
  const figures = fileFigures(entries, gaps.length).map((fg) => ({
    ...fg,
    ...copy[fg.id],
  }))
  const chosen = figures.find((fg) => isOpen(`kpi:${fg.id}`))
  const kpis = R.h(
    R.Box,
    { flexDirection: 'row', flexWrap: 'wrap', gap: 'xs' },
    figures.map((fg) =>
      R.h(
        R.Box,
        {
          key: `kpi-${fg.id}`,
          flexDirection: 'column',
          flexGrow: 1,
          minWidth: '30%',
          borderStyle: 'single',
          borderColor: chosen?.id === fg.id ? P.fg : P.line,
          padding: 'sm',
        },
        R.h(
          R.Text,
          {
            size: 'heading',
            weight: 'regular',
            tabular: true,
            dimColor: fg.n === 0,
          },
          fg.n,
        ),
        R.h(R.Button, {
          key: `kpi-open-${fg.id}`,
          plain: true,
          dimColor: chosen?.id !== fg.id,
          label: `${fg.label} ${chosen?.id === fg.id ? '▴' : '▾'}`,
          onPress: () => act.intent({ kind: 'figure', id: fg.id }),
        }),
      ),
    ),
  )
  const detailRow = (x: FileEntry) => {
    const facts = [
      x.reads > 0 ? S.kpiRead(x.reads) : '',
      x.writes > 0 ? S.kpiWrite(x.writes) : '',
      x.tokens > 0 ? S.kpiTokens(fmt(x.tokens)) : '',
    ]
      .filter(Boolean)
      .join(' · ')
    const dir = x.p.includes('/') ? x.p.slice(0, x.p.lastIndexOf('/')) : ''
    return R.h(
      R.Box,
      {
        key: `kd-${x.p}`,
        flexDirection: 'row',
        gap: 'sm',
        alignItems: 'center',
      },
      R.h(
        R.Box,
        { flexDirection: 'column', flexGrow: 1, flexShrink: 1 },
        R.h(R.Button, {
          key: `kd-open-${x.p}`,
          plain: true,
          label: fileName(x.p),
          onPress: () => act.openFile({ p: x.p, out: x.out }),
        }),
        dir !== '' &&
          R.h(
            R.Text,
            { size: 'caption', dimColor: true, wrap: 'truncate-start' },
            dir,
          ),
      ),
      facts !== '' &&
        R.h(
          R.Text,
          { size: 'caption', mono: true, tabular: true, dimColor: true },
          facts,
        ),
    )
  }
  const { top, outside } = fileTree(entries)
  const fileRow = (x: FileEntry, depth: number) =>
    R.h(
      R.Box,
      { key: `f-${x.p}`, flexDirection: 'row', paddingLeft: depth * 2 + 2 },
      R.h(R.Button, {
        key: `open-${x.p}`,
        plain: true,
        label: fileName(x.p),
        onPress: () => act.openFile({ p: x.p, out: x.out }),
      }),
    )
  const rows: N[] = []
  const walk = (d: FileDir, depth: number) => {
    for (const folder of [...d.dirs.values()].sort((a, z) =>
      a.name.localeCompare(z.name),
    )) {
      const closed = isOpen(`fold:${folder.path}`)
      rows.push(
        R.h(
          R.Box,
          {
            key: `d-${folder.path}`,
            flexDirection: 'row',
            paddingLeft: depth * 2,
          },
          R.h(R.Button, {
            key: `dir-${folder.path}`,
            plain: true,
            label: `${closed ? '▸' : '▾'} ${folder.name}`,
            onPress: () =>
              act.intent({ kind: 'toggle-open', key: `fold:${folder.path}` }),
          }),
        ),
      )
      if (!closed) walk(folder, depth + 1)
    }
    for (const x of [...d.files].sort((a, z) => a.p.localeCompare(z.p)))
      rows.push(fileRow(x, depth))
  }
  walk(top, 0)
  if (outside.length > 0) {
    rows.push(
      R.h(
        R.Box,
        {
          key: 'd-outside',
          flexDirection: 'row',
          columnGap: 'sm',
          alignItems: 'center',
          marginTop: 'xs',
        },
        R.h(
          R.Text,
          { size: 'caption', dimColor: true },
          S.outsideN(outside.length),
        ),
        more(R, s, act, 'outside'),
      ),
    )
    if (isOpen('outside'))
      for (const x of outside.sort((a, z) => a.p.localeCompare(z.p)))
        rows.push(fileRow(x, 0))
  }
  const gapRows =
    index === undefined
      ? []
      : gaps.slice(0, 10).map((g) => {
          const from = index.paths[g.from]!,
            to = index.paths[g.to]!
          const line = `- Related: [[${to.replace(/\.md$/, '')}|${fileName(to).replace(/\.md$/, '')}]]`
          return R.h(
            R.Box,
            {
              key: `gap-${pairKey(g.from, g.to)}`,
              flexDirection: 'row',
              gap: 'sm',
              alignItems: 'center',
            },
            R.h(
              R.Box,
              { flexDirection: 'column', flexGrow: 1, flexShrink: 1 },
              R.h(
                R.Text,
                { size: 'caption', wrap: 'truncate-end' },
                fileName(from),
              ),
              R.h(
                R.Text,
                { size: 'caption', dimColor: true, wrap: 'truncate-end' },
                S.then,
                ' ',
                fileName(to),
              ),
            ),
            R.h(R.Button, {
              key: `copy-${pairKey(g.from, g.to)}`,
              label: S.copy,
              onPress: async (press) => {
                if (await act.copy(line, press))
                  act.toast(`${S.copied}: ${line}`)
              },
            }),
            R.h(R.Button, {
              key: `open-gap-${pairKey(g.from, g.to)}`,
              label: S.open,
              onPress: () => act.openFile({ p: from }),
            }),
          )
        })
  const detail =
    chosen === undefined
      ? undefined
      : card(
          R,
          s,
          `kpi-detail-${chosen.id}`,
          `${chosen.label} · ${chosen.n}`,
          R.h(
            R.Box,
            { flexDirection: 'column', gap: 'xs' },
            R.h(
              R.Text,
              { size: 'caption', dimColor: true, wrap: 'wrap' },
              chosen.why,
            ),
            chosen.n === 0 &&
              R.h(R.Text, { size: 'caption', dimColor: true }, S.kpiEmpty),
            chosen.files !== undefined
              ? chosen.files.slice(0, 80).map(detailRow)
              : gapRows,
          ),
        )
  return R.h(
    R.Box,
    { flexDirection: 'column', gap: 'sm' },
    kpis,
    detail,
    card(
      R,
      s,
      'tree',
      S.filesIntro,
      rows.length === 0
        ? R.h(R.Text, { size: 'caption', dimColor: true }, S.noFiles)
        : R.h(R.Box, { flexDirection: 'column' }, rows),
    ),
    gapRows.length > 0 &&
      chosen?.id !== 'missing' &&
      card(
        R,
        s,
        'gaps',
        `${S.missing} · ${gapRows.length}`,
        R.h(
          R.Box,
          { flexDirection: 'column', gap: 'xs' },
          R.h(
            R.Text,
            { size: 'caption', dimColor: true, wrap: 'wrap' },
            S.missingWhy,
          ),
          gapRows,
        ),
      ),
  )
}
