import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { join } from 'node:path'

const scratch = process.env.BRAIN_TRAIL_TEST_DIR
if (!scratch) throw new Error('Missing isolated fixture directory')
const server = new McpServer({
  name: 'brain-trail-connector-fixture',
  version: '1.0.0',
})
server.registerTool(
  'list_bank_accounts',
  {
    description: 'Return a fixture connector result.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => ({
    content: [
      {
        type: 'text',
        text: `Fixture connector result mentions ${join(scratch, 'outside-canary.txt')}`,
      },
    ],
  }),
)
await server.connect(new StdioServerTransport())
