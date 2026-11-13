import type { EngineInterface } from 'claude-code'
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

/** Resolve a session-owned reference, hold it across consent and the effect, then release it. */
export async function withNativeFile<T>(
  $: EngineInterface,
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
    if (action.kind === 'open' || !held.inside) {
      if ((await $.session.surfaces()).length === 0)
        throw new Error('forbidden')
      await current()
      const question =
        action.kind === 'open'
          ? `Open ${held.path} with ${action.app === 'default' ? 'the default application' : action.app}?`
          : `Preview file outside the workspace: ${held.path}?`
      const answer = await $.ui.ask(question, ['Allow', 'Deny']).catch(() => '')
      await current()
      if (answer !== 'Allow') throw new Error('forbidden')
    }
    if (!(await relay.verifyFile(held.id))) throw new Error('forbidden')
    await current()
    const value = await use(held.id)
    if (action.kind === 'preview') await current()
    return value
  } finally {
    await relay.releaseFile(held.id).catch(() => {})
  }
}
