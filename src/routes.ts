/**
 * @dsh-external/dsh-nexus — observation REST routes (host half).
 * GET  /api/nexus/state          → panel snapshot (totals / today / week / recent edit stream)
 * POST /api/nexus/action         → { kind: 'rescan' } triggers a full scan
 * GET  /api/nexus/m2/state       → L 场读数（latest / totals / curve points / recent；?root=all → 全局视图）
 * GET  /api/nexus/m2/annotations → 预言检验表标注
 * POST /api/nexus/m2/annotations → upsert 标注（prophecy 唯一）
 * GET  /api/nexus/lfield         → L 场读数独立指向（M4-L；known 桶/会话计数）
 * POST /api/nexus/lfield         → 切换 L 场读数指向（采集归属；既有会话归属不变）
 * Same-origin marker guard; registered as effect.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { NexusStore } from './store.js'
import { statSync, accessSync, constants } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { analyze } from './analysis.js'

const API_PREFIX = '/api/nexus'

export interface RouteDeps {
  store: NexusStore
  onRescan: () => void
  /** M4.3：指向切换后发射（index.ts 监听后重挂 scan/watch）。 */
  onVaultChanged?: () => void
  /** L 场读数曲线窗口（天），默认 30。 */
  m2HistoryDays?: number
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function browserSameOriginMarker(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return site === 'same-origin' || typeof req.headers.origin === 'string'
}

function dayWindow(offsetDays: number): { start: number; end: number } {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - offsetDays)
  return { start: start.getTime(), end: start.getTime() + 86400000 }
}

export function registerNexusRoutes(ctx: { webServer: { register(route: WebRoute): () => void } }, deps: RouteDeps): () => void {
  const disposers: Array<() => void> = []

  const state: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/state`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      // M4.3：观测数据只取自指向 vault（root 过滤；未指向 → 空数据）
      const root = deps.store.activeRoot()
      const today = dayWindow(0)
      const week = dayWindow(6)
      json(res, 200, {
        revision: Date.now(),
        activeRoot: root,
        totals: deps.store.totals(root),
        today: deps.store.summary(root, today.start, today.end),
        week: deps.store.summary(root, week.start, Date.now()),
        recent: deps.store.recentEvents(root, 20),
      })
    },
  }

  // M4.3：vault 指向（GET 状态 / POST 切换并触发重扫）
  const vault: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/vault`,
    handler: (req, res): void => {
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      if (req.method === 'GET') {
        const active = deps.store.activeRoot()
        let exists = false
        let readable = false
        if (active !== '') {
          try {
            exists = statSync(active).isDirectory()
            accessSync(active, constants.R_OK)
            readable = true
          } catch { /* 不可读/不存在 —— readable 保持 false */ }
        }
        json(res, 200, {
          revision: Date.now(), active, exists, readable,
          known: deps.store.listVaults(),
        })
        return
      }
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      void (async () => {
        try {
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { root?: unknown; displayName?: unknown }
          if (typeof body.root !== 'string' || body.root.trim() === '') {
            return json(res, 400, { ok: false, error: 'invalid-root' })
          }
          if (!isAbsolute(body.root)) return json(res, 400, { ok: false, error: 'must-be-absolute' })
          const norm = resolve(body.root)
          let st
          try { st = statSync(norm) } catch { return json(res, 400, { ok: false, error: 'not-found' }) }
          if (!st.isDirectory()) return json(res, 400, { ok: false, error: 'not-a-directory' })
          try { accessSync(norm, constants.R_OK) } catch { return json(res, 400, { ok: false, error: 'not-readable' }) }
          // OQ-M4-2：存在即可指（.md 缺失仅扫描后 0 文件提示，不阻断）
          const firstBind = deps.store.listVaults().length === 0
          deps.store.setActiveVault(norm, typeof body.displayName === 'string' && body.displayName.trim() !== '' ? body.displayName.trim() : null)
          // 首次确认：迁移期未归属数据（root=''）归入新指向——旧历史不丢、统计无缝
          if (firstBind) {
            const n = deps.store.reclaimUnowned(norm)
            if (n > 0) console.log(`[nexus] 首次绑定接管未归属观测数据 ${n} 行 → ${norm}`)
          }
          if (deps.onVaultChanged) deps.onVaultChanged()
          json(res, 200, { ok: true, active: norm })
        } catch {
          json(res, 400, { ok: false, error: 'bad-json' })
        }
      })()
    },
  }

  const action: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/action`,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      try {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { kind?: string }
        if (body.kind !== 'rescan') return json(res, 400, { ok: false, error: 'invalid-action' })
        deps.onRescan()
        json(res, 200, { ok: true })
      } catch {
        json(res, 400, { ok: false, error: 'bad-json' })
      }
    },
  }

  for (const route of [state, vault, action]) disposers.push(ctx.webServer.register(route))

  // ── M2：L 场读数 ────────────────────────────────────────────────────────────

  const m2State: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/m2/state`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const historyDays = deps.m2HistoryDays ?? 30
      const fromTs = Date.now() - historyDays * 86400000
      // M4.11：视图两态——?root=all → 全局（不过滤归属）；默认 = 当前 L 场指向（vault 会话）
      const url = new URL(String(req.url ?? ''), 'http://localhost')
      const rv = url.searchParams.get('root')
      const root: string | undefined = rv === 'all' ? undefined : deps.store.lfieldRoot()
      const points = deps.store.turnReadsSince(fromTs, root)
      const latest = points.length > 0 ? points[points.length - 1] : null
      const totals = deps.store.turnTotals(root)
      // 官方口径（llm-deepseek mapUsage 实证）：usage.inputTokens 已扣除缓存命中 = 未命中；
      // 总输入 = inputTokens + cacheReadTokens；命中率 = cacheRead / 总输入；A 投影（未命中率）= inputTokens / 总输入。
      const totalIn = totals.tokenIn + totals.cacheRead
      const hitRate = totalIn > 0 ? totals.cacheRead / totalIn : null
      json(res, 200, {
        revision: Date.now(),
        activeRoot: root ?? null,
        pointing: deps.store.lfieldRoot(),
        sessionMeta: deps.store.sessionMeta(),
        selfcheck: deps.store.selfcheckCoverage(root),
        latest,
        totals: {
          turns: totals.turns,
          tokenIn: totals.tokenIn,
          tokenOut: totals.tokenOut,
          cacheRead: totals.cacheRead,
          missToken: totals.tokenIn,
          totalIn,
          hitRate,
        },
        curve: points,
        recent: points.slice(-20).reverse(),
      })
    },
  }

  // 标注读写合并为单路由（webserver 按 path 判重，不支持同 path 多方法注册）
  const annotations: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/m2/annotations`,
    handler: async (req, res): Promise<void> => {
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      if (req.method === 'GET') {
        json(res, 200, { revision: Date.now(), annotations: deps.store.listAnnotations() })
        return
      }
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      try {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          prophecy?: unknown; status?: unknown; note?: unknown; session?: unknown; turn?: unknown
        }
        const prophecy = typeof body.prophecy === 'string' && body.prophecy !== '' ? body.prophecy : null
        const status = typeof body.status === 'string' && body.status !== '' ? body.status : 'pending'
        if (prophecy === null || !/^P\d+$/.test(prophecy)) return json(res, 400, { ok: false, error: 'invalid-prophecy' })
        if (!['pending', 'investigating', 'observed'].includes(status)) return json(res, 400, { ok: false, error: 'invalid-status' })
        deps.store.upsertAnnotation({
          prophecy,
          status,
          note: body.note === null || body.note === undefined ? null : String(body.note),
          session: body.session === null || body.session === undefined ? null : String(body.session),
          turn: typeof body.turn === 'number' ? body.turn : null,
        })
        json(res, 200, { ok: true })
      } catch {
        json(res, 400, { ok: false, error: 'bad-json' })
      }
    },
  }

  // M3-F.2：完整问答原文（B 方案；同源守卫；?session=&turn=）
  const turnText: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/m2/turn-text`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const url = new URL(String(req.url ?? ''), 'http://localhost')
      const session = url.searchParams.get('session') ?? ''
      const turn = Number(url.searchParams.get('turn') ?? '')
      if (session === '' || !Number.isInteger(turn)) {
        return json(res, 400, { ok: false, error: 'invalid-params' })
      }
      const text = deps.store.getTurnText(session, turn)
      if (text === null) return json(res, 200, { found: false })
      json(res, 200, { found: true, session, turn, ...text })
    },
  }

  // M3-F.3：白盒探索性分析（S 形/爆发段/τ_e；口径=镜 OQ-M2-1/2 裁决；视图口径同 m2/state）
  const analysis: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/m2/analysis`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const historyDays = deps.m2HistoryDays ?? 30
      const fromTs = Date.now() - historyDays * 86400000
      const url = new URL(String(req.url ?? ''), 'http://localhost')
      const rv = url.searchParams.get('root')
      const root: string | undefined = rv === 'all' ? undefined : deps.store.lfieldRoot()
      const rows = deps.store.turnReadsSince(fromTs, root)
      const results = analyze(rows)
      json(res, 200, { revision: Date.now(), results })
    },
  }

  // M4-L：L 场读数独立指向（GET 状态 / POST 切换采集归属）
  const lfield: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/lfield`,
    handler: (req, res): void => {
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      if (req.method === 'GET') {
        json(res, 200, {
          revision: Date.now(),
          active: deps.store.lfieldRoot(),
          counts: deps.store.sessionRootCounts(),
          known: deps.store.listVaults(),
        })
        return
      }
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      void (async () => {
        try {
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { root?: unknown }
          if (typeof body.root !== 'string' || body.root.trim() === '') {
            return json(res, 400, { ok: false, error: 'invalid-root' })
          }
          if (!isAbsolute(body.root)) return json(res, 400, { ok: false, error: 'must-be-absolute' })
          const norm = resolve(body.root)
          let st
          try { st = statSync(norm) } catch { return json(res, 400, { ok: false, error: 'not-found' }) }
          if (!st.isDirectory()) return json(res, 400, { ok: false, error: 'not-a-directory' })
          try { accessSync(norm, constants.R_OK) } catch { return json(res, 400, { ok: false, error: 'not-readable' }) }
          deps.store.setLfieldRoot(norm)
          console.log(`[nexus] L 场读数指向切换 → ${norm}（新会话自此归入；既有归属不变）`)
          json(res, 200, { ok: true, active: norm })
        } catch {
          json(res, 400, { ok: false, error: 'bad-json' })
        }
      })()
    },
  }

  for (const route of [m2State, annotations, turnText, analysis, lfield]) disposers.push(ctx.webServer.register(route))
  return () => { for (const d of disposers) d() }
}
