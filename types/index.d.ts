// One step of the session, as the pane records it.
// `p` is a path relative to the session's folder, or absolute for a file outside it (`out`).
// `agent` marks a step taken inside a sub-agent: its files never reach the main context.
export type TrailEvent =
  | { k: 'read' | 'write' | 'hit'; p: string; at: number; out?: true; agent?: true }
  // file names that entered the context without the files: in a result (a search, a listing, a connector, a
  // sub-agent's report) or as [[links]] inside a note Claude read. One event per result, inside the session's folder.
  | { k: 'seen'; ps: string[]; via: 'search' | 'link'; at: number; agent?: true }
  | { k: 'mcp'; server: string; tool: string; label: string; at: number; err?: true; agent?: true }
  | { k: 'prompt'; text: string; at: number }
  // what one tool result added to the main context, estimated from its length
  | { k: 'cost'; tool: string; label: string; tokens: number; at: number }
  | { k: 'compact'; at: number }
  | { k: 'skill'; name: string; plugin?: string; at: number; agent?: true }
  | { k: 'agent'; type: string; at: number }
  // one action of Claude, told later in plain words: the tool and what it was about (a file, a search, a description)
  | { k: 'act'; tool: string; what: string; at: number; agent?: true }
  // Claude's own plan: a whole list, a task added or changed, or the app's task list moved on
  | { k: 'plan'; items?: { t: string; s: string }[]; add?: { id: string; t: string }; upd?: { id: string; s?: string; t?: string }; adv?: true; done?: number[]; start?: number; at: number }
  // a turn of the main conversation ended
  | { k: 'done'; at: number }

// What the capped event list no longer holds: how many steps the session took in all, and when it began.
export type Totals = { steps: number; first?: number }

export type Tab = 'map' | 'goal' | 'files' | 'context' | 'coach' | 'settings'

// What opens a file the pane links to ('default' = the system's choice), and the map's hover names.
export type TrailSettings = { openMd: string; openOther: string; hover: boolean; planUsd?: number; band?: boolean }
export type Lang = 'en' | 'fr'

// The hand-off brief written for a new session.
export type Handoff = { text: string; at: number; busy: boolean; error?: string }

// The live context window, as the engine last measured it.
export type Meter = { tokens?: number; window: number; percent?: number; estimated?: boolean; usd?: number; limits?: { kind: string; percentUsed: number; resetsAt?: string }[] }

declare module 'claude-code' {
  interface PluginState {
    'brain-trail-v2': {
      events: Shaped<TrailEvent[]>
      totals: Shaped<Totals>
      meter: Shaped<Meter>
      tab: Tab
      lang: Lang
      zoomed: boolean
      camera: Shaped<{ x: number; y: number; side: number } | null>
      view3d: boolean
      cam3d: Shaped<{ yaw: number; pitch: number; zoom: number; pan: { x: number; y: number }; spin: boolean; at: number }>
      play: Shaped<{ step: number | null; playing: boolean }>
      preview: Shaped<{ p: string; out?: boolean } | null>
      coach: Shaped<{ text: string; patch?: string; at: number; busy: boolean; error?: string }>
      open: string[]
      settings: Shaped<TrailSettings>
      handoff: Shaped<Handoff>
    }
  }
}
