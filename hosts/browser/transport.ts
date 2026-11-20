import type {
  CommandRefusal,
  CommandReplies,
  HostCommand,
  ServerEvent,
} from '../../types/browser'

export type DashboardTransport = {
  listen(sink: {
    ready(): void
    event(value: ServerEvent): void
    closed(reason: 'ended' | 'revoked' | 'disconnected'): void
  }): () => void
  execute<C extends HostCommand>(request: {
    v: 1
    generation: number
    command: C
  }): Promise<CommandReplies[C['kind']] | CommandRefusal>
}

export type PageBootstrap = {
  handoff?: { generation: number; p: string }
}
