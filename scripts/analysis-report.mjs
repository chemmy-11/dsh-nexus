// M4-A 分析报告（可重复运行）：node scripts/analysis-report.mjs [all|pointing]
// M4.11：视图两态（全局 / vault 指向）——归档口径下线。
// 复用插件 analyze() 管线（lib/analysis.js）+ 全局聚合，产出简历可引用的参数集。
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { analyze } from '../lib/analysis.js'

const scope = process.argv[2] ?? 'all'
const db = new DatabaseSync(join(homedir(), '.dsh', 'nexus', 'nexus.db'))

let where = ''
const params = []
if (scope !== 'all' && scope !== 'pointing') {
  console.error(`未知口径：${scope}（可用：all | pointing）`)
  process.exit(1)
}
if (scope === 'pointing') {
  const root = db.prepare('SELECT root FROM lfield_config WHERE id = 1').get().root
  where = 'AND session IN (SELECT session FROM session_root WHERE root = ?)'
  params.push(root)
}
const raw = db.prepare(`
  SELECT session, turn, ts, question, token_in, token_out, cache_read, duration_ms, tps,
         clarity, defense, declaration
  FROM turn_read WHERE 1 = 1 ${where} ORDER BY session, turn
`).all(...params)
const rows = raw.map((r) => ({
  session: String(r.session), turn: Number(r.turn), ts: Number(r.ts),
  question: r.question === null ? null : String(r.question),
  tokenIn: Number(r.token_in), tokenOut: Number(r.token_out), cacheRead: Number(r.cache_read),
  durationMs: r.duration_ms === null ? null : Number(r.duration_ms), tps: r.tps === null ? null : Number(r.tps),
  clarity: r.clarity === null ? null : Number(r.clarity),
  defense: r.defense === null ? null : String(r.defense),
  declaration: r.declaration === null ? null : Number(r.declaration),
}))

// ── 全局聚合 ──────────────────────────────────────────────────────────────────
const sum = (f) => rows.reduce((a, r) => a + (f(r) ?? 0), 0)
const tokenIn = sum((r) => r.tokenIn)
const tokenOut = sum((r) => r.tokenOut)
const cacheRead = sum((r) => r.cacheRead)
const totalIn = tokenIn + cacheRead
const hitRate = totalIn > 0 ? cacheRead / totalIn : null
const sessions = new Set(rows.map((r) => r.session))
const tpsRows = rows.filter((r) => r.tps !== null).map((r) => r.tps).sort((a, b) => a - b)
const p50 = tpsRows.length > 0 ? tpsRows[Math.floor(tpsRows.length / 2)] : null
const tpsAvg = tpsRows.length > 0 ? tpsRows.reduce((a, b) => a + b, 0) / tpsRows.length : null
const durRows = rows.filter((r) => r.durationMs !== null)

// ── 管线分析（S 形/爆发段/τ_e，逐会话） ────────────────────────────────────────
const results = analyze(rows)
const shapes = {}
for (const r of results) shapes[r.shape] = (shapes[r.shape] ?? 0) + 1
const taus = results.filter((r) => r.tauE !== null).map((r) => ({ session: r.session.replace(/^session-/, '').slice(0, 8), tauE: r.tauE, shape: r.shape }))
const bursts = results.filter((r) => r.burst !== null).map((r) => ({ session: r.session.replace(/^session-/, '').slice(0, 8), ...r.burst }))

// ── 自评（腿二） ───────────────────────────────────────────────────────────────
const cl = rows.filter((r) => r.clarity !== null)
const clBySess = new Map()
for (const r of cl) {
  if (!clBySess.has(r.session)) clBySess.set(r.session, [])
  clBySess.get(r.session).push(r.clarity)
}
const deltas = []
for (const [, arr] of clBySess) {
  if (arr.length >= 2) deltas.push(arr[arr.length - 1] - arr[0])
}
const declRows = rows.filter((r) => r.declaration === 1).length

const fmtM = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n)
const pct = (v) => v === null ? '—' : `${(v * 100).toFixed(1)}%`
const minT = rows.length > 0 ? Math.min(...rows.map((r) => r.ts)) : Date.now()
const maxT = rows.length > 0 ? Math.max(...rows.map((r) => r.ts)) : Date.now()
const day = (d) => d.toISOString().slice(0, 10)

console.log(`== scope=${scope} ==`)
console.log(`样本: ${rows.length} 轮 / ${sessions.size} 会话 | ${day(new Date(minT))} ~ ${day(new Date(maxT))}`)
console.log(`token: 总输入 ${fmtM(totalIn)}（命中 ${fmtM(cacheRead)} + 未命中 ${fmtM(tokenIn)}） | 输出 ${fmtM(tokenOut)}（占输入 ${(100 * tokenOut / totalIn).toFixed(2)}%）`)
console.log(`缓存命中率 = ${pct(hitRate)} | A 投影（未命中率）= ${pct(hitRate === null ? null : 1 - hitRate)}`)
console.log(`TPS: 中位 ${p50 === null ? '—' : p50.toFixed(1)} | 平均 ${tpsAvg === null ? '—' : tpsAvg.toFixed(1)} | 样本 ${tpsRows.length} step`)
console.log(`形态分布（${results.length} 会话）: ${JSON.stringify(shapes)}`)
console.log(`τ_e 检出: ${taus.length} 例 -> ${taus.map((x) => `${x.session}:${x.tauE}turn(${x.shape})`).join(', ') || '—'}`)
console.log(`爆发段: ${bursts.length} 例 -> ${bursts.map((x) => `${x.session}:t${x.fromTurn}→${x.toTurn}(${x.direction})`).join(', ') || '—'}`)
console.log(`自评: ${cl.length} 轮 / ${clBySess.size} 会话（覆盖率 ${pct(rows.length > 0 ? cl.length / rows.length : null)}）| 清晰度净增样本 ${deltas.length} 例${deltas.length > 0 ? ` -> [${deltas.map((d) => d.toFixed(2)).join(', ')}]` : ''} | 宣言检出 ${declRows}`)
if (scope === 'all') {
  const cov = db.prepare(`
    SELECT sr.root AS root, COUNT(tr.turn) AS total,
           SUM(CASE WHEN tr.clarity IS NOT NULL THEN 1 ELSE 0 END) AS checked
    FROM session_root sr JOIN turn_read tr ON tr.session = sr.session
    GROUP BY sr.root
  `).all()
  console.log(`自评覆盖对照（M4-B；差异主要来自工作区——自评指令只写在 vault 的 AGENTS.md 里）: ${cov.map((r) => `${r.root === '' ? '非指向工作区' : 'vault 指向'} ${(100 * Number(r.checked) / Number(r.total)).toFixed(1)}% (${r.checked}/${r.total})`).join(' · ')}`)
}
db.close()
