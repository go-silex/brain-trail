import type {
  DrawnMap,
  TabSnapshot,
  ViewActions,
  ViewRuntime,
  ViewSnapshot,
} from '../types/view'
import { replay, sliceToStep } from './fold'
import { strings } from './i18n'
import { DARK, kindColors } from './map'
import type { MapRenderer } from './map'
import type { FigureId } from './readout'
import { drawSpin } from './spin'

// In a framed pane (`s.fill`) the map takes the whole box the header and the footer leave, and its
// legend is handed back as `footer` for the pane to seat at the bottom.
export const renderMap = <N, Press>(
  R: ViewRuntime<N, Press>,
  s: ViewSnapshot,
  b: Extract<TabSnapshot, { tab: 'map' }>,
  act: ViewActions<Press>,
  maps: MapRenderer,
): { node: N; drawn: DrawnMap | undefined; header?: N; footer?: N } => {
  const S = strings(s.lang, s.assistant)
  const { h, Box, Text, Button } = R
  if (b.kind === 'failed')
    return {
      node: h(
        Box,
        { flexDirection: 'column', gap: 'sm' },
        h(Text, { color: 'error', wrap: 'wrap' }, S.packFailed, ' ', b.message),
        h(Button, {
          key: 'retry',
          label: S.retry,
          onPress: () => act.retryLayout(),
        }),
      ),
      drawn: undefined,
    }
  if (b.kind === 'loading')
    return {
      node: h(Text, { dimColor: true }, S.packing(b.seconds)),
      drawn: undefined,
    }
  if (!R.Svg)
    return {
      node: h(Text, { dimColor: true }, S.mapOnlyDesktop),
      drawn: undefined,
    }

  const L = b.layout,
    P = s.palette
  const { zoomed: isTrail, camera, play, view3d: in3d, cam3d: cam } = b.state
  const fill = s.fill
  const sliced = sliceToStep(s.events, play.step, s.now)
  const { steps, at } = sliced
  const folded = replay(
    sliced.shown,
    b.fold.index,
    b.fold.linked,
    b.fold.connected,
  )
  const T = folded.trail
  const services = [...T.perSvc.keys()]
  const vault = L.files.every(([p]) => p.endsWith('.md'))
  const touched = new Set(
    [...T.state.entries()]
      .filter(([, state]) => state.k === 'read' || state.k === 'write')
      .map(([n]) => n),
  )
  let svg: string, drawn: DrawnMap
  if (in3d) {
    const result = drawSpin(L, T, P, {
      widthPx: s.widthPx,
      now: s.now,
      cam,
      follow: isTrail,
      filesWord: vault ? S.notes : S.files,
      outside: folded.outside,
      dark: P.bg === DARK.bg,
      ...(fill !== undefined && { aspect: fill.mapAspect }),
    })
    svg = result.svg
    drawn = { kind: '3d', frame: { view: result.view, layout: L, touched } }
  } else {
    const result = maps.draw(L, T, P, {
      zoomed: isTrail,
      widthPx: s.widthPx,
      now: s.now,
      outside: folded.outside,
      filesWord: vault ? S.notes : S.files,
      services,
      box: camera ?? undefined,
      ...(fill !== undefined && { aspect: fill.mapAspect }),
    })
    svg = result.svg
    drawn = { kind: '2d', frame: { view: result.view, layout: L, touched } }
  }
  const whole = camera === null && !isTrail
  const following = isTrail && (in3d || camera === null)
  const group = (key: string, children: N[]) =>
    h(
      Box,
      {
        key,
        flexDirection: 'row',
        flexWrap: 'nowrap',
        columnGap: 'xs',
        alignItems: 'center',
        padding: 'xs',
      },
      children,
    )
  const playing = play.step !== null
  const playControls =
    steps.length < 2
      ? []
      : !playing
        ? [
            h(Button, {
              key: 'play',
              label: `▶  ${S.replay}`,
              onPress: () =>
                act.intent({ kind: 'replay-play', steps: steps.length }),
            }),
          ]
        : [
            play.playing
              ? h(Button, {
                  key: 'pause',
                  label: '❚❚',
                  onPress: () => act.intent({ kind: 'replay-pause' }),
                })
              : h(Button, {
                  key: 'play',
                  label: '▶',
                  onPress: () =>
                    act.intent({ kind: 'replay-play', steps: steps.length }),
                }),
            h(Button, {
              key: 'back',
              label: '‹',
              onPress: () =>
                act.intent({
                  kind: 'replay-step',
                  by: -1,
                  steps: steps.length,
                }),
            }),
            h(Button, {
              key: 'fwd',
              label: '›',
              onPress: () =>
                act.intent({ kind: 'replay-step', by: 1, steps: steps.length }),
            }),
            h(
              Text,
              { key: 'step', size: 'caption', dimColor: true, tabular: true },
              `${(at ?? 0) + 1}/${steps.length}`,
            ),
            h(Button, {
              key: 'live',
              label: S.live,
              onPress: () => act.intent({ kind: 'replay-live' }),
            }),
          ]
  const controls3d = [
    h(Button, {
      key: 'turn-left',
      label: '⟲',
      onPress: () => act.intent({ kind: 'turn-3d', by: -Math.PI / 6 }),
    }),
    h(Button, {
      key: 'spin',
      label: cam.spin ? '❚❚' : '▶',
      onPress: () => act.intent({ kind: 'spin-3d' }),
    }),
    h(Button, {
      key: 'turn-right',
      label: '⟳',
      onPress: () => act.intent({ kind: 'turn-3d', by: Math.PI / 6 }),
    }),
    h(Button, {
      key: 'zoom-out',
      label: '−',
      onPress: () => act.intent({ kind: 'zoom-3d', dir: 'out' }),
    }),
    h(Button, {
      key: 'zoom-in',
      label: '+',
      onPress: () => act.intent({ kind: 'zoom-3d', dir: 'in' }),
    }),
  ]
  const zoomControls = in3d
    ? controls3d
    : [
        h(Button, {
          key: 'zoom-out',
          label: '−',
          onPress: () =>
            act.intent({ kind: 'zoom-2d', fx: 0.5, fy: 0.5, f: 1.8 }),
        }),
        h(Button, {
          key: 'zoom-in',
          label: '+',
          onPress: () =>
            act.intent({ kind: 'zoom-2d', fx: 0.5, fy: 0.5, f: 1 / 1.8 }),
        }),
        ...(whole
          ? []
          : [
              h(Button, {
                key: 'whole',
                label: '⤢',
                onPress: () => act.intent({ kind: 'whole' }),
              }),
            ]),
      ]
  const K = kindColors(P)
  const legendItems: { id: FigureId; col: string; n: number; label: string }[] =
    [
      { id: 'read', col: K.read, n: folded.stats.read, label: S.lgRead },
      { id: 'written', col: K.write, n: folded.stats.write, label: S.lgWrite },
      { id: 'found', col: K.hit, n: folded.stats.hit, label: S.lgFound },
      { id: 'linked', col: K.link, n: folded.stats.link, label: S.lgLinked },
      { id: 'missing', col: K.gap, n: folded.stats.gap, label: S.lgGap },
    ]
  const legend = h(
    Box,
    {
      key: 'map-legend',
      flexDirection: 'row',
      flexWrap: 'wrap',
      columnGap: 'md',
      rowGap: 'xs',
      alignItems: 'center',
    },
    legendItems.map((it) =>
      h(
        Box,
        {
          key: `lg-${it.id}`,
          flexDirection: 'row',
          columnGap: 'xs',
          alignItems: 'center',
        },
        h(Text, { key: `lg-dot-${it.id}`, color: it.col }, '●'),
        h(Button, {
          key: `lg-btn-${it.id}`,
          plain: true,
          dimColor: it.n === 0,
          label: `${it.n} ${it.label}`,
          onPress: () => act.intent({ kind: 'legend', id: it.id }),
        }),
      ),
    ),
    services.length > 0 &&
      h(
        Text,
        { key: 'lg-mcp', size: 'caption', dimColor: true, tabular: true },
        `${T.calls.length} ${S.figCalls}`,
      ),
  )
  const top = group('follow', [
    h(Button, {
      key: 'view-3d',
      label: in3d ? '2D' : '3D',
      onPress: () => act.intent({ kind: 'toggle-3d' }),
    }),
    ...(in3d
      ? [
          h(Button, {
            key: 'open-3d',
            label: S.open3dBig,
            onPress: () =>
              act
                .open3d()
                .catch(() => false)
                .then((ok) => {
                  if (!ok) act.toast(S.open3dFailed)
                }),
          }),
        ]
      : []),
    h(Button, {
      key: 'follow',
      label: following ? S.unfollow : S.follow,
      variant: following ? 'primary' : undefined,
      onPress: () => act.intent({ kind: 'follow', following }),
    }),
  ])
  const bottom = h(
    Box,
    {
      key: 'bottom-bar',
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      alignItems: 'flex-end',
    },
    playControls.length > 0
      ? group('play', playControls)
      : h(Box, { key: 'play-none' }),
    group('zoom', zoomControls),
  )
  const empty =
    T.state.size === 0 && T.calls.length === 0
      ? h(
          Text,
          { key: 'map-empty', size: 'caption', dimColor: true },
          S.mapEmpty,
        )
      : undefined
  return {
    drawn,
    ...(fill !== undefined && {
      header: h(Box, { flexDirection: 'column', flexShrink: 0 }, top, empty),
      footer: h(
        Box,
        { flexDirection: 'column', flexShrink: 0 },
        bottom,
        legend,
      ),
    }),
    node: h(
      Box,
      fill === undefined
        ? { key: 'map-col', flexDirection: 'column', gap: 'xs' }
        : {
            key: 'map-col',
            flexDirection: 'column',
            gap: 'xs',
            flexGrow: 1,
            height: 0,
            minHeight: 0,
            overflow: 'hidden',
          },
      b.shallow &&
        h(
          Text,
          { key: 'map-shallow', size: 'caption', dimColor: true, wrap: 'wrap' },
          S.homeRoot,
        ),
      h(
        Box,
        // Explicit stretch avoids Desktop's row-image auto-centering, which otherwise
        // leaves a fitted SVG at its tiny intrinsic height instead of filling the paint.
        fill === undefined
          ? { key: 'map-wrap', position: 'relative', flexDirection: 'column' }
          : {
              key: 'map-wrap',
              position: 'relative',
              flexDirection: 'row',
              alignItems: 'stretch',
              flexGrow: 1,
              height: 0,
              minHeight: 0,
              overflow: 'hidden',
            },
        h(R.Svg, {
          key: 'map',
          source: svg,
          alt: `${L.title}: ${T.state.size} files touched`,
        }),
        R.MapHit &&
          h(
            Box,
            {
              key: 'map-hit-box',
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
            },
            h(R.MapHit, { key: 'map-hit' }),
          ),
        fill === undefined &&
          T.state.size === 0 &&
          T.calls.length === 0 &&
          h(
            Box,
            {
              key: 'map-empty',
              position: 'absolute',
              top: 2,
              left: 0,
              right: 0,
              flexDirection: 'row',
              justifyContent: 'center',
            },
            h(
              Box,
              { paddingX: 'sm' },
              h(Text, { size: 'caption', dimColor: true }, S.mapEmpty),
            ),
          ),
        fill === undefined &&
          h(
            Box,
            {
              key: 'top-bar',
              position: 'absolute',
              top: 0,
              right: 0,
              flexDirection: 'row',
            },
            top,
          ),
        fill === undefined &&
          h(
            Box,
            {
              key: 'bottom-bar',
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              flexDirection: 'row',
              flexWrap: 'nowrap',
              justifyContent: 'space-between',
              alignItems: 'flex-end',
            },
            playControls.length > 0
              ? group('play', playControls)
              : h(Box, { key: 'play-none' }),
            group('zoom', zoomControls),
          ),
      ),
      fill === undefined && legend,
    ),
  }
}
