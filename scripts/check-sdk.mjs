import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const pinned = manifest.devDependencies?.['@anthropic-ai/claude-code']
const declaration = readFileSync(
  '.claude-plugin/sdk/claude-code/index.d.ts',
  'utf8',
)
const generated = /^\/\/ Written by Claude Code ([^\s]+)\./.exec(
  declaration,
)?.[1]

if (typeof pinned !== 'string' || pinned !== generated) {
  console.error(
    `SDK version mismatch: package.json pins ${pinned ?? 'nothing'}, generated declarations say ${generated ?? 'nothing'}`,
  )
  process.exit(1)
}
