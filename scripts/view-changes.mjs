import { createHash } from 'node:crypto'
import path from 'node:path'

// Native proof captures use the timezone of the reviewed corpus.
export const NATIVE_VIEW_TIMEZONE = 'Europe/Paris'
export const nativeViewEnvironment = (env) => ({
  ...env,
  TZ: NATIVE_VIEW_TIMEZONE,
})

// Canonical JSON is shared by the declaration producer and the parity gate.
export const canonicalJson = (value) =>
  JSON.stringify(value, (_, nested) => {
    if (!nested || typeof nested !== 'object' || Array.isArray(nested))
      return nested
    return Object.fromEntries(
      Object.keys(nested)
        .sort()
        .map((key) => [key, nested[key]]),
    )
  })

export const proofFingerprint = (baseline, candidate) =>
  createHash('sha256')
    .update(canonicalJson({ baseline, candidate }))
    .digest('hex')

// Process each side independently, including newly added or moved subtrees.
// Preserve presence and types: only an existing numeric press.handle is replaced.
export function canonicalTree(tree, root) {
  const visit = (value, parentKey = '') => {
    if (Array.isArray(value)) return value.map((item) => visit(item))
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (
          parentKey === 'press' &&
          key === 'handle' &&
          typeof entry === 'number'
        )
          return [key, 0]
        if (
          key === 'module' &&
          typeof entry === 'string' &&
          path.isAbsolute(entry)
        ) {
          const relative = path.relative(
            path.resolve(root),
            path.normalize(entry),
          )
          if (
            relative &&
            relative !== '..' &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative)
          )
            return [key, relative.split(path.sep).join('/')]
        }
        return [key, visit(entry, key)]
      }),
    )
  }
  return visit(tree)
}

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
      result: result && {
        errors: result.errors,
        intended: false,
        observed: result.errors.filter((entry) => entry.kind === 'difference'),
        rejected: result.errors,
      },
    }
  }
  let value
  try {
    value = JSON.parse(declaration)
  } catch {
    throw new Error('view changes declaration: invalid JSON')
  }
  const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  const validKey = (key) =>
    key === 'tree' || /^svg:(0|[1-9]\d*):(source|viewport)$/.test(key)
  if (
    !object(value) ||
    typeof value.baseline !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(value.baseline) ||
    typeof value.reason !== 'string' ||
    !value.reason.trim() ||
    !object(value.cases) ||
    Object.entries(value.cases).some(
      ([name, proofs]) =>
        !name.trim() ||
        !object(proofs) ||
        Object.keys(proofs).length === 0 ||
        Object.entries(proofs).some(
          ([key, hash]) =>
            !validKey(key) ||
            typeof hash !== 'string' ||
            !/^[0-9a-f]{64}$/.test(hash),
        ),
    )
  )
    throw new Error(
      'view changes declaration: invalid baseline, reason or exact case proofs',
    )
  const intended = {
    baseline: value.baseline,
    reason: value.reason,
    cases: value.cases,
    applied: value.baseline.toLowerCase() === baseline.toLowerCase(),
  }
  if (intended.applied && names) {
    const known = new Set(names)
    const unknown = Object.keys(value.cases).filter((name) => !known.has(name))
    if (unknown.length)
      throw new Error(
        `view changes declaration: unknown cases: ${unknown.join(', ')}`,
      )
  }
  if (!result) return { intended, result: null }
  const approvals = intended.applied ? (value.cases[result.name] ?? {}) : {}
  const used = new Set()
  const observed = result.errors.filter((entry) => entry.kind === 'difference')
  const errors = result.errors.filter((entry) => {
    if (
      entry.kind !== 'difference' ||
      !validKey(entry.key) ||
      !Object.hasOwn(approvals, entry.key) ||
      typeof entry.fingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.fingerprint) ||
      approvals[entry.key] !== entry.fingerprint
    )
      return true
    used.add(entry.key)
    return false
  })
  for (const [key, fingerprint] of Object.entries(approvals)) {
    if (!used.has(key))
      errors.push({
        kind: 'declaration',
        key,
        fingerprint,
        message: `unused or mismatched approved difference ${key} (${fingerprint})`,
      })
  }
  return {
    intended,
    result: { errors, intended: used.size > 0, observed, rejected: errors },
  }
}
