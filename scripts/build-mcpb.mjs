import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (process.argv.length !== 2)
  throw new Error('Usage: node scripts/build-mcpb.mjs')
const version = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
).version
const assets = join(root, 'hosts/browser/dist')
const html = readFileSync(join(assets, 'mcp-app.html'))
const metadataBytes = readFileSync(join(assets, 'mcp-app-manifest.json'))
const metadata = JSON.parse(metadataBytes)
const digest = createHash('sha256').update(html).digest('hex')
if (
  metadata.v !== 1 ||
  metadata.wireRevision !== 1 ||
  metadata.assetDigest !== digest ||
  !/^[a-f0-9]{64}$/.test(metadata.uiBuildId)
)
  throw new Error('MCP App manifest does not match the HTML')

// ZIP stored entries with fixed DOS epoch, ordered paths and Unix file modes.
// No compressor, filesystem timestamps or host-specific archive tooling is involved.
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
function archive(files) {
  const local = []
  const central = []
  let offset = 0
  for (const [name, data, mode] of files) {
    const path = Buffer.from(name)
    const crc = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x21, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(path.length, 26)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(0x0314, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x21, 14)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(data.length, 20)
    record.writeUInt32LE(data.length, 24)
    record.writeUInt16LE(path.length, 28)
    record.writeUInt32LE((mode * 0x10000) >>> 0, 38)
    record.writeUInt32LE(offset, 42)
    local.push(header, path, data)
    central.push(record, path)
    offset += header.length + path.length + data.length
  }
  const centralSize = central.reduce((n, part) => n + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

const output = join(root, '.artifacts/mcpb')
mkdirSync(output, { recursive: true })
for (const os of ['linux', 'darwin', 'windows']) {
  for (const arch of ['amd64', 'arm64']) {
    const executable = `brain-trail-relay-${os}-${arch}${os === 'windows' ? '.exe' : ''}`
    const entry = `server/${executable}`
    const manifest = {
      manifest_version: '0.3',
      name: 'brain-trail',
      version,
      description: 'View a paired native Brain Trail session.',
      author: { name: 'Unkillable Companies' },
      server: {
        type: 'binary',
        entry_point: entry,
        mcp_config: {
          command: `\${__dirname}/${entry}`,
          args: ['mcp', `\${__dirname}/assets`],
        },
      },
      compatibility: { platforms: [os === 'windows' ? 'win32' : os] },
      license: 'MIT',
    }
    const files = [
      ['LICENSE', readFileSync(join(root, 'LICENSE')), 0o100644],
      ['assets/mcp-app-manifest.json', metadataBytes, 0o100644],
      ['assets/mcp-app.html', html, 0o100644],
      [
        'manifest.json',
        Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
        0o100644,
      ],
      [
        'server/LICENSE-Go',
        readFileSync(join(root, 'hosts/relay/bin/LICENSE-Go')),
        0o100644,
      ],
      ...[
        'LICENSE-jsonschema-go',
        'LICENSE-mcp-go-sdk',
        'LICENSE-segmentio-asm',
        'LICENSE-segmentio-encoding',
        'LICENSE-uritemplate',
        'LICENSE-x-oauth2',
        'LICENSE-x-sync',
        'LICENSE-x-time',
      ].map((name) => [
        `server/${name}`,
        readFileSync(join(root, 'hosts/relay/bin', name)),
        0o100644,
      ]),
      [
        'server/LICENSE-x-sys',
        readFileSync(join(root, 'hosts/relay/bin/LICENSE-x-sys')),
        0o100644,
      ],
      [
        entry,
        readFileSync(join(root, 'hosts/relay/bin', executable)),
        0o100755,
      ],
    ]
    writeFileSync(
      join(output, `brain-trail-${version}-${os}-${arch}.mcpb`),
      archive(files),
    )
  }
}
