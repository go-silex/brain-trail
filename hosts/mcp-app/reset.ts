import type { AppAuth, Reply, ResetView, UiIdentity } from '../../types/apps'
import type { ToolCall } from './transport'
import { detached, nil, resetView } from './wire'

export async function resetMountedView(
  call: ToolCall,
  identity: UiIdentity,
  previous: AppAuth | undefined,
  retired: () => void,
  current: () => boolean,
): Promise<Reply<ResetView> | undefined> {
  if (previous !== undefined) {
    const result = await call('brain_trail_detach', previous, detached)
    if (!current()) return undefined
    if (
      !result.ok &&
      result.error !== 'forbidden' &&
      result.error !== 'stale-generation'
    )
      return result
    if (result.ok) {
      const unmounted = await call('brain_trail_unmount', previous, nil)
      if (!current()) return undefined
      if (
        !unmounted.ok &&
        unmounted.error !== 'forbidden' &&
        unmounted.error !== 'stale-generation'
      )
        return unmounted
    }
  }
  retired()
  return call('brain_trail_reset', identity, resetView)
}
