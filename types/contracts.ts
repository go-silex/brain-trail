import type * as Domain from './model'
import type * as Claude from './index'
import type { PluginState, ShapedValue } from 'claude-code'

type NativeState = PluginState['brain-trail-v2']

// Claude requires a self-contained state contract. Reject schema drift without
// importing that host contract into the portable model or generating runtime code.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
    ? true
    : false
  : false
type Expect<T extends true> = T

export type StateContractInvariants = [
  Expect<Equal<Domain.TrailEvent, Claude.TrailEvent>>,
  Expect<Equal<Domain.Totals, Claude.Totals>>,
  Expect<Equal<Domain.Tab, Claude.Tab>>,
  Expect<Equal<Domain.TrailSettings, Claude.TrailSettings>>,
  Expect<Equal<Domain.Lang, Claude.Lang>>,
  Expect<Equal<Domain.Handoff, Claude.Handoff>>,
  Expect<Equal<Domain.Meter, Claude.Meter>>,
  Expect<Equal<Domain.Camera, ShapedValue<NativeState['camera']>>>,
  Expect<Equal<Domain.Play, ShapedValue<NativeState['play']>>>,
  Expect<Equal<Domain.PreviewRef | null, ShapedValue<NativeState['preview']>>>,
  Expect<Equal<Domain.Coach, ShapedValue<NativeState['coach']>>>,
]
