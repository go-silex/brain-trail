import { spawnSync } from 'node:child_process'
import { isAbsolute } from 'node:path'

const executable = process.env.RELAY_CROSS_ACCOUNT_BINARY
if (
  process.env.GITHUB_ACTIONS !== 'true' ||
  process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
  !process.env.RUNNER_TEMP ||
  !executable ||
  !isAbsolute(executable)
)
  process.exit(1)
const args = process.argv.slice(2)
const mode =
  args[0] === '--owner' || args[0] === '--closed' ? args[0] : '--hosted'
if (
  (mode === '--hosted' ? args.length !== 2 : args.length !== 3) ||
  !args.slice(mode === '--hosted' ? 0 : 1).every(isAbsolute)
)
  process.exit(1)
if (!['linux', 'win32', 'darwin'].includes(process.platform)) process.exit(1)
let command = executable
let commandArgs = [mode, ...args.slice(mode === '--hosted' ? 0 : 1)]
if (mode === '--hosted' && process.platform !== 'win32') {
  command = 'sudo'
  commandArgs = [
    '-n',
    '--',
    'env',
    'GITHUB_ACTIONS=true',
    'RUNNER_ENVIRONMENT=github-hosted',
    `RUNNER_TEMP=${process.env.RUNNER_TEMP}`,
    executable,
    ...commandArgs,
  ]
}
const result = spawnSync(command, commandArgs, {
  timeout: 60000,
  encoding: 'utf8',
  windowsHide: true,
})
if (result.status !== 0) {
  console.error(
    `cross-account ${mode} failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`,
  )
  process.exit(1)
}
