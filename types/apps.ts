import type {
  CommandRequest,
  CommandRefusal,
  CommandReplies,
  HostCommand,
  ServerEvent,
} from './browser'

export type V = { v: 1 }
export type Token = string
export type Hex64 = string
export type Result<T> = { ok: true; value: T } | CommandRefusal
export type Reply<T> = V & Result<T>
export type CommandSuccess = CommandReplies[HostCommand['kind']]
export type CurrentEvent = Extract<ServerEvent, { kind: 'layout' | 'snapshot' }>
export type RelayAddress = { socket: string; relayId: Token }
export type Owner = { host: 'code' | 'omp'; sessionId: string }
export type Recipient = { serverEpoch: Token; openId: Token }
export type Manifest = V & {
  wireRevision: 1
  uiBuildId: Hex64
  assetDigest: Hex64
}
export type Bootstrap = Manifest & { serverEpoch: Token; viewKey: Token }
export type UiIdentity = V & { wireRevision: 1; uiBuildId: Hex64 }
export type ApprovalRef =
  | { kind: 'code'; openId: Token }
  | { kind: 'chat'; pairId: Token }
export type ApprovalSpec =
  | { kind: 'code'; openId: Token; method: 'S256'; challenge: Token }
  | { kind: 'chat'; pairId: Token }
export type ChatEnvelope = V & {
  kind: 'chat'
  relay: RelayAddress
  pairId: Token
  secret: Token
  expiresAt: number
}
export type Binding = {
  relayId: Token
  approval: ApprovalRef
  recipient: Recipient
  owner: Owner
  generation: number
  label: string
}
export type Lease = { epoch: number; id: Token }
export type Guard = {
  requestId: Token
  relayId: Token
  grantId: Token
  owner: Owner
  generation: number
  lease: Lease
}
export type Cursor = {
  generation: number
  revision: number
  layoutRev: number | null
}
export type RevokeReason =
  | 'cancelled'
  | 'timeout'
  | 'failed'
  | 'detached'
  | 'generation-ended'
  | 'session-ended'
  | 'disconnected'
export type HostApprove = V & {
  owner: Owner
  generation: number
  label: string
  approval: ApprovalSpec
}
export type Approved = {
  relay: RelayAddress
  approval: ApprovalRef
  expiresAt: number
  envelope: ChatEnvelope | null
}
export type ApprovalTarget = { kind: 'approval'; approval: ApprovalRef }
export type OperationTarget = { kind: 'operation'; scope: Guard }
export type HostCheck = V & { target: ApprovalTarget | OperationTarget }
export type Checked =
  | {
      kind: 'approval'
      state: 'missing' | 'pending' | 'claimed' | 'revoked' | 'expired'
      grantId: Token | null
      expiresAt: number | null
    }
  | { kind: 'operation' }
export type HostRevoke = V & {
  target:
    | ApprovalTarget
    | { kind: 'grant'; grantId: Token }
    | { kind: 'generation'; owner: Owner; generation: number }
  reason: RevokeReason
}
export type BrowserPairRequest = V & { generation: number }
export type BrowserPairFrame = V & {
  t: 'app-pair'
  requestId: Token
  generation: number
}
export type BrowserPairAuthority = {
  owner: Owner
  generation: number
  label: string
  pairId: Token
}
export type HostBrowserPairReply = V & {
  requestId: Token
  result: Result<BrowserPairAuthority>
}
export type Proof =
  | { kind: 'code'; openId: Token; method: 'S256'; verifier: Token }
  | { kind: 'chat'; pairId: Token; secret: Token }
export type Claim = V & { relayId: Token; recipient: Recipient; proof: Proof }
export type Claimed = { grantId: Token; grantKey: Token; binding: Binding }
export type LeaseRequest = V & { relayId: Token; lease: Lease; active: boolean }
export type RelayPull = V & {
  relayId: Token
  lease: Lease
  cursor: Cursor | null
}
export type RelayPullNext = V & {
  relayId: Token
  lease: Lease
  readId: Token
  part: 1
}
export type RelayCommand = V & {
  relayId: Token
  lease: Lease
  request: CommandRequest
}
export type Release = V & {
  relayId: Token
  reason: RevokeReason
  credential:
    | { kind: 'grant'; grantId: Token }
    | { kind: 'proof'; recipient: Recipient; proof: Proof }
}
export type CurrentPart = {
  readId: Token
  part: 0 | 1
  parts: 1 | 2
  cursor: Cursor
  events: [] | [CurrentEvent]
}
export type AppCurrent = V & {
  t: 'app-current'
  scope: Guard
  cursor: Cursor | null
}
export type AppCancelled = V & { t: 'app-cancel'; scope: Guard }
export type AppCommand = V & {
  t: 'app-cmd'
  scope: Guard
  request: CommandRequest
}
export type HostAppReply = V & {
  scope: Guard
  result: Result<
    | { kind: 'current'; chunk: CurrentPart }
    | { kind: 'command'; reply: CommandSuccess }
  >
}
export type CompleteOpen = V & { openId: Token; relay: RelayAddress }
export type Completed = { status: 'attached' }
export type AppMount = UiIdentity & {
  assetDigest: Hex64
  serverEpoch: Token
  viewKey: Token
}
export type AppReset = UiIdentity
export type ResetView = { bootstrap: Bootstrap; state: { kind: 'detached' } }
export type AppAuth = V & {
  serverEpoch: Token
  viewKey: Token
  mountKey: Token
}
export type Attached = {
  kind: 'attached'
  generation: number
  source: { owner: Owner; label: string }
}
export type ViewState = { kind: 'detached' } | { kind: 'pending' } | Attached
export type Mounted = { mountKey: Token; state: ViewState }
export type AppPull = AppAuth & { cursor: Cursor | null }
export type Pulled =
  | { state: Attached; cursor: Cursor; events: CurrentEvent[] }
  | {
      state: { kind: 'detached' } | { kind: 'pending' }
      cursor: null
      events: []
    }
export type AppCommandRequest = AppAuth & { request: CommandRequest }
export type AppPair = AppAuth & { envelope: ChatEnvelope }
export type AppDetach = AppAuth
export type AppUnmount = AppAuth

const operations: Record<string, true> = Object.fromEntries(
  [
    'open_brain_trail',
    'brain_trail_complete_native_open',
    'brain_trail_mount',
    'brain_trail_pair',
    'brain_trail_pull',
    'brain_trail_command',
    'brain_trail_detach',
    'brain_trail_unmount',
    'brain_trail_reset',
  ].map((name) => [name, true]),
)
const mcpName = (
  name: string,
): { server: string; operation: string } | undefined => {
  const match = /^mcp__(.+?)__([\s\S]+)$/.exec(name)
  if (!match) return undefined
  const [, server, operation] = match
  if (
    !server ||
    !operation ||
    server.includes('__') ||
    operation.includes('__')
  )
    return undefined
  return { server, operation }
}
export const isAdapterOperation = (name: string): boolean =>
  operations[name] === true ||
  operations[mcpName(name)?.operation ?? ''] === true
export const parseOpenerToolName = (name: string): string | undefined => {
  const parsed = mcpName(name)
  return parsed?.operation === 'open_brain_trail' ? parsed.server : undefined
}
export const isToken = (value: unknown): value is Token =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value)
export const parseOpenMarker = (
  text: string,
): { openId: Token; challenge: Token } | undefined => {
  const prefix = 'BRAIN_TRAIL_OPEN_V1:'
  const index = text.indexOf(prefix)
  if (index < 0 || text.indexOf(prefix, index + prefix.length) >= 0)
    return undefined
  const match =
    /^([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{43})(?![A-Za-z0-9_:-])/.exec(
      text.slice(index + prefix.length),
    )
  return match && isToken(match[1]) && isToken(match[2])
    ? { openId: match[1], challenge: match[2] }
    : undefined
}

const exact = (
  value: unknown,
  keys: string[],
): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0
export const parseChatEnvelope = (value: unknown): ChatEnvelope | undefined => {
  if (
    !exact(value, ['v', 'kind', 'relay', 'pairId', 'secret', 'expiresAt']) ||
    value.v !== 1 ||
    value.kind !== 'chat' ||
    !isToken(value.pairId) ||
    !isToken(value.secret) ||
    !positive(value.expiresAt) ||
    !exact(value.relay, ['socket', 'relayId']) ||
    typeof value.relay.socket !== 'string' ||
    !value.relay.socket ||
    !isToken(value.relay.relayId)
  )
    return undefined
  return value as unknown as ChatEnvelope
}

/** Parse JSON while rejecting duplicate keys at every object depth. */
export const parseStrictJSON = (text: string): unknown => {
  let i = 0
  const ws = () => {
    while (i < text.length && /[\x20\t\r\n]/.test(text.charAt(i))) i++
  }
  const string = (): string => {
    const start = i++
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2
        continue
      }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i)) as string
    }
    throw new SyntaxError('Invalid JSON')
  }
  const value = (): void => {
    ws()
    if (text[i] === '"') {
      string()
      return
    }
    if (text[i] === '{') {
      i++
      ws()
      const keys = new Set<string>()
      if (text[i] === '}') {
        i++
        return
      }
      for (;;) {
        ws()
        if (text[i] !== '"') throw new SyntaxError('Invalid JSON')
        const key = string()
        if (keys.has(key)) throw new SyntaxError('Duplicate JSON key')
        keys.add(key)
        ws()
        if (text[i++] !== ':') throw new SyntaxError('Invalid JSON')
        value()
        ws()
        const c = text[i++]
        if (c === '}') return
        if (c !== ',') throw new SyntaxError('Invalid JSON')
      }
    }
    if (text[i] === '[') {
      i++
      ws()
      if (text[i] === ']') {
        i++
        return
      }
      for (;;) {
        value()
        ws()
        const c = text[i++]
        if (c === ']') return
        if (c !== ',') throw new SyntaxError('Invalid JSON')
      }
    }
    const match =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        text.slice(i),
      )
    if (!match) throw new SyntaxError('Invalid JSON')
    i += match[0].length
  }
  value()
  ws()
  if (i !== text.length) throw new SyntaxError('Trailing JSON')
  return JSON.parse(text) as unknown
}

const nonnegative = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0
export const isOwner = (v: unknown): v is Owner =>
  exact(v, ['host', 'sessionId']) &&
  (v.host === 'code' || v.host === 'omp') &&
  typeof v.sessionId === 'string' &&
  !v.sessionId.includes('\0') &&
  new TextEncoder().encode(v.sessionId).length > 0 &&
  new TextEncoder().encode(v.sessionId).length <= 1024
export const isGuard = (v: unknown): v is Guard =>
  exact(v, [
    'requestId',
    'relayId',
    'grantId',
    'owner',
    'generation',
    'lease',
  ]) &&
  isToken(v.requestId) &&
  isToken(v.relayId) &&
  isToken(v.grantId) &&
  isOwner(v.owner) &&
  positive(v.generation) &&
  exact(v.lease, ['epoch', 'id']) &&
  positive(v.lease.epoch) &&
  isToken(v.lease.id)
export const isCursor = (v: unknown): v is Cursor =>
  exact(v, ['generation', 'revision', 'layoutRev']) &&
  positive(v.generation) &&
  nonnegative(v.revision) &&
  (v.layoutRev === null || nonnegative(v.layoutRev))
export const isLabel = (v: unknown): v is string =>
  typeof v === 'string' &&
  !/\p{Cc}/u.test(v) &&
  new TextEncoder().encode(v).length <= 512
export const isExactObject = exact
