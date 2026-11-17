import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Page } from 'playwright'
import type {
  Bootstrap,
  AppAuth,
  Pulled,
  Reply,
  Mounted,
  Attached,
  ChatEnvelope,
} from '../types/apps'
import type { HostCommand } from '../types/browser'

export type McpJourney = { stale(): Promise<void>; close(): Promise<void> }

// Exercise the packaged MCP binary through its public stdio protocol, independently
// of the browser's SSE connection. Never include private replies in diagnostics.
export async function startMcpJourney(
  page: Page,
  generation: number,
  serverName: string,
): Promise<McpJourney> {
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  const binary = join(
    import.meta.dir,
    '..',
    'hosts',
    'relay',
    'bin',
    `brain-trail-relay-${platform}-${arch}${process.platform === 'win32' ? '.exe' : ''}`,
  )
  const assets = join(import.meta.dir, '..', 'hosts', 'browser', 'dist')
  const transport = new StdioClientTransport({
    command: binary,
    args: ['mcp', assets],
    stderr: 'ignore',
  })
  const client = new Client({ name: 'brain-trail-journey', version: '1' })
  try {
    await client.connect(transport)
    const call = async <T>(name: string, args: object): Promise<Reply<T>> => {
      const result = await client.callTool({
        name,
        arguments: args as Record<string, unknown>,
      })
      const reply = result._meta?.brainTrail as Reply<T> | undefined
      if (!reply || reply.v !== 1 || typeof reply.ok !== 'boolean')
        throw new Error(`Invalid private MCP response: ${name}`)
      return reply
    }
    const success = async <T>(name: string, args: object): Promise<T> => {
      const reply = await call<T>(name, args)
      if (!reply.ok) throw new Error(`MCP ${name} refused: ${reply.error}`)
      return reply.value
    }
    const deny = async (name: string, args: object) => {
      const reply = await call<unknown>(name, args)
      assert.equal(reply.ok, false, `${name} must refuse`)
    }
    const opened = await client.callTool({
      name: 'open_brain_trail',
      arguments: {},
    })
    const bootstrap = opened._meta?.brainTrail as Bootstrap | undefined
    if (!bootstrap || bootstrap.v !== 1 || bootstrap.wireRevision !== 1)
      throw new Error('Missing MCP bootstrap')
    const mounted = await success<Mounted>('brain_trail_mount', bootstrap)
    let auth: AppAuth = {
      v: 1,
      serverEpoch: bootstrap.serverEpoch,
      viewKey: bootstrap.viewKey,
      mountKey: mounted.mountKey,
    }
    const issue = async (): Promise<ChatEnvelope> => {
      await page.getByRole('button', { name: 'Pair with Chat' }).click()
      const field = page.getByRole('textbox', { name: 'Chat pairing envelope' })
      await field.waitFor({ state: 'visible' })
      const envelope = JSON.parse(await field.inputValue()) as ChatEnvelope
      await page.getByRole('button', { name: 'Dismiss' }).click()
      return envelope
    }
    const pair = async () => {
      const attached = await success<Attached>('brain_trail_pair', {
        ...auth,
        envelope: await issue(),
      })
      assert.equal(attached.kind, 'attached')
      assert.equal(attached.generation, generation)
      assert.equal(attached.source.owner.host, 'omp')
    }
    const pull = () =>
      success<Pulled>('brain_trail_pull', { ...auth, cursor: null })
    const command = (command: HostCommand) =>
      success<{ ok: true }>('brain_trail_command', {
        ...auth,
        request: { v: 1, generation, command },
      })
    await pair()
    const initial = await pull()
    assert.equal(initial.state.kind, 'attached')
    const layout = initial.events.find((event) => event.kind === 'layout')
    const snapshot = initial.events.find((event) => event.kind === 'snapshot')
    assert.ok(
      layout?.kind === 'layout' &&
        layout.layout.paths.includes('root.txt') &&
        layout.layout.paths.includes('child.txt'),
      'MCP pull must return native layout',
    )
    assert.ok(
      snapshot?.kind === 'snapshot' &&
        snapshot.facts.events.some(
          (event) => event.k === 'read' && event.p === 'root.txt',
        ) &&
        snapshot.facts.events.some(
          (event) =>
            event.k === 'mcp' &&
            event.server === serverName &&
            event.tool === 'list_bank_accounts',
        ),
      'MCP pull must return captured native history',
    )
    assert.deepEqual(
      await command({
        kind: 'view',
        intent: { kind: 'replay-play', steps: 10 },
      }),
      { ok: true },
    )
    const deadline = Date.now() + 5000
    let advanced = false
    while (Date.now() < deadline) {
      const delay = Promise.withResolvers<void>()
      setTimeout(delay.resolve, 200)
      await delay.promise
      const current = await pull()
      const event = current.events.find((item) => item.kind === 'snapshot')
      if (
        event?.kind === 'snapshot' &&
        event.shared.play.step !== null &&
        event.shared.play.step > 0
      ) {
        advanced = true
        break
      }
    }
    assert.ok(
      advanced,
      'native playback must advance after App command returns',
    )
    await success('brain_trail_detach', auth)
    const detached = await pull()
    assert.equal(detached.state.kind, 'detached')
    assert.equal(detached.events.length, 0)
    await deny('brain_trail_command', {
      ...auth,
      request: { v: 1, generation, command: { kind: 'refresh-meter' } },
    })
    const oldAuth = auth
    await success('brain_trail_unmount', auth)
    const remounted = await success<Mounted>('brain_trail_mount', bootstrap)
    auth = { ...auth, mountKey: remounted.mountKey }
    await deny('brain_trail_pull', { ...oldAuth, cursor: null })
    await deny('brain_trail_command', {
      ...oldAuth,
      request: { v: 1, generation, command: { kind: 'refresh-meter' } },
    })
    await pair()
    assert.equal((await pull()).state.kind, 'attached')
    assert.deepEqual(
      await command({
        kind: 'view',
        intent: { kind: 'replay-play', steps: 10 },
      }),
      { ok: true },
    )
    return {
      async stale() {
        try {
          const response = await call<Pulled>('brain_trail_pull', {
            ...auth,
            cursor: null,
          })
          if (response.ok) {
            assert.notEqual(
              response.value.state.kind,
              'attached',
              'old generation must not remain attached',
            )
            assert.equal(response.value.events.length, 0)
          }
          await deny('brain_trail_command', {
            ...auth,
            request: { v: 1, generation, command: { kind: 'refresh-meter' } },
          })
          await deny('brain_trail_pull', { ...oldAuth, cursor: null })
        } catch {
          throw new Error('MCP stale-generation journey failed')
        }
      },
      close: () => client.close(),
    }
  } catch {
    await client.close().catch(() => transport.close().catch(() => {}))
    throw new Error('Cross-process MCP journey failed')
  }
}
