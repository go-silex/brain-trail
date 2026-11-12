import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const root = await mkdtemp(join(tmpdir(), 'brain-trail-omp-test-'))
try {
  const agentDir = join(root, 'agent')
  await mkdir(agentDir)
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    BRAIN_TRAIL_TEST_DIR: root,
  }
  delete env.OMP_PROFILE
  delete env.PI_PROFILE
  const child = spawn('bun', ['run', 'scripts/omp-journey.ts'], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    timeout: 60000,
    killSignal: 'SIGKILL',
  })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (status, signal) => resolve(status ?? (signal ? 1 : 0)))
  })
  process.exitCode = code
} finally {
  await rm(root, { recursive: true, force: true })
}
