import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

const root = await mkdtemp(join(tmpdir(), 'brain-trail-omp-test-'))
try {
  const agentDir = join(root, 'agent')
  await mkdir(agentDir)
  const foreign = join(root, 'foreign')
  const workspace = join(root, 'workspace')
  await mkdir(foreign)
  await mkdir(workspace)
  await writeFile(join(foreign, 'foreign-canary.txt'), 'foreign repository')
  const fixtureEnv = {
    PATH: process.env.PATH,
    HOME: root,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  }
  execFileSync('git', ['init', '-q', foreign], { env: fixtureEnv })
  execFileSync('git', ['-C', foreign, 'add', 'foreign-canary.txt'], {
    env: fixtureEnv,
  })
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    BRAIN_TRAIL_TEST_DIR: root,
    GIT_DIR: join(foreign, '.git'),
    GIT_COMMON_DIR: join(foreign, '.git'),
    GIT_WORK_TREE: workspace,
    GIT_INDEX_FILE: join(foreign, '.git', 'index'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.worktree',
    GIT_CONFIG_VALUE_0: foreign,
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
