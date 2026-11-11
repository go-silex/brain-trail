// Recorded session. Host PluginState augmentation stays in index.d.ts and is not re-exported here.
// `p` is relative to the session's folder, or absolute for a file outside it (`out`).
// `agent` marks a sub-agent's step: its files never reach the main context.

export type TrailEvent =
  | {
      k: 'read' | 'write' | 'hit'
      p: string
      at: number
      out?: true
      agent?: true
    }
  // file names that entered the context without the files: in a result (a search, a listing, a connector, a
  // sub-agent's report) or as [[links]] inside a note Claude read. One event per result, inside the session's folder.
  | {
      k: 'seen'
      ps: string[]
      via: 'search' | 'link'
      at: number
      agent?: true
    }
  | {
      k: 'mcp'
      server: string
      tool: string
      label: string
      at: number
      err?: true
      agent?: true
    }
  | { k: 'prompt'; text: string; at: number }
  // what one tool result added to the main context, estimated from its length
  | { k: 'cost'; tool: string; label: string; tokens: number; at: number }
  | { k: 'compact'; at: number }
  | { k: 'skill'; name: string; plugin?: string; at: number; agent?: true }
  | { k: 'agent'; type: string; at: number }
  // one action of Claude, told later in plain words: the tool and what it was about (a file, a search, a description)
  | { k: 'act'; tool: string; what: string; at: number; agent?: true }
  // Claude's own plan: a whole list, a task added or changed, or the app's task list moved on
  | {
      k: 'plan'
      items?: { t: string; s: string }[]
      add?: { id: string; t: string }
      upd?: { id: string; s?: string; t?: string }
      adv?: true
      done?: number[]
      start?: number
      at: number
    }
  // a turn of the main conversation ended
  | { k: 'done'; at: number }

// What the capped event list no longer holds: how many steps the session took in all, and when it began.
export type Totals = { steps: number; first?: number }

export type Tab = 'map' | 'goal' | 'files' | 'context' | 'coach' | 'settings'

// What opens a file the pane links to ('default' = the system's choice), and the map's hover names.
export type TrailSettings = {
  openMd: string
  openOther: string
  hover: boolean
  planUsd?: number
  band?: boolean
}
export type Lang = 'en' | 'fr'

// The hand-off brief written for a new session.
export type Handoff = {
  text: string
  at: number
  busy: boolean
  error?: string
}

// The live context window, as the engine last measured it.
export type Meter = {
  tokens?: number
  window: number
  percent?: number
  estimated?: boolean
  usd?: number
  limits?: { kind: string; percentUsed: number; resetsAt?: string }[]
}

// How a file entered the context, and the trail a replay builds from the events.
export type Kind = 'read' | 'write' | 'hit' | 'link'
export type Move = { n: number; gap: boolean; at: number; i: number }
export type Call = {
  svc: string
  tool: string
  label?: string
  err: boolean
  from?: number
  at: number
}
export type Trail = {
  state: Map<number, { k: Kind; count: number }>
  moves: Move[]
  calls: Call[]
  perSvc: Map<string, number>
  // pairs of files joined by a link, as the notes the session read declare them
  links?: [number, number][]
}

// A later kind replaces an earlier one on the map (a read outranks a name merely seen).
export const rank: Record<Kind, number> = { link: 0, hit: 1, read: 2, write: 3 }
