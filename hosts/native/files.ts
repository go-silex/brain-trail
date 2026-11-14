import type { PreviewRef } from '../../types/model'
import type { RelayClient } from '../relay/client'

export type FileAuthority = {
  root: string
  generation: number
  refreshGeneration(): Promise<void>
  currentGeneration(): number
  known(ref: PreviewRef): Promise<boolean>
  apps: readonly string[]
}

/** Resolve a session-owned reference, hold it across the effect, then release it. */
export async function withNativeFile<T>(
  relay: RelayClient,
  authority: FileAuthority,
  ref: PreviewRef,
  action: { kind: 'preview' } | { kind: 'open'; app: string },
  use: (id: string) => Promise<T>,
): Promise<T> {
  const current = async () => {
    await authority.refreshGeneration()
    if (authority.currentGeneration() !== authority.generation)
      throw new Error('stale-generation')
  }
  await current()
  const known = await authority.known(ref)
  await current()
  if (!known) throw new Error('forbidden')
  if (
    action.kind === 'open' &&
    action.app !== 'default' &&
    !authority.apps.includes(action.app)
  )
    throw new Error('forbidden')
  const path = ref.out ? ref.p : `${authority.root}/${ref.p}`
  const held = await relay.prepareFile(authority.root, path)
  try {
    await current()
    if (!ref.out && !held.inside) throw new Error('forbidden')
    if (!(await relay.verifyFile(held.id))) throw new Error('forbidden')
    await current()
    const value = await use(held.id)
    if (action.kind === 'preview') await current()
    return value
  } finally {
    await relay.releaseFile(held.id).catch(() => {})
  }
}
