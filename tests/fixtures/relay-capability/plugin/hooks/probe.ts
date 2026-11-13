// Disposable real-SDK capability evidence, not a product bridge.
import type { Register } from 'claude-code'
import {
  gitInventoryArgv,
  nativeGitInventoryArgv,
  pickFiles,
} from '../../../../../hooks/workspace'

export const register: Register = (on) => {
  let roundtripPassed = false
  let active = false
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'relay-capability',
      description: 'Run the disposable native relay capability probe',
    })
    // Optional driver mode: schedule only after session.start has returned.
    const auto = await $.fs
      .read(`${$.plugin.root}/auto-run.txt`)
      .catch(() => '')
    if (auto.trim() === 'auto') {
      $.clock.after(250, () => {
        void $.command
          .run({ command: 'relay-capability' })
          .catch(async (error) => {
            const cwd = await $.session.cwd()
            await $.fs
              .write(
                `${cwd}/probe-report.json`,
                JSON.stringify({
                  phase: 'failed',
                  error: String(error).slice(0, 500),
                }),
              )
              .catch(() => {})
          })
      })
    }
    return result
  })

  on('command.run', { command: 'relay-capability' }, async ($) => {
    if (active)
      return {
        text: JSON.stringify({
          phase: 'failed',
          error: 'probe already started',
        }),
      }
    active = true
    const cwd = await $.session.cwd()
    let socketPath = ''
    let pid = 0
    let gitEncoding: unknown
    let privacy:
      | {
          kind: string
          directory: {
            ownerSelf: boolean
            protected: boolean
            allowedEntries: number
            unexpectedEntries: number
          }
          socket: {
            ownerSelf: boolean
            allowedEntries: number
            unexpectedEntries: number
          }
        }
      | undefined
    const acknowledgements: Array<{
      id: string
      status: string
      value: unknown
    }> = []
    let resolveCompletion: () => void = () => {}
    let rejectCompletion: (error: unknown) => void = () => {}
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve
      rejectCompletion = reject
    })
    let timer: { cancel: () => void } | undefined
    try {
      const windows =
        (await $.env.get('OS').catch(() => undefined)) === 'Windows_NT'
      if (windows) {
        const gitCwd = `${cwd}/git-unicode`
        const gitLs = gitInventoryArgv(true)
        const localVars = await $.process.run(
          ['git', 'rev-parse', '--local-env-vars'],
          { cwd: gitCwd, timeoutMs: 20000 },
        )
        const names =
          localVars.exitCode === 0 ? localVars.stdout.trim().split(/\r?\n/) : []
        if (
          !names.length ||
          !names.every((name) => /^GIT_[A-Z0-9_]+$/.test(name))
        )
          throw new Error('Git local environment discovery failed')
        const metadata = await $.process.run(
          [
            'powershell.exe',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '[PSCustomObject]@{version=$PSVersionTable.PSVersion.ToString(); outputCodePage=[Console]::OutputEncoding.CodePage; inputCodePage=[Console]::InputEncoding.CodePage; outputEncoding=$OutputEncoding.WebName} | ConvertTo-Json -Compress',
          ],
          { cwd: gitCwd, timeoutMs: 20000 },
        )
        const direct = await $.process.run(gitLs, {
          cwd: gitCwd,
          timeoutMs: 20000,
        })
        const wrappedArgv = nativeGitInventoryArgv(true, names)
        const wrapped = await $.process.run(wrappedArgv, {
          cwd: gitCwd,
          timeoutMs: 20000,
        })
        // This explores explicit transcription, not policy-enforced transcription.
        const transcriptPath = `${$.plugin.root}/git-transcript.txt`.replace(
          /'/g,
          "''",
        )
        const transcriptArgv = [...wrappedArgv]
        transcriptArgv[4] = `try { Start-Transcript -Path '${transcriptPath}' -ErrorAction Stop | Out-Null } catch { exit 97 }; ${wrappedArgv[4]}`
        const transcribed = await $.process.run(transcriptArgv, {
          cwd: gitCwd,
          timeoutMs: 20000,
        })
        let transcribedProductPaths: string[] | undefined
        try {
          transcribedProductPaths = pickFiles(transcribed.stdout, false, gitCwd)
        } catch {}
        gitEncoding = {
          metadata: metadata.stdout.trim(),
          metadataExit: metadata.exitCode,
          directExit: direct.exitCode,
          wrappedExit: wrapped.exitCode,
          directStdout: direct.stdout,
          wrappedStdout: wrapped.stdout,
          transcribedExit: transcribed.exitCode,
          transcribedStdout: transcribed.stdout,
          transcribedStderr: transcribed.stderr,
          transcribedTruncated: transcribed.isStdoutTruncated,
          transcribedProductPaths,
          transcribedMatchesDirect: transcribed.stdout === direct.stdout,
          transcription:
            'explicit Start-Transcript; not policy-enforced transcription',
          directTruncated: direct.isStdoutTruncated,
          wrappedTruncated: wrapped.isStdoutTruncated,
        }
        const expected = JSON.stringify(['ascii.txt', 'café-漢-😀.txt'].sort())
        if (
          metadata.exitCode !== 0 ||
          !/"version"\s*:\s*"5\.1\./.test(metadata.stdout) ||
          !/"outputCodePage"\s*:\s*\d+/.test(metadata.stdout) ||
          direct.exitCode !== 0 ||
          wrapped.exitCode !== 0 ||
          direct.isStdoutTruncated ||
          wrapped.isStdoutTruncated ||
          direct.stdout !== wrapped.stdout ||
          JSON.stringify(pickFiles(direct.stdout, false, gitCwd)) !==
            expected ||
          JSON.stringify(pickFiles(wrapped.stdout, false, gitCwd)) !== expected
        )
          throw new Error('Windows PowerShell Git Unicode discriminator failed')
      }
      const binary = (
        await $.fs.read(`${$.plugin.root}/relay-binary.txt`)
      ).trim()
      if (binary !== 'relay-capability' && binary !== 'relay-capability.exe')
        throw new Error('invalid binary selection')
      void (async () => {
        let buffer = ''
        try {
          const stream = $.process.spawn({
            argv: [`${$.plugin.root}/${binary}`],
          })
          for await (const chunk of stream) {
            if (chunk.stream !== 'stdout') continue
            buffer += chunk.text
            if (buffer.length > 8192) throw new Error('frame buffer exceeded')
            for (;;) {
              if (buffer.length < 5) break
              if (!/^\d{4}:/.test(buffer))
                throw new Error('invalid frame header')
              const size = Number(buffer.slice(0, 4))
              if (size < 1 || size > 4096)
                throw new Error('invalid frame length')
              if (buffer.length < 5 + size) break
              const frame = JSON.parse(buffer.slice(5, 5 + size))
              buffer = buffer.slice(5 + size)
              if (frame.type === 'hello') {
                if (
                  socketPath ||
                  typeof frame.socketPath !== 'string' ||
                  !frame.socketPath.includes('é😀') ||
                  !/^[1-9]\d*$/.test(frame.pid)
                )
                  throw new Error('invalid hello')
                socketPath = frame.socketPath
                pid = Number(frame.pid)
                if (frame.privacyError)
                  throw new Error(
                    `privacy inspection: ${String(frame.privacyError).slice(0, 400)}`,
                  )
                if (frame.privacy) privacy = JSON.parse(frame.privacy)
                if (
                  binary.endsWith('.exe') &&
                  (privacy?.kind !== 'windows' ||
                    privacy.directory?.ownerSelf !== true ||
                    privacy.directory?.protected !== true ||
                    privacy.directory?.allowedEntries !== 2 ||
                    privacy.directory?.unexpectedEntries !== 0 ||
                    privacy.socket?.ownerSelf !== true ||
                    privacy.socket?.allowedEntries !== 2 ||
                    privacy.socket?.unexpectedEntries !== 0)
                )
                  throw new Error(
                    `privacy mismatch: ${JSON.stringify(privacy)}`,
                  )
                // Preserve cleanup coordinates even if the subsequent transport fails.
                await $.fs.write(
                  `${cwd}/probe-report.json`,
                  JSON.stringify({
                    phase: 'running',
                    pid,
                    socketPath,
                    privacy,
                    acknowledgements,
                  }),
                )
                continue
              }
              if (
                !socketPath ||
                frame.type !== 'command' ||
                (frame.id !== 'valid' && frame.id !== 'stale')
              )
                throw new Error('invalid command')
              let status = 'refused-generation'
              let value = await $.store.get('relay-capability-value')
              if (
                frame.id === 'valid' &&
                frame.generation === 'probe-generation-1' &&
                frame.value === 'é😀'
              ) {
                await $.store.set('relay-capability-value', frame.value)
                value = await $.store.get('relay-capability-value')
                status = value === 'é😀' ? 'saved' : 'readback-mismatch'
              }
              const ack = { id: frame.id, status, value }
              const response = await $.http.fetch('http://localhost/ack', {
                method: 'POST',
                socketPath,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(ack),
              })
              if (!response.ok) throw new Error(`ack HTTP ${response.status}`)
              acknowledgements.push(ack)
              if (frame.id === 'stale') {
                if (
                  acknowledgements.length !== 2 ||
                  acknowledgements[0]?.id !== 'valid' ||
                  status !== 'refused-generation' ||
                  value !== 'é😀'
                )
                  throw new Error('invalid stale result')
                resolveCompletion()
              }
            }
          }
          if (!roundtripPassed)
            rejectCompletion(new Error('relay stream ended before completion'))
        } catch (error) {
          rejectCompletion(error)
        }
      })()
      await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          timer = $.clock.after(30000, () =>
            reject(new Error('probe timed out')),
          )
        }),
      ])
      roundtripPassed = true
      const report = {
        phase: 'passed-awaiting-session-end',
        pid,
        socketPath,
        privacy,
        acknowledgements,
        gitEncoding,
      }
      await $.fs.write(`${cwd}/probe-report.json`, JSON.stringify(report))
      return { text: JSON.stringify(report) }
    } catch (error) {
      const report = {
        phase: 'failed',
        pid,
        socketPath,
        privacy,
        acknowledgements,
        gitEncoding,
        error: String(error).slice(0, 500),
      }
      await $.fs
        .write(`${cwd}/probe-report.json`, JSON.stringify(report))
        .catch(() => {})
      return { text: JSON.stringify(report) }
    } finally {
      timer?.cancel()
    }
  })

  on('session.end', async ($, e, next) => {
    const cwd = await $.session.cwd()
    const value = await $.store.get('relay-capability-value')
    await $.fs.write(
      `${cwd}/probe-end.json`,
      JSON.stringify({ phase: 'session-end', value, roundtripPassed }),
    )
    return next(e)
  })
}
