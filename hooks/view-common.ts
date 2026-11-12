import { strings } from './i18n'
import type {
  ViewActions,
  ViewChild,
  ViewRuntime,
  ViewSnapshot,
} from '../types/view'

export const TITLE = 'Brain Trail'
export const weather = (p: number) =>
  p < 25 ? '☀️' : p < 50 ? '🌤️' : p < 75 ? '🌧️' : '⛈️'
export const label2 = <N, Press>(R: ViewRuntime<N, Press>, text: string): N =>
  R.h(R.Text, { size: 'caption', weight: 'medium', dimColor: true }, text)
export const card = <N, Press>(
  R: ViewRuntime<N, Press>,
  s: ViewSnapshot,
  key: string,
  title: string,
  children: ViewChild<N>,
): N =>
  R.h(
    R.Box,
    {
      key,
      flexDirection: 'column',
      gap: 'xs',
      borderStyle: 'single',
      borderColor: s.palette.line,
      padding: 'sm',
    },
    R.h(
      R.Text,
      { size: 'caption', weight: 'medium', dimColor: true },
      title.toUpperCase(),
    ),
    children,
  )
export const more = <N, Press>(
  R: ViewRuntime<N, Press>,
  s: ViewSnapshot,
  act: ViewActions<Press>,
  key: string,
): N => {
  const S = strings(s.lang, s.assistant)
  return R.h(
    R.Box,
    { key: `more-${key}`, flexDirection: 'row' },
    R.h(R.Button, {
      key: `more-${key}`,
      plain: true,
      dimColor: true,
      label: s.open.includes(key) ? S.lessDetails : S.moreDetails,
      onPress: () => act.intent({ kind: 'toggle-open', key }),
    }),
  )
}
export const svg = <N, Press>(
  R: ViewRuntime<N, Press>,
  s: ViewSnapshot,
  key: string,
  source: string,
  width: number,
  height: number,
  alt: string,
): N =>
  R.Svg
    ? R.h(
        R.Svg,
        width === 0
          ? { key, source, alt }
          : { key, source, width, height, alt },
      )
    : R.h(
        R.Text,
        { dimColor: true },
        strings(s.lang, s.assistant).mapOnlyDesktop,
      )
