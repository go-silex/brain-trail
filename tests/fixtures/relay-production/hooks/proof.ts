import type { Register } from 'claude-code'
import { relayBinary, relayIO } from '../../../../hosts/native/io'
import { startRelay } from '../../../../hosts/relay/client'
import type { DashboardFeed } from '../../../../types/browser'

export const register: Register = (on) => {
  let passed = false
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'relay-production-proof',
      description: 'Exercise the production relay',
    })
    return result
  })
  on('command.run', { command: 'relay-production-proof' }, async ($) => {
    const cwd = await $.session.cwd()
    let launch = ''
    let socket = ''
    let resolveDone = () => {}
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const binary = await relayBinary($)
    const port = relayIO(
      $,
      (generation) => generation === feed.current().generation,
    )
    const start = port.start
    port.start = (exe, args, input, onChunk, onExit) =>
      start(
        exe,
        args,
        input,
        (chunk) => {
          // Split every SDK stdout chunk so production framing sees fragmented NDJSON.
          for (const char of chunk) onChunk(char)
        },
        onExit,
      )
    const request = port.request
    port.request = (path, token, route, body) => {
      socket = path
      return request(path, token, route, body)
    }
    const feed = {
      current: () => ({
        generation: 2,
        revision: 1,
        layout: undefined,
        facts: {},
        shared: {},
      }),
      subscribe: () => () => {},
      execute: async (
        generation: number,
        command: { kind: string; patch?: { openMd?: string } },
      ) => {
        if (generation !== 2) {
          $.clock.after(1000, resolveDone)
          return { ok: false, error: 'stale' }
        }
        if (command.kind !== 'settings' || command.patch?.openMd !== 'é😀')
          return { ok: false, error: 'invalid' }
        await $.store.set('relay-production-value', command.patch.openMd)
        const value = await $.store.get('relay-production-value')
        return { ok: value === 'é😀', value }
      },
    } as unknown as DashboardFeed
    let timer: { cancel(): void } | undefined
    try {
      const client = await startRelay(
        port,
        binary,
        `${$.plugin.root}/hosts/browser/dist`,
        feed,
      )
      launch = await client.prepareBrowser()
      await $.fs.write(
        `${cwd}/relay-production.json`,
        JSON.stringify({ phase: 'ready', launch, socket, binary }),
      )
      await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timer = $.clock.after(120000, () =>
            reject(new Error('command timeout')),
          )
        }),
      ])
      passed = (await $.store.get('relay-production-value')) === 'é😀'
      await $.fs.write(
        `${cwd}/relay-production.json`,
        JSON.stringify({
          phase: passed ? 'passed' : 'failed',
          launch,
          socket,
          binary,
        }),
      )
      // Keep the real stream alive until the SDK tears down the session.
      return { text: passed ? 'passed' : 'failed' }
    } catch (error) {
      await $.fs.write(
        `${cwd}/relay-production.json`,
        JSON.stringify({
          phase: 'failed',
          error: String(error),
          launch,
          socket,
        }),
      )
      return { text: 'failed' }
    } finally {
      timer?.cancel()
    }
  })
  on('session.end', async ($, e, next) => {
    const cwd = await $.session.cwd()
    await $.fs.write(
      `${cwd}/relay-production-end.json`,
      JSON.stringify({
        passed,
        value: await $.store.get('relay-production-value'),
      }),
    )
    return next(e)
  })
}
