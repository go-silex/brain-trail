import type { TrailSettings } from '../types/model'
import type { SettingsPatch } from '../types/view'
import type {
  TabSnapshot,
  ViewActions,
  ViewRuntime,
  ViewSnapshot,
} from '../types/view'
import { strings } from './i18n'
import { card } from './view-common'

export const applySettingsPatch = (
  current: TrailSettings,
  patch: SettingsPatch,
): TrailSettings => {
  const { planUsd, ...rest } = patch
  const next = { ...current, ...rest }
  if (planUsd === null) delete next.planUsd
  else if (planUsd !== undefined) next.planUsd = planUsd
  return next
}

export const renderSettings = <N, Press>(
  R: ViewRuntime<N, Press>,
  s: ViewSnapshot,
  b: Extract<TabSnapshot, { tab: 'settings' }>,
  act: ViewActions<Press>,
): N => {
  const S = strings(s.lang, s.assistant)
  const set = b.settings
  const list = ['preview', 'default', ...b.apps]
  const save = (patch: SettingsPatch) => act.saveSettings(patch)
  const choice = (
    key: string,
    value: string,
    on: boolean,
    label: string,
    press: () => unknown,
  ) =>
    R.h(R.Button, {
      key: `${key}-${value}`,
      label,
      variant: on ? 'primary' : undefined,
      onPress: press,
    })
  const appRow = (key: 'openMd' | 'openOther', title: string) =>
    R.h(
      R.Box,
      { key: `row-${key}`, flexDirection: 'column', gap: 'xs' },
      R.h(R.Text, { size: 'caption', weight: 'medium' }, title),
      R.h(
        R.Box,
        { flexDirection: 'row', flexWrap: 'wrap', gap: 'xs' },
        list.map((a) =>
          choice(
            key,
            a,
            set[key] === a,
            a === 'default' ? S.defaultApp : a === 'preview' ? S.previewApp : a,
            () => save({ [key]: a }),
          ),
        ),
      ),
    )
  return R.h(
    R.Box,
    { flexDirection: 'column', gap: 'sm' },
    card(
      R,
      s,
      'open-with',
      S.openWith,
      R.h(
        R.Box,
        { flexDirection: 'column', gap: 'sm' },
        R.h(
          R.Text,
          { size: 'caption', dimColor: true, wrap: 'wrap' },
          S.openWithWhy,
        ),
        b.appsUnavailable &&
          R.h(
            R.Text,
            { size: 'caption', dimColor: true, wrap: 'wrap' },
            S.appsUnavailable,
          ),
        appRow('openMd', S.openMd),
        appRow('openOther', S.openOther),
      ),
    ),
    card(
      R,
      s,
      'plan',
      S.planTitle,
      R.h(
        R.Box,
        { flexDirection: 'column', gap: 'xs' },
        R.h(
          R.Text,
          { size: 'caption', dimColor: true, wrap: 'wrap' },
          S.planWhy,
        ),
        R.h(R.Input, {
          key: 'plan-usd',
          placeholder: S.planPlaceholder,
          value: set.planUsd !== undefined ? String(set.planUsd) : '',
          submitLabel: S.save,
          onSubmit: (v: string) => {
            const n = Number(v.replace(',', '.').replace(/[^0-9.]/g, ''))
            return save({ planUsd: n > 0 ? n : null })
          },
        }),
      ),
    ),
    card(
      R,
      s,
      'trail',
      S.trailCard,
      R.h(
        R.Box,
        { flexDirection: 'column', gap: 'xs' },
        R.h(
          R.Text,
          { size: 'caption', dimColor: true, wrap: 'wrap' },
          S.clearWhy,
        ),
        R.h(
          R.Box,
          { flexDirection: 'row' },
          R.h(R.Button, {
            key: 'clear',
            label: S.clear,
            onPress: () => act.clearTrail(),
          }),
        ),
      ),
    ),
    card(
      R,
      s,
      'display',
      S.display,
      R.h(
        R.Box,
        { flexDirection: 'column', gap: 'sm' },
        R.h(
          R.Box,
          { flexDirection: 'column', gap: 'xs' },
          R.h(R.Text, { size: 'caption', weight: 'medium' }, S.language),
          R.h(
            R.Box,
            { flexDirection: 'row', gap: 'xs' },
            choice('lang', 'en', s.lang === 'en', 'English', () =>
              act.setLang('en'),
            ),
            choice('lang', 'fr', s.lang === 'fr', 'Français', () =>
              act.setLang('fr'),
            ),
          ),
        ),
        R.h(
          R.Box,
          { flexDirection: 'column', gap: 'xs' },
          R.h(R.Text, { size: 'caption', weight: 'medium' }, S.bandSetting),
          R.h(
            R.Text,
            { size: 'caption', dimColor: true, wrap: 'wrap' },
            S.bandWhy,
          ),
          R.h(
            R.Box,
            { flexDirection: 'row', gap: 'xs' },
            choice('band', 'on', set.band !== false, S.on, () =>
              save({ band: true }),
            ),
            choice('band', 'off', set.band === false, S.off, () =>
              save({ band: false }),
            ),
          ),
        ),
        R.h(
          R.Box,
          { flexDirection: 'column', gap: 'xs' },
          R.h(R.Text, { size: 'caption', weight: 'medium' }, S.hoverNames),
          R.h(
            R.Text,
            { size: 'caption', dimColor: true, wrap: 'wrap' },
            S.hoverWhy,
          ),
          R.h(
            R.Box,
            { flexDirection: 'row', gap: 'xs' },
            choice('hover', 'on', set.hover, S.on, () => save({ hover: true })),
            choice('hover', 'off', !set.hover, S.off, () =>
              save({ hover: false }),
            ),
          ),
        ),
      ),
    ),
  )
}
