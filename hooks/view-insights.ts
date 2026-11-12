import type {
  TabSnapshot,
  ViewActions,
  ViewRuntime,
  ViewSnapshot,
} from '../types/view'
import { coachTips, dur, goalBlocks, hhmm, planNow, tell } from './acts'
import { nameServers } from './fold'
import { strings } from './i18n'
import { card } from './view-common'

export const renderGoal = <N, Press>(
  R: ViewRuntime<N, Press>,
  s: ViewSnapshot,
  b: Extract<TabSnapshot, { tab: 'goal' }>,
  _act: ViewActions<Press>,
): N => {
  const S = strings(s.lang, s.assistant)
  const names = nameServers(s.events, b.connected)
  const blocks = goalBlocks(s.events)
  if (blocks.length === 0)
    return card(
      R,
      s,
      'goal',
      S.goalNow,
      R.h(R.Text, { size: 'caption', dimColor: true, wrap: 'wrap' }, S.noGoal),
    )

  const cur = blocks[blocks.length - 1]!
  const working = cur.end === undefined
  const plan = planNow(s.events)
  const doneCount = plan.filter((x) => x.s === 'completed').length

  return R.h(
    R.Box,
    { flexDirection: 'column', gap: 'sm' },
    card(
      R,
      s,
      'goal',
      S.goalNow,
      R.h(
        R.Box,
        { flexDirection: 'column', gap: 'xs' },
        R.h(R.Text, { weight: 'medium', wrap: 'wrap' }, cur.prompt),
        R.h(
          R.Text,
          { size: 'caption', dimColor: true },
          working
            ? S.workingFor(dur(s.now - cur.at, S))
            : S.doneIn(dur((cur.end ?? s.now) - cur.at, S)),
          ' · ',
          S.actionsN(cur.events.filter((ev) => ev.k === 'act').length),
        ),
      ),
    ),
    plan.length > 0 &&
      card(
        R,
        s,
        'plan',
        `${S.planOfClaude} · ${doneCount}/${plan.length}`,
        R.h(
          R.Box,
          { flexDirection: 'column', gap: 'xs' },
          plan.map((x, i) =>
            R.h(
              R.Box,
              { key: `plan-${i}`, flexDirection: 'row', columnGap: 'sm' },
              R.h(
                R.Text,
                { dimColor: x.s === 'completed' },
                x.s === 'completed' ? '✓' : x.s === 'in_progress' ? '●' : '○',
              ),
              R.h(
                R.Text,
                {
                  wrap: 'wrap',
                  weight: x.s === 'in_progress' ? 'medium' : undefined,
                  dimColor: x.s === 'completed',
                },
                x.t,
              ),
            ),
          ),
        ),
      ),
    card(
      R,
      s,
      'history',
      S.history,
      R.h(
        R.Box,
        { flexDirection: 'column', gap: 'sm' },
        blocks
          .slice()
          .reverse()
          .map((block, bi) => {
            const live = bi === 0 && working
            const told = tell(block.events, S.g, names)
            return R.h(
              R.Box,
              { key: `h-${block.at}`, flexDirection: 'column', gap: 'xs' },
              R.h(
                R.Box,
                { flexDirection: 'row', columnGap: 'sm' },
                R.h(
                  R.Text,
                  { size: 'caption', dimColor: true, tabular: true },
                  hhmm(block.at),
                ),
                R.h(R.Text, { weight: 'medium', wrap: 'wrap' }, block.prompt),
              ),
              told.length === 0
                ? R.h(
                    R.Box,
                    { paddingLeft: 6 },
                    R.h(
                      R.Text,
                      { size: 'caption', dimColor: true },
                      live ? S.thinking : S.noAction,
                    ),
                  )
                : told.slice(-15).map((t, i, all) =>
                    R.h(
                      R.Box,
                      {
                        key: `h-${block.at}-${i}`,
                        flexDirection: 'row',
                        columnGap: 'sm',
                        paddingLeft: 6,
                      },
                      R.h(
                        R.Text,
                        { dimColor: true },
                        live && i === all.length - 1 ? '●' : '✓',
                      ),
                      R.h(
                        R.Text,
                        {
                          wrap: 'wrap',
                          weight:
                            live && i === all.length - 1 ? 'medium' : undefined,
                        },
                        t,
                      ),
                    ),
                  ),
            )
          }),
      ),
    ),
  )
}

export const renderCoach = <N, Press>(
  R: ViewRuntime<N, Press>,
  s: ViewSnapshot,
  b: Extract<TabSnapshot, { tab: 'coach' }>,
  act: ViewActions<Press>,
): N => {
  const S = strings(s.lang, s.assistant)
  const tips = coachTips(s.events, b.breakdown, s.meter.percent, S, b.fold)
  const co = b.coach
  const file = b.instructionFile
  const apply = async () => {
    if (co.patch === undefined) return
    const ok = await act.applyCoach(file, co.patch)
    act.toast(ok ? S.applyReady : S.applyFailed)
  }

  return R.h(
    R.Box,
    { flexDirection: 'column', gap: 'sm' },
    card(
      R,
      s,
      'tips',
      S.whatISee,
      tips.length === 0
        ? R.h(
            R.Text,
            { size: 'caption', dimColor: true, wrap: 'wrap' },
            S.noTip,
          )
        : R.h(
            R.Box,
            { flexDirection: 'column', gap: 'sm' },
            tips.map((t, i) =>
              R.h(
                R.Box,
                { key: `tip-${i}`, flexDirection: 'column' },
                R.h(R.Text, { weight: 'medium', wrap: 'wrap' }, t.title),
                R.h(
                  R.Text,
                  { size: 'caption', dimColor: true, wrap: 'wrap' },
                  t.body,
                ),
              ),
            ),
          ),
    ),
    card(
      R,
      s,
      'analysis',
      S.coachTitle,
      R.h(
        R.Box,
        { flexDirection: 'column', gap: 'xs' },
        R.h(
          R.Text,
          { size: 'caption', dimColor: true, wrap: 'wrap' },
          S.coachWhy,
        ),
        R.h(
          R.Box,
          { flexDirection: 'row' },
          R.h(R.Button, {
            key: 'coach-run',
            label: co.busy ? S.coachBusy : co.text ? S.coachAgain : S.coachRun,
            variant: co.text ? undefined : 'primary',
            onPress: () => {
              if (!co.busy) void act.analyseCoach(s.lang, file)
            },
          }),
        ),
        co.error !== undefined &&
          R.h(R.Text, { color: 'error', wrap: 'wrap' }, co.error),
        co.text !== '' &&
          (R.Markdown !== undefined
            ? R.h(R.Markdown, { text: co.text })
            : R.h(R.Text, { wrap: 'wrap' }, co.text)),
      ),
    ),
    co.patch !== undefined &&
      card(
        R,
        s,
        'patch',
        S.toAdd(file),
        R.h(
          R.Box,
          { flexDirection: 'column', gap: 'xs' },
          R.Code !== undefined
            ? R.h(R.Code, { source: co.patch, language: 'markdown' })
            : R.h(R.Text, { wrap: 'wrap' }, co.patch),
          R.h(
            R.Box,
            { flexDirection: 'row' },
            R.h(R.Button, {
              key: 'coach-apply',
              label: S.applyWith(file),
              variant: 'primary',
              onPress: apply,
            }),
          ),
          R.h(
            R.Text,
            { size: 'caption', dimColor: true, wrap: 'wrap' },
            S.applyHow,
          ),
        ),
      ),
    card(
      R,
      s,
      'academy',
      S.academyTitle,
      R.h(
        R.Box,
        { flexDirection: 'column', gap: 'xs' },
        R.h(
          R.Text,
          { size: 'caption', dimColor: true, wrap: 'wrap' },
          S.academyWhy,
        ),
        R.Link !== undefined
          ? R.h(R.Link, {
              key: 'academy',
              href: 'https://academy.unkillablecompanies.com',
              label: S.academyLink,
            })
          : R.h(R.Text, null, 'academy.unkillablecompanies.com'),
      ),
    ),
  )
}
