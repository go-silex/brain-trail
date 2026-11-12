import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { costStats, type CostEntry } from '../../hooks/readout'
import type { Lang, TrailSettings } from '../../types/model'

export class TrailStore {
  private readonly db: Database
  constructor(agentDir: string) {
    const dir = join(agentDir, 'brain-trail')
    mkdirSync(dir, { recursive: true })
    this.db = new Database(join(dir, 'trail.sqlite'), { create: true })
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS costs (session TEXT PRIMARY KEY, day TEXT NOT NULL, usd REAL NOT NULL, prompts INTEGER NOT NULL, side REAL NOT NULL DEFAULT 0, side_measured INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS clears (session TEXT PRIMARY KEY, leaf TEXT);',
    )
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS captures (session TEXT NOT NULL, scope TEXT NOT NULL, leaf TEXT, payload TEXT NOT NULL, PRIMARY KEY(session,scope)); CREATE TABLE IF NOT EXISTS capture_clears (session TEXT PRIMARY KEY, at INTEGER NOT NULL)',
    )
  }
  read(key: string): unknown {
    const row = this.db
      .query<{ value: string }, [string]>(
        'SELECT value FROM settings WHERE key = ?',
      )
      .get(key)
    if (!row) return undefined
    try {
      return JSON.parse(row.value) as unknown
    } catch {
      return undefined
    }
  }
  save(
    key: 'lang' | 'settings' | 'autoOpen',
    value: Lang | TrailSettings | boolean,
  ): void {
    this.db
      .query(
        'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value))
  }
  clearLeaf(session: string): string | null | undefined {
    return this.db
      .query<{ leaf: string | null }, [string]>(
        'SELECT leaf FROM clears WHERE session=?',
      )
      .get(session)?.leaf
  }
  setClearLeaf(session: string, leaf: string | null): void {
    this.db
      .query(
        'INSERT INTO clears(session,leaf) VALUES(?,?) ON CONFLICT(session) DO UPDATE SET leaf=excluded.leaf',
      )
      .run(session, leaf)
  }
  saveCapture(
    session: string,
    scope: string,
    leaf: string | null,
    payload: string,
  ): void {
    this.db
      .query(
        'INSERT OR IGNORE INTO captures(session,scope,leaf,payload) VALUES(?,?,?,?)',
      )
      .run(session, scope, leaf, payload)
  }
  captures(
    session: string,
  ): { scope: string; leaf: string | null; payload: string }[] {
    return this.db
      .query<{ scope: string; leaf: string | null; payload: string }, [string]>(
        'SELECT scope,leaf,payload FROM captures WHERE session=?',
      )
      .all(session)
  }
  clearAt(session: string): number {
    return (
      this.db
        .query<{ at: number }, [string]>(
          'SELECT at FROM capture_clears WHERE session=?',
        )
        .get(session)?.at ?? 0
    )
  }
  setClearAt(session: string, at: number): void {
    this.db
      .query(
        'INSERT INTO capture_clears(session,at) VALUES(?,?) ON CONFLICT(session) DO UPDATE SET at=excluded.at',
      )
      .run(session, at)
  }
  side(session: string): { usd: number; measured: boolean } {
    const row = this.db
      .query<{ side: number; side_measured: number }, [string]>(
        'SELECT side,side_measured FROM costs WHERE session=?',
      )
      .get(session)
    return { usd: row?.side ?? 0, measured: row?.side_measured === 1 }
  }
  addSide(session: string, day: string, usd: number): void {
    this.db
      .query(
        'INSERT INTO costs(session,day,usd,prompts,side,side_measured) VALUES(?,?,?,0,?,1) ON CONFLICT(session) DO UPDATE SET usd=costs.usd+excluded.side,side=costs.side+excluded.side,side_measured=1',
      )
      .run(session, day, usd, usd)
  }
  saveCost(
    session: string,
    day: string,
    nativeUsd: number,
    prompts: number,
  ): void {
    this.db.transaction(() => {
      this.db
        .query(
          'INSERT INTO costs(session,day,usd,prompts) VALUES(?,?,?,?) ON CONFLICT(session) DO UPDATE SET usd=excluded.usd+costs.side,prompts=excluded.prompts',
        )
        .run(session, day, nativeUsd, prompts)
      this.db.exec(
        'DELETE FROM costs WHERE session NOT IN (SELECT session FROM costs ORDER BY day DESC, rowid DESC LIMIT 400)',
      )
    })()
  }
  history(session: string, month: string) {
    const rows = this.db
      .query<
        { session: string; day: string; usd: number; prompts: number },
        []
      >('SELECT session,day,usd,prompts FROM costs')
      .all()
    const costs: Record<string, CostEntry> = Object.fromEntries(
      rows.map((row) => [
        row.session,
        { day: row.day, usd: row.usd, prompts: row.prompts },
      ]),
    )
    return costStats(costs, session, month)
  }
  close(): void {
    this.db.close()
  }
}
