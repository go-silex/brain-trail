// Validate and apply a candidate declaration without performing any I/O.
export function decideViewChanges({
  declaration,
  baseline,
  names,
  result = null,
}) {
  if (declaration === null) {
    return {
      intended: null,
      result: result && { errors: result.errors, intended: false },
    }
  }
  let value
  try {
    value = JSON.parse(declaration)
  } catch {
    throw new Error('view changes declaration: invalid JSON')
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.baseline !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(value.baseline) ||
    typeof value.reason !== 'string' ||
    !value.reason.trim() ||
    !Array.isArray(value.cases) ||
    value.cases.some((name) => typeof name !== 'string' || !name.trim()) ||
    new Set(value.cases).size !== value.cases.length
  ) {
    throw new Error(
      'view changes declaration: invalid baseline, reason or cases',
    )
  }
  const intended = {
    baseline: value.baseline,
    reason: value.reason,
    cases: value.cases,
    applied: value.baseline.toLowerCase() === baseline.toLowerCase(),
  }
  if (intended.applied && names) {
    const known = new Set(names)
    const unknown = value.cases.filter((name) => !known.has(name))
    if (unknown.length) {
      throw new Error(
        `view changes declaration: unknown cases: ${unknown.join(', ')}`,
      )
    }
  }
  if (!result) return { intended, result: null }
  const selected = intended.applied && value.cases.includes(result.name)
  const errors = result.errors.filter(
    (entry) => !selected || entry.kind !== 'difference',
  )
  if (selected && result.errors.length === 0) {
    errors.push({
      kind: 'declaration',
      message: 'declared changed but identical',
    })
  }
  return { intended, result: { errors, intended: selected } }
}
