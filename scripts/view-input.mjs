const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const stable = (value) =>
  JSON.stringify(value, (_, nested) => {
    if (!record(nested)) return nested
    return Object.fromEntries(
      Object.keys(nested)
        .sort()
        .map((key) => [key, nested[key]]),
    )
  })

// Input mismatches are operational errors, never visual differences eligible for approval.
export function fixtureInputProblem(scenario, baseline, candidate) {
  const expectedActions =
    scenario.phase === 'loading'
      ? []
      : [
          ...(scenario.browser3d ? ['open-3d'] : []),
          ...(scenario.transition === 'follow' ? ['follow'] : []),
          ...(scenario.transition === 'replay' ? ['play'] : []),
          ...(scenario.phase === 'coach-error' ? ['coach-run'] : []),
        ]
  for (const [side, capture] of [
    ['baseline', baseline],
    ['candidate', candidate],
  ]) {
    const fixture = capture?.fixture
    const input = fixture?.input
    if (!record(fixture) || !record(input) || !Array.isArray(fixture.actions))
      return `${side} fixture input/action transcript is missing`
    if (stable(fixture.actions) !== stable(expectedActions))
      return `${side} fixture did not complete the expected actions`
    if (
      stable(input.scenario) !== stable(scenario) ||
      input.semantic !== false ||
      !Number.isFinite(input.clock) ||
      typeof input.cwd !== 'string' ||
      !input.cwd ||
      typeof input.home !== 'string' ||
      !input.home ||
      typeof input.noteBody !== 'string' ||
      !Array.isArray(input.files) ||
      input.files.length === 0 ||
      !input.files.every(
        (file) => typeof file === 'string' && file.length > 0,
      ) ||
      new Set(input.files).size !== input.files.length ||
      input.listing !== (scenario.phase === 'error' ? 'empty' : 'files') ||
      !record(input.state) ||
      !record(input.store) ||
      !record(input.usage)
    )
      return `${side} fixture input contract is invalid`
    const state = input.state
    const expectedKeys = [
      'events',
      'lang',
      'meter',
      'settings',
      'tab',
      ...(scenario.view3d ? ['view3d'] : []),
    ].sort()
    if (
      stable(Object.keys(state).sort()) !== stable(expectedKeys) ||
      state.tab !== scenario.tab ||
      state.lang !== scenario.lang ||
      (scenario.view3d && state.view3d !== true) ||
      input.store.lang !== scenario.lang ||
      !record(state.events) ||
      state.events.shape !== 'events-1' ||
      !Array.isArray(state.events.value) ||
      (scenario.phase === 'empty'
        ? state.events.value.length !== 0
        : state.events.value.length === 0) ||
      !record(state.meter) ||
      state.meter.shape !== 'meter-1' ||
      !record(state.meter.value) ||
      !record(state.settings) ||
      state.settings.shape !== 'settings-1' ||
      !record(state.settings.value) ||
      stable(state.settings.value) !== stable(input.store.settings)
    )
      return `${side} fixture seeded state or store is invalid`
  }
  if (stable(baseline.fixture) !== stable(candidate.fixture))
    return 'baseline and candidate fixture input/action transcripts differ'
  return null
}
