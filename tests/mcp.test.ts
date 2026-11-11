import { expect, test } from 'claude-code/testing'

import { isLocal, nameServer, toolsByServer } from '../hooks/mcp'

// Tool sets of claude.ai connectors as a real session lists them (UUID server names).
const CONNECTORS: [string, string[]][] = [
  ['Claude Docs', ['batch', 'create', 'export', 'guide', 'query', 'read', 'update']],
  ['Slack', ['slack_read_channel', 'slack_send_message']],
  ['Notion', ['notion-fetch', 'notion-search']],
  ['Akiflow', ['create_event', 'get_event', 'list_calendars', 'get_schedule', 'create_time_slot']],
  ['Luma', ['create_event', 'get_event', 'list_events', 'list_calendars', 'create_blast', 'invite_guests']],
  ['Claap', ['get_recording', 'get_recording_transcript', 'list_folders']],
  ['Qonto', ['create_client_invoice', 'list_transactions', 'list_teams', 'list_bank_accounts']],
  ['Tally', ['create_new_form', 'load_form', 'fetch_submissions', 'list_workspaces']],
  ['Tella', ['export_video', 'get_timeline', 'list_clips']],
  ['Plume', ['sign_workflow', 'download_signed_pdf', 'place_blocks', 'search_contacts']],
  ['Supabase', ['execute_sql', 'apply_migration', 'list_organizations']],
  ['Stripe', ['get_stripe_account_info', 'stripe_api_read']],
  ['GitHub', ['create_repository', 'list_commits', 'get_me']],
  ['Attio', ['search-records', 'create-note', 'list-lists']],
  ['Google Sheets', ['get_spreadsheet', 'get_values', 'update_values']],
  ['Google Drive', ['read_file_content', 'search_files', 'create_file']],
  ['Google Calendar', ['create_event', 'get_event', 'list_calendars', 'list_events', 'suggest_time']],
  ['Gmail', ['create_draft', 'get_thread', 'search_threads', 'send_message']],
]

test('every claude.ai connector of this Mac gets its product name', async () => {
  CONNECTORS.forEach(([name, tools], i) => {
    expect(nameServer(`${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, new Set(tools))).toBe(name)
  })
})

test('a server added by hand keeps its name, made readable', async () => {
  expect(nameServer('google-mail', new Set())).toBe('Gmail')
  expect(nameServer('claap', new Set())).toBe('Claap')
  expect(nameServer('my_crm-server', new Set())).toBe('My crm server')
})

test('an unknown connector says it is one', async () => {
  expect(nameServer('deadbeef-0000-4000-8000-000000000000', new Set(['do_thing']))).toBe('Connector dead')
})

test('the app own tools are not outside services', async () => {
  for (const s of ['Claude_Browser', 'ccd_session', 'visualize', 'terminal', 'claude-in-chrome']) expect(isLocal(s)).toBe(true)
  for (const s of ['claap', 'google-mail', '0f0f0f0f-1111-4222-8333-444444444444']) expect(isLocal(s)).toBe(false)
})

test('tool names are grouped by server', async () => {
  const m = toolsByServer(['mcp__claap__get_recording', 'mcp__claap__list_folders', 'Read', 'mcp__a__b'])
  expect([...m.keys()]).toEqual(['claap', 'a'])
  expect([...m.get('claap')!]).toEqual(['get_recording', 'list_folders'])
})
