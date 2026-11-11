// MCP servers: which are outside services, and what to call them.

// Local tools of the app (browser pane, session, widgets, terminal...): not a call to an outside service.
const LOCAL = ['ccd_', 'visualize', 'terminal', 'Claude_', 'computer-use', 'Control_Chrome', 'claude-in-chrome', 'plugin-authoring', 'mcp-registry', 'scheduled-tasks']
export const isLocal = (server: string) => LOCAL.some(p => server.startsWith(p))
export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(s)
export const splitMcp = (name: string) => { const [server = '', tool = ''] = name.slice(5).split('__'); return { server, tool } }

// Servers added by hand keep the name they were given; a few common ones get their product name.
const NAMED: Record<string, string> = {
  'google-mail': 'Gmail', gmail: 'Gmail', github: 'GitHub', gbrain: 'GBrain', 'google-drive': 'Google Drive',
  'google-calendar': 'Google Calendar', hubspot: 'HubSpot', clickup: 'ClickUp', posthog: 'PostHog',
}

const has = (t: Set<string>, names: string[]) => names.some(n => t.has(n))
const prefix = (t: Set<string>, p: string) => [...t].some(x => x.startsWith(p))
// Connectors added through claude.ai have a UUID for a name: they are told apart by the tools they expose.
// The most specific come first: Akiflow and Luma also have calendar tools, Plume and Drive file tools.
const SIGNATURES: [string, (t: Set<string>) => boolean][] = [
  ['Claude Docs', t => t.has('batch') && t.has('guide')],
  ['Slack', t => prefix(t, 'slack_')],
  ['Notion', t => prefix(t, 'notion-')],
  ['Akiflow', t => has(t, ['get_schedule', 'create_time_slot', 'edit_time_slot', 'get_user_context'])],
  ['Luma', t => has(t, ['create_blast', 'invite_guests', 'list_calendar_contacts', 'add_host', 'get_guest'])],
  ['Claap', t => has(t, ['get_recording', 'get_recording_transcript', 'get_recordings', 'list_recording_views'])],
  ['Qonto', t => has(t, ['create_client_invoice', 'list_transactions', 'get_authenticated_membership', 'list_bank_accounts'])],
  ['Tally', t => has(t, ['create_new_form', 'load_form', 'fetch_submissions'])],
  ['Tella', t => has(t, ['export_video', 'get_timeline', 'add_text_overlay', 'list_clips'])],
  ['Plume', t => has(t, ['sign_workflow', 'download_signed_pdf', 'place_blocks', 'send_document'])],
  ['Supabase', t => has(t, ['execute_sql', 'apply_migration'])],
  ['Stripe', t => [...t].some(x => x.includes('stripe'))],
  ['GitHub', t => has(t, ['create_repository', 'list_commits', 'merge_pull_request', 'search_repositories'])],
  ['Linear', t => has(t, ['list_issues', 'create_issue', 'get_issue', 'list_teams']) && !t.has('list_bank_accounts')],
  ['Attio', t => has(t, ['search-records', 'list-records', 'create-note', 'get-records-by-ids', 'list-records-in-list', 'upsert-record'])],
  ['Google Sheets', t => has(t, ['get_spreadsheet', 'get_values', 'update_values'])],
  ['Google Drive', t => has(t, ['read_file_content', 'search_files', 'get_file_metadata', 'list_recent_files'])],
  ['Google Calendar', t => has(t, ['list_calendars', 'list_events', 'search_events', 'suggest_time'])],
  ['Gmail', t => has(t, ['search_threads', 'create_draft', 'get_thread', 'list_drafts'])],
]

const pretty = (s: string) => {
  const words = s.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// A server's display name, from its own name or, for a UUID, from the tools it exposes.
export const nameServer = (server: string, tools: Set<string>) =>
  NAMED[server.toLowerCase()]
  ?? (isUuid(server) ? SIGNATURES.find(([, match]) => match(tools))?.[0] ?? `Connector ${server.slice(0, 4)}` : pretty(server))

// Every server's tools, from the tool names the context lists (connected) and the calls the session made.
export const toolsByServer = (names: Iterable<string>) => {
  const out = new Map<string, Set<string>>()
  for (const n of names) {
    if (!n.startsWith('mcp__')) continue
    const { server, tool } = splitMcp(n)
    out.set(server, new Set([...(out.get(server) ?? []), tool]))
  }
  return out
}

const COLORS: Record<string, string> = {
  Claap: '#db2777', Gmail: '#dc2626', Attio: '#0891b2', Slack: '#16a34a', Qonto: '#a16207', 'Claude Docs': '#ea580c',
  'Google Sheets': '#059669', Notion: '#a8a29e', 'Google Drive': '#65a30d', Luma: '#c026d3', 'Google Calendar': '#0284c7',
  Stripe: '#6366f1', Akiflow: '#0e7490', Plume: '#0d9488', Tally: '#e11d8f', GitHub: '#a8a29e', Supabase: '#10b981',
  Tella: '#f472b6', Readwise: '#ca8a04', Linear: '#5e6ad2',
}
export const svcColor = (s: string) => {
  const known = COLORS[s]
  if (known !== undefined) return known
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360
  return `hsl(${h} 55% 55%)`
}
