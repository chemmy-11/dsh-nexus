/**
 * @dsh-external/dsh-nexus — nexus.db (SQLite, node:sqlite, zero deps).
 * vault_meta: file metadata baseline; edit_event: edit operations (only fs.watch channel writes).
 * turn_read/turn_text/annotation: M2/M3 L-field readings (session/event feed).
 * session_root: M4-L per-session L-field ownership ('' = owned by no pointing — global view only);
 * lfield_config: M4-L independent L-field pointing (single row; baseline_ts kept as legacy, no longer read).
 * Idempotency: edit_event.session_key unique (debounce window key) — no double counting on reload/restart.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface VaultMetaRow {
  root: string
  path: string
  mtime: number
  size: number
  chars: number
  first_seen_ts: number
  last_seen_ts: number
  deleted: number
}

export interface DaySummary {
  edits: number
  modifiedFiles: number
  createdFiles: number
  topActive: Array<{ path: string; edits: number }>
}

/** M2/M3 turn 读数行（官方会话事件聚合；与团队底座零耦合）。 */
export interface TurnReadRow {
  session: string
  turn: number
  ts: number
  question: string | null
  tokenIn: number
  tokenOut: number
  cacheRead: number
  durationMs: number | null
  tps: number | null
  clarity?: number | null
  defense?: string | null
  declaration?: number | null
}

/** M3-F.1 自评三行（A 腿二）。 */
export interface SelfCheck {
  clarity: number
  defense: 'none' | 'light' | 'heavy'
  declaration: 0 | 1
}

export function openStore(dbFile: string, initialRoot = ''): NexusStore {
  mkdirSync(dirname(dbFile), { recursive: true })
  return new NexusStore(dbFile, initialRoot)
}

export class NexusStore {
  private readonly db: DatabaseSync
  /** 迁移/首启前的种子 root（config.vaultRoot）——仅作初始指向与升级兜底。 */
  private readonly initialRoot: string

  constructor(dbFile: string, initialRoot = '') {
    this.db = new DatabaseSync(dbFile)
    this.initialRoot = initialRoot
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vault_meta (
        path TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        chars INTEGER NOT NULL,
        first_seen_ts INTEGER NOT NULL,
        last_seen_ts INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_meta_mtime ON vault_meta(mtime);
      CREATE TABLE IF NOT EXISTS edit_event (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        session_key TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_edit_ts ON edit_event(ts);
      CREATE INDEX IF NOT EXISTS idx_edit_path_ts ON edit_event(path, ts);
      -- M2：L 场读数（官方 session/event 直采；幂等键 step_seen）
      CREATE TABLE IF NOT EXISTS turn_read (
        session TEXT NOT NULL,
        turn INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        question TEXT,
        token_in INTEGER NOT NULL DEFAULT 0,
        token_out INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        tps REAL,
        clarity REAL,
        defense TEXT,
        declaration INTEGER,
        PRIMARY KEY (session, turn)
      );
      CREATE INDEX IF NOT EXISTS idx_turn_ts ON turn_read(ts);
      CREATE INDEX IF NOT EXISTS idx_turn_session ON turn_read(session, turn);
      CREATE TABLE IF NOT EXISTS step_seen (
        session TEXT NOT NULL,
        turn INTEGER NOT NULL,
        step INTEGER NOT NULL,
        PRIMARY KEY (session, turn, step)
      );
      -- M2：标记标注（预言检验表；prophecy 唯一——每个预言一条，最新状态）
      CREATE TABLE IF NOT EXISTS annotation (
        prophecy TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        note TEXT,
        session TEXT,
        turn INTEGER,
        updated_at INTEGER NOT NULL
      );
      -- M3-F.2：完整问答原文（B 方案；前向积累——每轮 user/assistant 全文）
      CREATE TABLE IF NOT EXISTS turn_text (
        session TEXT NOT NULL,
        turn INTEGER NOT NULL,
        user_text TEXT NOT NULL DEFAULT '',
        assistant_text TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session, turn)
      );
      -- M4-L：L 场读数会话归属（采集落点打标；'' = 未归属桶——仅在未指向时产生）
      CREATE TABLE IF NOT EXISTS session_root (
        session TEXT PRIMARY KEY,
        root TEXT NOT NULL DEFAULT '',
        first_ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_root ON session_root(root);
      -- M4-L：L 场读数独立指向（单行配置；与 vault_config 观测指向互不影响）
      CREATE TABLE IF NOT EXISTS lfield_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        root TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        baseline_ts INTEGER
      );
    `)
    this.migrate()
  }

  private migrate(): void {
    const v = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })?.user_version ?? 0
    if (v < 1) this.migrateV1()
    if (v < 2) this.migrateV2()
    if (v < 3) this.migrateV3()
  }

  /**
   * M4 迁移（user_version 0→1）：观察只取自指向 vault——
   * vault_meta 重建为 (root, path) 主键（两库同相对路径互不污染，原 path 主键改不了）；
   * edit_event 重建加 root 列；vault_config 建表；既有行 backfill 到迁移时生效的 root（种子）。
   */
  private migrateV1(): void {
    const seed = this.initialRoot
    this.db.exec('BEGIN')
    try {
      // 旧索引随表改名附着（同名）；先显式删，避免新建同名索引被 IF NOT EXISTS 跳过
      this.db.exec('DROP INDEX IF EXISTS idx_meta_mtime; DROP INDEX IF EXISTS idx_edit_ts; DROP INDEX IF EXISTS idx_edit_path_ts;')
      this.db.exec(`
        ALTER TABLE vault_meta RENAME TO vault_meta_old;
        CREATE TABLE vault_meta (
          root TEXT NOT NULL DEFAULT '',
          path TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL,
          chars INTEGER NOT NULL,
          first_seen_ts INTEGER NOT NULL,
          last_seen_ts INTEGER NOT NULL,
          deleted INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (root, path)
        );
        CREATE INDEX IF NOT EXISTS idx_meta_mtime ON vault_meta(mtime);
        ALTER TABLE edit_event RENAME TO edit_event_old;
        CREATE TABLE edit_event (
          id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          root TEXT NOT NULL DEFAULT '',
          path TEXT NOT NULL,
          kind TEXT NOT NULL,
          session_key TEXT NOT NULL UNIQUE
        );
        CREATE INDEX IF NOT EXISTS idx_edit_ts ON edit_event(ts);
        CREATE INDEX IF NOT EXISTS idx_edit_path_ts ON edit_event(path, ts);
        CREATE TABLE IF NOT EXISTS vault_config (
          root TEXT PRIMARY KEY,
          display_name TEXT,
          active INTEGER NOT NULL DEFAULT 0,
          confirmed_at INTEGER,
          last_scan_ts INTEGER
        );
      `)
      this.db.prepare(`
        INSERT INTO vault_meta (root, path, mtime, size, chars, first_seen_ts, last_seen_ts, deleted)
        SELECT ?, path, mtime, size, chars, first_seen_ts, last_seen_ts, deleted FROM vault_meta_old
      `).run(seed)
      this.db.prepare(`
        INSERT INTO edit_event (id, ts, root, path, kind, session_key)
        SELECT id, ts, ?, path, kind, session_key FROM edit_event_old
      `).run(seed)
      this.db.exec(`
        DROP TABLE vault_meta_old;
        DROP TABLE edit_event_old;
      `)
      if (seed !== '') {
        this.db.prepare(`
          INSERT INTO vault_config (root, display_name, active, confirmed_at, last_scan_ts)
          VALUES (?, NULL, 1, strftime('%s','now') * 1000, NULL)
        `).run(seed)
      }
      this.db.exec('PRAGMA user_version = 1')
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * M4-L 迁移（user_version 1→2，2026-08-31 定稿）：L 场读数独立指向 + 归档——
   * 既有会话（指向制前）整体归入 '' 桶（守谷人定稿：= 目前全部数据；M4.11 起该桶语义为「不属于任何指向」，不再是视图，
   * 与指向后的知识库会话两类分开处理）；lfield_config 种子 = 迁移时 vault 指向。
   */
  private migrateV2(): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO session_root (session, root, first_ts)
        SELECT session, '', MIN(ts) FROM turn_read GROUP BY session
      `).run()
      this.db.prepare(`
        INSERT OR IGNORE INTO lfield_config (id, root, updated_at, baseline_ts) VALUES (1, ?, ?, ?)
      `).run(this.activeRoot(), Date.now(), Date.now())
      this.db.exec('PRAGMA user_version = 2')
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * M4-L 修正迁移（user_version 2→3）：为旧 v2 表补 baseline_ts 列（划代基线——
   * 归档 epoch 与指向 epoch 的分界时刻）。幂等：已有基线 → 零行变更。
   */
  private migrateV3(): void {
    this.db.exec('BEGIN')
    try {
      const cols = this.db.prepare('PRAGMA table_info(lfield_config)').all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'baseline_ts')) {
        this.db.exec('ALTER TABLE lfield_config ADD COLUMN baseline_ts INTEGER')
      }
      this.db.prepare('UPDATE lfield_config SET baseline_ts = ? WHERE baseline_ts IS NULL').run(Date.now())
      this.db.exec('PRAGMA user_version = 3')
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  close(): void {
    this.db.close()
  }

  // ── 指向（vault_config） ────────────────────────────────────────────────────

  /** 当前指向：config 表 active 行；无则回退种子 root（config.vaultRoot）。 */
  activeRoot(): string {
    const row = this.db.prepare('SELECT root FROM vault_config WHERE active = 1 LIMIT 1').get() as { root: string } | undefined
    return row?.root ?? this.initialRoot
  }

  listVaults(): Array<{ root: string; displayName: string | null; active: number; confirmedAt: number | null }> {
    const rows = this.db.prepare('SELECT root, display_name, active, confirmed_at FROM vault_config ORDER BY confirmed_at DESC').all() as Array<Record<string, unknown>>
    return rows.map((r) => ({
      root: String(r.root),
      displayName: r.display_name === null || r.display_name === undefined ? null : String(r.display_name),
      active: Number(r.active ?? 0),
      confirmedAt: r.confirmed_at === null || r.confirmed_at === undefined ? null : Number(r.confirmed_at),
    }))
  }

  /** 切换指向（唯一 active）；旧数据按 root 保留。 */
  setActiveVault(root: string, displayName: string | null = null): void {
    this.db.prepare('UPDATE vault_config SET active = 0').run()
    this.db.prepare(`
      INSERT INTO vault_config (root, display_name, active, confirmed_at, last_scan_ts)
      VALUES (?, ?, 1, ?, NULL)
      ON CONFLICT(root) DO UPDATE SET
        active = 1,
        confirmed_at = COALESCE(confirmed_at, excluded.confirmed_at),
        display_name = COALESCE(display_name, excluded.display_name)
    `).run(root, displayName, Date.now())
  }

  /**
   * 首次绑定接管：迁移期未归属（root=''）的观测数据归入新指向——
   * 本机迁移前始终只观测这一个库（nexus 现状），旧行不丢、统计无缝；仅 vault_config
   * 此前为空（首次确认）时由调用方触发；已有多库记录后不再接管（'' 行保持悬置）。
   */
  reclaimUnowned(root: string): number {
    const m = this.db.prepare('UPDATE vault_meta SET root = ? WHERE root = ?').run(root, '')
    const e = this.db.prepare('UPDATE edit_event SET root = ? WHERE root = ?').run(root, '')
    return Number(m.changes) + Number(e.changes)
  }

  // ── M4-L：L 场读数独立指向（lfield_config / session_root） ──────────────────

  /** L 场读数当前指向（采集归属；'' = 未指向——新会话将落入未归属桶）。 */
  lfieldRoot(): string {
    const r = this.db.prepare('SELECT root FROM lfield_config WHERE id = 1').get() as { root: string } | undefined
    return r === undefined ? '' : String(r.root)
  }

  /** 切换 L 场读数指向（采集从此归入新根；既有会话归属不变）。 */
  setLfieldRoot(root: string): void {
    this.db.prepare(`
      INSERT INTO lfield_config (id, root, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET root = excluded.root, updated_at = excluded.updated_at
    `).run(root, Date.now())
  }

  /**
   * 会话首次落点分类（守谷人 2026-08-31 定稿；2026-09 口径修订保留）：cwd 在当前 L 场指向根之下（含等于）
   * → vault 会话，归指向根；否则 → ''（不属于任何指向，只在全局视图出现）。INSERT OR IGNORE——首标定终身，不因后续改写。
   */
  classifySessionRoot(session: string, cwd: string | undefined, ts: number): void {
    const root = this.lfieldRoot()
    const kb = cwd !== undefined && cwd !== '' && root !== '' && this.isUnderRoot(cwd, root)
    this.db.prepare('INSERT OR IGNORE INTO session_root (session, root, first_ts) VALUES (?, ?, ?)')
      .run(session, kb ? root : '', ts)
  }

  /** workspace 归属判定：cwd 等于根或位于根下（Windows 大小写不敏感，分隔符统一）。 */
  private isUnderRoot(cwd: string, root: string): boolean {
    const norm = (p: string): string => p.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
    const c = norm(cwd)
    const r = norm(root)
    return c === r || c.startsWith(r + '\\')
  }

  /** 各归属的会话数（键含 '' = 不属于任何指向）。 */
  sessionRootCounts(): Record<string, number> {
    const rows = this.db.prepare('SELECT root, COUNT(*) AS n FROM session_root GROUP BY root').all() as Array<{ root: string; n: number }>
    const out: Record<string, number> = {}
    for (const r of rows) out[String(r.root)] = Number(r.n)
    return out
  }

  /** 每会话元信息（首轮时刻 + 轮数；会话选择器的友好标签数据源）。 */
  sessionMeta(): Record<string, { startTs: number; turns: number }> {
    const rows = this.db.prepare('SELECT session, MIN(ts) AS start_ts, COUNT(*) AS turns FROM turn_read GROUP BY session').all() as Array<Record<string, unknown>>
    const out: Record<string, { startTs: number; turns: number }> = {}
    for (const r of rows) out[String(r.session)] = { startTs: Number(r.start_ts), turns: Number(r.turns) }
    return out
  }

  /** M4-B：逐会话自评覆盖（已评/总轮次 + 缺口轮号；root 给定时按归属桶过滤）。 */
  selfcheckCoverage(root?: string): {
    checked: number
    total: number
    bySession: Record<string, { checked: number; total: number; missing: number[] }>
  } {
    const f = this.turnRootFilter(root)
    const agg = this.db.prepare(`
      SELECT session, COUNT(*) AS total,
             SUM(CASE WHEN clarity IS NOT NULL THEN 1 ELSE 0 END) AS checked
      FROM turn_read WHERE 1 = 1${f.sql}
      GROUP BY session
    `).all(...f.params) as Array<Record<string, unknown>>
    const missing = this.db.prepare(`
      SELECT session, turn FROM turn_read WHERE clarity IS NULL${f.sql} ORDER BY session, turn
    `).all(...f.params) as Array<Record<string, unknown>>
    const bySession: Record<string, { checked: number; total: number; missing: number[] }> = {}
    let checked = 0
    let total = 0
    for (const r of agg) {
      const s = String(r.session)
      const t = Number(r.total)
      const c = Number(r.checked ?? 0)
      bySession[s] = { checked: c, total: t, missing: [] }
      checked += c
      total += t
    }
    for (const r of missing) {
      const s = String(r.session)
      if (bySession[s] !== undefined) bySession[s].missing.push(Number(r.turn))
    }
    return { checked, total, bySession }
  }

  /** 会话归属过滤片段：root 给定时仅取归属该根的会话（undefined = 不过滤——工具全局口径）。 */
  private turnRootFilter(root: string | undefined): { sql: string; params: string[] } {
    if (root === undefined) return { sql: '', params: [] }
    return { sql: ' AND session IN (SELECT session FROM session_root WHERE root = ?)', params: [root] }
  }

  // ── vault_meta ──────────────────────────────────────────────────────────────

  getMeta(path: string, root: string): VaultMetaRow | undefined {
    return this.db.prepare('SELECT * FROM vault_meta WHERE path = ? AND root = ?').get(path, root) as VaultMetaRow | undefined
  }

  /** upsert；@returns 'created' | 'updated' | 'unchanged'（path+root 为业务主键） */
  upsertMeta(row: { path: string; root: string; mtime: number; size: number; chars: number; ts: number }): 'created' | 'updated' | 'unchanged' {
    const existing = this.getMeta(row.path, row.root)
    if (existing === undefined) {
      this.db.prepare(`
        INSERT INTO vault_meta (root, path, mtime, size, chars, first_seen_ts, last_seen_ts, deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `).run(row.root, row.path, row.mtime, row.size, row.chars, row.ts, row.ts)
      return 'created'
    }
    if (existing.deleted === 1 || existing.mtime !== row.mtime || existing.size !== row.size) {
      this.db.prepare(`
        UPDATE vault_meta SET mtime = ?, size = ?, chars = ?, last_seen_ts = ?, deleted = 0 WHERE path = ? AND root = ?
      `).run(row.mtime, row.size, row.chars, row.ts, row.path, row.root)
      return 'updated'
    }
    return 'unchanged'
  }

  markDeleted(path: string, root: string, nowTs: number): void {
    this.db.prepare('UPDATE vault_meta SET deleted = 1, last_seen_ts = ? WHERE path = ? AND root = ?').run(nowTs, path, root)
  }

  totals(root: string): { totalFiles: number; totalChars: number } {
    const r = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(chars), 0) AS c FROM vault_meta WHERE root = ? AND deleted = 0').get(root) as
      | { n: number; c: number }
      | undefined
    return { totalFiles: r?.n ?? 0, totalChars: r?.c ?? 0 }
  }

  allPaths(root: string): string[] {
    return (this.db.prepare('SELECT path FROM vault_meta WHERE root = ?').all(root) as Array<{ path: string }>).map((r) => r.path)
  }

  // ── edit_event ──────────────────────────────────────────────────────────────

  /** 幂等写入；@returns true = 新记，false = 重复忽略。 */
  insertEdit(ev: { ts: number; root: string; path: string; kind: string; sessionKey: string }): boolean {
    const r = this.db.prepare(`
      INSERT OR IGNORE INTO edit_event (id, ts, root, path, kind, session_key) VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), ev.ts, ev.root, ev.path, ev.kind, ev.sessionKey)
    return Number(r.changes) > 0
  }

  // ── 统计（§3 口径；全部按 root 过滤——观察只取自指向 vault） ────────────────

  summary(root: string, dayStart: number, dayEnd: number): DaySummary {
    const edits = this.db.prepare('SELECT COUNT(*) AS n FROM edit_event WHERE root = ? AND ts >= ? AND ts < ?').get(root, dayStart, dayEnd) as { n: number }
    const created = this.db.prepare("SELECT COUNT(DISTINCT path) AS n FROM edit_event WHERE root = ? AND ts >= ? AND ts < ? AND kind = 'created'")
      .get(root, dayStart, dayEnd) as { n: number }
    const modified = this.db.prepare("SELECT COUNT(DISTINCT path) AS n FROM edit_event WHERE root = ? AND ts >= ? AND ts < ? AND kind = 'modified'")
      .get(root, dayStart, dayEnd) as { n: number }
    const top = this.db.prepare(`
      SELECT path, COUNT(*) AS edits FROM edit_event WHERE root = ? AND ts >= ? AND ts < ?
      GROUP BY path ORDER BY edits DESC LIMIT 5
    `).all(root, dayStart, dayEnd) as Array<{ path: string; edits: number }>
    return { edits: edits.n, modifiedFiles: modified.n, createdFiles: created.n, topActive: top }
  }

  recentEvents(root: string, limit: number): Array<{ ts: number; path: string; kind: string }> {
    return this.db.prepare('SELECT ts, path, kind FROM edit_event WHERE root = ? ORDER BY ts DESC LIMIT ?').all(root, limit) as Array<
      { ts: number; path: string; kind: string }
    >
  }

  // ── M2 turn_read（官方事件 → 每轮读数） ──────────────────────────────────────

  /** 幂等标记 step 已消费；@returns true = 首次（应更新 turn_read），false = 重复忽略。 */
  marksStepSeen(session: string, turn: number, step: number): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO step_seen (session, turn, step) VALUES (?, ?, ?)')
      .run(session, turn, step)
    return Number(r.changes) > 0
  }

  /** upsert 每轮读数（按 step 聚合累加；重启/重载幂等）。 */
  upsertTurnRead(row: {
    session: string
    turn: number
    ts: number
    question: string | null
    tokenIn: number
    tokenOut: number
    cacheRead: number
    durationMs: number | null
  }): void {
    const dur = row.durationMs !== null && row.durationMs > 0 ? row.durationMs : null
    const tps = dur !== null ? (row.tokenOut * 1000.0) / dur : null
    this.db.prepare(`
      INSERT INTO turn_read (session, turn, ts, question, token_in, token_out, cache_read, duration_ms, tps)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session, turn) DO UPDATE SET
        ts = excluded.ts,
        question = COALESCE(excluded.question, question),
        token_in = token_in + excluded.token_in,
        token_out = token_out + excluded.token_out,
        cache_read = cache_read + excluded.cache_read,
        duration_ms = COALESCE(duration_ms, 0) + COALESCE(excluded.duration_ms, 0),
        tps = CASE
          WHEN COALESCE(duration_ms, 0) + COALESCE(excluded.duration_ms, 0) > 0
          THEN (token_out + excluded.token_out) * 1000.0
               / (COALESCE(duration_ms, 0) + COALESCE(excluded.duration_ms, 0))
          ELSE NULL END
    `).run(
      row.session, row.turn, row.ts, row.question,
      row.tokenIn, row.tokenOut, row.cacheRead, dur, tps,
    )
  }

  turnReads(limit: number, root?: string): TurnReadRow[] {
    const f = this.turnRootFilter(root)
    const rows = this.db.prepare(`
      SELECT session, turn, ts, question, token_in, token_out, cache_read, duration_ms, tps,
             clarity, defense, declaration
      FROM turn_read WHERE 1 = 1${f.sql} ORDER BY ts DESC LIMIT ?
    `).all(...f.params, limit) as Array<Record<string, unknown>>
    return rows.map((r) => mapTurnRow(r))
  }

  /** 总量读数（总命中/未命中 token）；未命中 = token_in（官方 inputTokens = 未命中口径）。 */
  turnTotals(root?: string): { turns: number; tokenIn: number; tokenOut: number; cacheRead: number } {
    const f = this.turnRootFilter(root)
    const r = this.db.prepare(`
      SELECT COUNT(*) AS turns,
             COALESCE(SUM(token_in), 0) AS tin,
             COALESCE(SUM(token_out), 0) AS tout,
             COALESCE(SUM(cache_read), 0) AS cr
      FROM turn_read WHERE 1 = 1${f.sql}
    `).get(...f.params) as { turns: number; tin: number; tout: number; cr: number }
    return { turns: Number(r.turns ?? 0), tokenIn: Number(r.tin ?? 0), tokenOut: Number(r.tout ?? 0), cacheRead: Number(r.cr ?? 0) }
  }

  /** 窗口内读数（曲线数据；ts >= fromTs 升序；root 给定时按归属桶过滤）。 */
  turnReadsSince(fromTs: number, root?: string): TurnReadRow[] {
    const f = this.turnRootFilter(root)
    const rows = this.db.prepare(`
      SELECT session, turn, ts, question, token_in, token_out, cache_read, duration_ms, tps,
             clarity, defense, declaration
      FROM turn_read WHERE ts >= ?${f.sql} ORDER BY ts ASC
    `).all(fromTs, ...f.params) as Array<Record<string, unknown>>
    return rows.map((r) => mapTurnRow(r))
  }

  /** M3-F.1：写入某轮自评三行（upsert，幂等——同一轮重复自评以新值覆盖）。 */
  setSelfCheck(session: string, turn: number, check: SelfCheck): void {
    this.db.prepare(`
      UPDATE turn_read SET clarity = ?, defense = ?, declaration = ? WHERE session = ? AND turn = ?
    `).run(check.clarity, check.defense, check.declaration, session, turn)
  }

  // ── M3-F.2 完整问答原文（B 方案；前向积累） ─────────────────────────────────

  /** 写入/更新该轮用户问题全文（首次 insert，后续仅当为空时补）。 */
  upsertUserText(session: string, turn: number, text: string): void {
    this.db.prepare(`
      INSERT INTO turn_text (session, turn, user_text, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(session, turn) DO UPDATE SET
        user_text = CASE WHEN turn_text.user_text = '' THEN excluded.user_text ELSE turn_text.user_text END,
        updated_at = excluded.updated_at
    `).run(session, turn, text, Date.now())
  }

  /** 追加该轮 assistant 全文（多 step 拼接，幂等由 step_seen 保证调用方只调一次/step）。 */
  appendAssistantText(session: string, turn: number, text: string): void {
    this.db.prepare(`
      INSERT INTO turn_text (session, turn, assistant_text, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(session, turn) DO UPDATE SET
        assistant_text = turn_text.assistant_text || excluded.assistant_text,
        updated_at = excluded.updated_at
    `).run(session, turn, text, Date.now())
  }

  getTurnText(session: string, turn: number): { userText: string; assistantText: string } | null {
    const r = this.db.prepare('SELECT user_text, assistant_text FROM turn_text WHERE session = ? AND turn = ?')
      .get(session, turn) as { user_text: string; assistant_text: string } | undefined
    if (r === undefined) return null
    return { userText: r.user_text, assistantText: r.assistant_text }
  }

  // ── M2 预言标注 ─────────────────────────────────────────────────────────────

  listAnnotations(): Array<{ prophecy: string; status: string; note: string | null; session: string | null; turn: number | null; updatedAt: number }> {
    const rows = this.db.prepare('SELECT prophecy, status, note, session, turn, updated_at FROM annotation ORDER BY prophecy').all() as Array<Record<string, unknown>>
    return rows.map((r) => ({
      prophecy: String(r.prophecy), status: String(r.status ?? 'pending'),
      note: r.note === null || r.note === undefined ? null : String(r.note),
      session: r.session === null || r.session === undefined ? null : String(r.session),
      turn: r.turn === null || r.turn === undefined ? null : Number(r.turn),
      updatedAt: Number(r.updated_at ?? 0),
    }))
  }

  upsertAnnotation(row: { prophecy: string; status: string; note?: string | null; session?: string | null; turn?: number | null }): void {
    this.db.prepare(`
      INSERT INTO annotation (prophecy, status, note, session, turn, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(prophecy) DO UPDATE SET
        status = excluded.status,
        note = excluded.note,
        session = excluded.session,
        turn = excluded.turn,
        updated_at = excluded.updated_at
    `).run(row.prophecy, row.status, row.note ?? null, row.session ?? null, row.turn ?? null, Date.now())
  }
}

/** 行 → TurnReadRow（含 M3-F.1 预留/自评三列）。 */
function mapTurnRow(r: Record<string, unknown>): TurnReadRow {
  return {
    session: String(r.session!), turn: Number(r.turn), ts: Number(r.ts),
    question: r.question === null || r.question === undefined ? null : String(r.question),
    tokenIn: Number(r.token_in ?? 0), tokenOut: Number(r.token_out ?? 0),
    cacheRead: Number(r.cache_read ?? 0),
    durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
    tps: r.tps === null || r.tps === undefined ? null : Number(r.tps),
    clarity: r.clarity === null || r.clarity === undefined ? null : Number(r.clarity),
    defense: r.defense === null || r.defense === undefined ? null : String(r.defense),
    declaration: r.declaration === null || r.declaration === undefined ? null : Number(r.declaration),
  }
}
