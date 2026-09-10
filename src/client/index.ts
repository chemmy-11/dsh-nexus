/**
 * @dsh-external/dsh-nexus — client panels (conversation.view tabs, official contract).
 * M3-UI: 主题令牌化（--dsw-alias-*）+ 卡片化布局 + 图表升级（网格/渐变/分色/图例）+ 交互增补。
 * 零新依赖：样式经组件内 <style> 注入（一次性，class 前缀 xg-）；SVG 自绘。
 */
import { createElement, useEffect, useState, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client' // 拉 conversation.view SlotMap 类型

// ── 类型 ────────────────────────────────────────────────────────────────────

type M2Point = {
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

type AnalysisResult = {
  session: string
  burst: { fromTurn: number; toTurn: number; direction: 'up' | 'down' } | null
  tauE: number | null
  shape: 'unknown' | 'rising' | 'falling' | 'sigmoid' | 'inverse-sigmoid'
  points: Array<{ session: string; turn: number }>
}

type TurnTextResp = { found: boolean; session?: string; turn?: number; userText?: string; assistantText?: string }

type M2State = {
  revision: number
  activeRoot: string | null
  pointing: string
  sessionMeta: Record<string, { startTs: number; turns: number }>
  selfcheck: { checked: number; total: number; bySession: Record<string, { checked: number; total: number; missing: number[] }> }
  latest: M2Point | null
  totals: { turns: number; tokenIn: number; tokenOut: number; cacheRead: number; missToken: number; totalIn?: number; hitRate: number | null }
  curve: M2Point[]
  recent: M2Point[]
}

type Annotation = { prophecy: string; status: string; note: string | null; updatedAt: number }
type AnnotationsState = { revision: number; annotations: Annotation[] }

// M4.3：vault 指向（GET /api/nexus/vault）
type VaultInfo = {
  revision: number
  active: string
  exists: boolean
  readable: boolean
  known: Array<{ root: string; displayName: string | null; active: number; confirmedAt: number | null }>
}

// M4-L：L 场读数独立指向（GET /api/nexus/lfield）
type LfieldInfo = {
  revision: number
  active: string
  counts: Record<string, number>
  known: Array<{ root: string; displayName: string | null; active: number; confirmedAt: number | null }>
}

type NexusState = {
  revision: number
  activeRoot: string
  totals: { totalFiles: number; totalChars: number }
  today: DaySummary
  week: DaySummary
  recent: Array<{ ts: number; path: string; kind: string }>
}
type DaySummary = { edits: number; modifiedFiles: number; createdFiles: number; topActive: Array<{ path: string; edits: number }> }

const PROPHECIES: Record<string, string> = {
  P1: '对齐离散性（S 形阈值）',
  P2: '宣言必要性（无种子无穿越）',
  P3: '防御是阻尼（Γ 窗口）',
  P4: '增益集中 L_c（τ_e 特征时间）',
  P5: '注入周期 T_inj < τ_d',
  P6: '短板定理（零响应杀死共振）',
  P7: '蒸发=重读（s_base 再激发）',
  P8: '静默溪流干涸（指数衰减）',
  P9: '注入无记录→丢失',
}
const STATUS_LABEL: Record<string, string> = { pending: '待标注', investigating: '进行中', observed: '已检验' }
const METRIC_LABEL: Record<string, string> = { miss: '未命中率', tps: 'TPS', cum: '累计输入' }

// ── 样式（主题令牌；零硬编码色） ───────────────────────────────────────────────

const STYLE_ID = 'xg-theme-style'
const STYLE = `
.xg-cards { display:flex; flex-direction:column; gap:12px; padding:12px; font-family:var(--dsw-font-family); }
.xg-card { border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-2); box-shadow:var(--dsw-shadow-lv2); overflow:hidden; }
.xg-card-head { padding:7px 14px; font:var(--dsw-font-xs-strong-13); color:var(--dsw-alias-label-secondary); border-bottom:1px solid var(--dsw-alias-border-l2); display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; }
.xg-card-body { padding:10px 14px; }
.xg-num { font-size:22px; font-weight:600; color:var(--dsw-alias-label-primary); font-family:var(--dsw-font-family); line-height:1.1; }
.xg-label { font:var(--dsw-font-xxs-12); color:var(--dsw-alias-label-tertiary); }
.xg-row { display:flex; gap:20px; flex-wrap:wrap; }
.xg-kv { display:flex; flex-direction:column; gap:2px; }
.xg-list { display:flex; flex-direction:column; gap:4px; font:var(--dsw-font-xxs-12); color:var(--dsw-alias-label-secondary); }
.xg-path { font-family:Consolas,Menlo,monospace; color:var(--dsw-alias-label-secondary); word-break:break-all; }
.xg-badge { padding:1px 8px; border-radius:99px; font-size:11px; white-space:nowrap; }
.xg-badge-modified { background:var(--dsw-alias-state-business-tertiary); color:var(--dsw-alias-state-business-primary); }
.xg-badge-created { background:var(--dsw-alias-state-success-tertiary); color:var(--dsw-alias-state-success-primary); }
.xg-badge-deleted { background:var(--dsw-alias-state-warn-tertiary); color:var(--dsw-alias-state-warn-label); }
.xg-btn { border:1px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-secondary); border-radius:6px; padding:2px 10px; font:var(--dsw-font-xxs-12); cursor:pointer; }
.xg-btn:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }
.xg-btn-active { border-color:var(--dsw-alias-state-business-primary); color:var(--dsw-alias-state-business-primary); }
.xg-btn:disabled { opacity:.45; cursor:default; }
.xg-select { background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:2px 6px; font:var(--dsw-font-xxs-12); }
.xg-input { background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:2px 6px; font:var(--dsw-font-xxs-12); min-width:180px; }
.xg-table { width:100%; border-collapse:collapse; font:var(--dsw-font-xxs-12); }
.xg-table td { padding:5px 8px; border-bottom:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); vertical-align:middle; }
.xg-tooltip { position:absolute; background:var(--dsw-alias-bg-layer-3); border:1px solid var(--dsw-alias-border-l2); border-radius:8px; box-shadow:var(--dsw-shadow-lv3); padding:8px 10px; font:var(--dsw-font-xxs-12); color:var(--dsw-alias-label-primary); z-index:5; pointer-events:none; white-space:pre-wrap; }
.xg-empty { padding:10px 0; font:var(--dsw-font-xxs-12); color:var(--dsw-alias-label-tertiary); }
/* M4.1：分栏栅格——6 列（摘要行 3+3；主区 4+2），<1200px 回退单列（占满不留白） */
.xg-grid { display:grid; grid-template-columns:repeat(6, 1fr); gap:12px; }
.xg-grid > .xg-span3 { grid-column:span 3; }
.xg-grid > .xg-span4 { grid-column:span 4; }
.xg-grid > .xg-span2 { grid-column:span 2; }
@media (max-width:1199px) {
  .xg-grid { grid-template-columns:1fr; }
  .xg-grid > .xg-span2, .xg-grid > .xg-span3, .xg-grid > .xg-span4 { grid-column:auto; }
}
/* M4.2：曲线放大覆盖层（fixed 悬浮，不动官方代码；z-index 高于 view 区） */
.xg-overlay { position:fixed; inset:0; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; z-index:1000; }
.xg-overlay-inner { background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l2); border-radius:12px; padding:16px 20px; max-width:1180px; width:calc(100vw - 80px); max-height:calc(100vh - 80px); overflow:auto; }
.xg-overlay-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; gap:12px; }
/* M4.4：口径注记（Fact First——图上明说事实与边界，镜 v0 启发） */
.xg-note { padding:8px 12px; font:var(--dsw-font-xxs-12); color:var(--dsw-alias-label-tertiary); background:var(--dsw-alias-bg-layer-1); border-radius:6px; margin-top:10px; }
.xg-warn { color:var(--dsw-alias-state-warn-primary); }
/* M3-UI.2+: tab 激活时隐藏输入卡（[data-composer-seat] 为官方稳定锚点，皮肤同款选择器；
   组件挂载 ⇔ tab 激活（view ring only:activeId），body 类由 useHideComposer 挂/卸载。 */
body.xg-hide-input [data-composer-seat] { display: none !important; }
/* M4-L：L 场指向条 + 可展开分析 */
.xg-lf-bar { grid-column:1 / -1; display:flex; align-items:center; gap:8px; flex-wrap:wrap; font:var(--dsw-font-xxs-12); color:var(--dsw-alias-label-secondary); }
.xg-lf-bar b { color:var(--dsw-alias-label-primary); font-weight:600; }
.xg-details { font:var(--dsw-font-xxs-12); color:var(--dsw-alias-label-secondary); margin-top:8px; }
.xg-details summary { cursor:pointer; color:var(--dsw-alias-label-tertiary); user-select:none; }
`

let styleInjected = false
function injectStyle(): void {
  if (styleInjected || typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) { styleInjected = true; return }
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = STYLE
  document.head.appendChild(el)
  styleInjected = true
}

/** tab 激活（组件挂载）时隐藏输入卡；卸载（切回对话）恢复。 */
function useHideComposer(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    document.body.classList.add('xg-hide-input')
    return () => document.body.classList.remove('xg-hide-input')
  }, [])
}

// ── 工具 ────────────────────────────────────────────────────────────────────

function pct(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(1)}%`
}
function fmtK(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}
function shortSession(s: string): string {
  return s.replace(/^session-/, '').slice(0, 8)
}
/** 路径末段（短名用）。 */
function baseName(p: string): string {
  const parts = p.replaceAll('\\', '/').split('/').filter((x) => x !== '')
  return parts[parts.length - 1] ?? p
}
/**
 * M4.2：紧凑图响应宽度——容器实测（Resize 监听），不再硬编码 560；
 * 回退值给左列卡内最小值。expand 态不走此 hook（覆盖层定宽）。
 */
function useChartWidth(fallback: number): { ref: (el: Element | null) => void; w: number } {
  const [w, setW] = useState(fallback)
  const node = { current: null as HTMLElement | null }
  const measure = (): void => {
    if (node.current) setW(Math.max(Math.min(node.current.clientWidth - 64, 1400), 320))
  }
  const ref = (el: Element | null): void => {
    if (el === node.current) return
    if (node.current) window.removeEventListener('resize', measure)
    node.current = el as HTMLElement | null
    if (el) {
      measure()
      // 布局未定（栅格未铺开）时 clientWidth 可能为 0——挂载后再测两次
      setTimeout(measure, 0)
      setTimeout(measure, 350)
      window.addEventListener('resize', measure)
    }
  }
  return { ref, w }
}
function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function hashIdx(s: string, n: number): number {
  let h = 0
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h % n
}
// 会话分色板（皮肤静态色 + hex 兜底；仅曲线识别用）
const PALETTE = [
  'var(--dsw-static-blue-450, #00cfff)',
  'var(--dsw-static-amber-500, #ffd600)',
  'var(--dsw-static-green-500, #4caf50)',
  'var(--dsw-static-purple-400, #b388ff)',
  'var(--dsw-static-pink-400, #ff80ab)',
  'var(--dsw-static-teal-400, #4dd0e1)',
]
const colorOf = (session: string): string => PALETTE[hashIdx(session, PALETTE.length)]

// ── 通用小组件 ───────────────────────────────────────────────────────────────

function Card(props: { title: string; extra?: ReactNode; children: ReactNode }): ReactNode {
  return createElement('div', { className: 'xg-card' },
    createElement('div', { className: 'xg-card-head' },
      createElement('span', undefined, props.title),
      props.extra ?? null,
    ),
    createElement('div', { className: 'xg-card-body' }, props.children),
  )
}

function Kv(props: { label: string; value: string; accent?: boolean }): ReactNode {
  return createElement('div', { className: 'xg-kv' },
    createElement('div', { className: 'xg-label' }, props.label),
    createElement('div', { className: 'xg-num', style: props.accent ? { color: 'var(--dsw-alias-state-business-primary)' } : undefined }, props.value),
  )
}

function Badge(props: { kind: string }): ReactNode {
  const cls = props.kind === 'created' ? 'xg-badge xg-badge-created'
    : props.kind === 'deleted' ? 'xg-badge xg-badge-deleted'
    : 'xg-badge xg-badge-modified'
  return createElement('span', { className: cls }, props.kind)
}

// ── 图表（SVG：网格/渐变面积/分色/图例/hover） ────────────────────────────────

type SeriesPoint = { x: number; value: number; detail: string; meta: { session: string; turn: number } }
type Series = { id: string; color: string; label: string; points: SeriesPoint[] }

function LineChart(props: { series: Series[]; w: number; h: number; onOpenDetail?: (meta: { session: string; turn: number }) => void }): ReactNode {
  const { series, w, h } = props
  const [hover, setHover] = useState<{ si: number; pi: number } | null>(null)
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null)
  injectStyle()
  const all = series.flatMap((s) => s.points.map((p) => p.value))
  if (all.length === 0) return createElement('div', { className: 'xg-empty' }, '（暂无数据）')

  const max = Math.max(...all)
  const min = Math.min(...all)
  const span = max - min || 1
  const padL = 44
  const padR = 10
  const padT = 18
  const padB = 20
  const px = (x: number): number => {
    // 每个系列的点按所属系列内 index 均分（简单近似，日期视图已按时序）
    return padL + (x * (w - padL - padR))
  }
  const py = (v: number): number => h - padB - ((v - min) / span) * (h - padT - padB)
  const ticks = [0, 1 / 3, 2 / 3, 1].map((t) => min + t * span)

  // M4-B.2：点位精确命中——以标记为圆心（10px 命中半径）取 2D 最近点，不再整列扫描
  const hitTest = (mx: number, my: number): { si: number; pi: number } | null => {
    let best: { si: number; pi: number; d: number } | null = null
    for (let si = 0; si < series.length; si += 1) {
      for (let pi = 0; pi < series[si].points.length; pi += 1) {
        const p = series[si].points[pi]
        const dx = px(p.x) - mx
        const dy = py(p.value) - my
        const d2 = dx * dx + dy * dy
        if (d2 <= 100 && (best === null || d2 < best.d)) best = { si, pi, d: d2 }
      }
    }
    return best === null ? null : { si: best.si, pi: best.pi }
  }

  const hovered = hover !== null ? series[hover.si]?.points[hover.pi] : null
  return createElement('div', { style: { position: 'relative', width: w } },
    createElement('svg', {
      width: w, height: h, viewBox: `0 0 ${w} ${h}`,
      style: { background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 8 },
      onMouseMove: (e: { clientX: number; clientY: number; currentTarget: { getBoundingClientRect(): { left: number; top: number } } }) => {
        const rect = e.currentTarget.getBoundingClientRect()
        const mx = e.clientX - rect.left
        const my = e.clientY - rect.top
        setTip({ x: mx, y: my })
        setHover(hitTest(mx, my))
      },
      onMouseLeave: () => { setHover(null); setTip(null) },
    },
      ticks.map((t) => createElement('g', { key: String(t) },
        createElement('line', { x1: padL, y1: py(t), x2: w - padR, y2: py(t), stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1 }),
        createElement('text', { x: padL - 6, y: py(t) + 3, fill: 'var(--dsw-alias-label-tertiary)', fontSize: 9, textAnchor: 'end' }, t >= 1e6 ? `${(t / 1e6).toFixed(1)}M` : t >= 1000 ? `${(t / 1000).toFixed(1)}K` : t.toFixed(2)),
      )),
      series.map((s, si) => {
        const pts = s.points
        if (pts.length === 0) return null
        const poly = pts.map((p, pi) => `${px(p.x)},${py(p.value)}`).join(' ')
        const area = `${padL},${h - padB} ${poly} ${px(pts[pts.length - 1].x)},${h - padB}`
        return createElement('g', { key: s.id },
          createElement('defs', null,
            createElement('linearGradient', { id: `xg-grad-${si}`, x1: 0, y1: 0, x2: 0, y2: 1 },
              createElement('stop', { offset: '0%', stopColor: s.color, stopOpacity: 0.35 }),
              createElement('stop', { offset: '100%', stopColor: s.color, stopOpacity: 0.02 }),
            ),
          ),
          createElement('polygon', { points: area, fill: `url(#xg-grad-${si})` }),
          pts.length > 1 ? createElement('polyline', { points: poly, fill: 'none', stroke: s.color, strokeWidth: 1.6 }) : null,
          pts.map((p, pi) => createElement('circle', {
            key: `${s.id}-${pi}`,
            cx: px(p.x), cy: py(p.value),
            r: hover !== null && hover.si === si && hover.pi === pi ? 4.5 : 2.2,
            fill: s.color,
            stroke: hover !== null && hover.si === si && hover.pi === pi ? 'var(--dsw-alias-label-primary)' : 'none',
            strokeWidth: hover !== null && hover.si === si && hover.pi === pi ? 1.2 : 0,
            cursor: 'pointer',
            onClick: () => { if (props.onOpenDetail) props.onOpenDetail(p.meta) },
          })),
        )
      }),
    ),
    hovered !== null && hover !== null && tip !== null
      ? createElement('div', {
          className: 'xg-tooltip',
          style: {
            left: tip.x,
            top: tip.y > 96 ? tip.y - 10 : tip.y + 14,
            transform: tip.y > 96 ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
          },
        },
          createElement('div', null, hovered.detail),
          createElement('div', { style: { marginTop: 4, color: 'var(--dsw-alias-label-tertiary)' } },
            props.onOpenDetail === undefined ? '（B 方案预留）' : '点击点位 → 查看完整问答'),
        )
      : null,
    series.length > 1
      ? createElement('div', { style: { display: 'flex', gap: 12, paddingTop: 4, flexWrap: 'wrap', fontSize: 11 } },
          series.map((s) => createElement('span', { key: s.id, style: { color: 'var(--dsw-alias-label-secondary)' } },
            createElement('span', { style: { display: 'inline-block', width: 8, height: 8, borderRadius: 99, background: s.color, marginRight: 4 } }),
            s.label,
          )),
        )
      : null,
  )
}

// ── Tab① Vault 观测 ──────────────────────────────────────────────────────────

function NexusView(): ReactNode {
  const [state, setState] = useState<NexusState | null>(null)
  const [vault, setVault] = useState<VaultInfo | null>(null)
  const [failed, setFailed] = useState(false)
  const [range, setRange] = useState<'today' | 'week'>('today')
  const [kindFilter, setKindFilter] = useState<'all' | 'created' | 'modified' | 'deleted'>('all')
  const [editMode, setEditMode] = useState(false)
  const [newRoot, setNewRoot] = useState('')
  const [busy, setBusy] = useState(false)
  injectStyle()
  useHideComposer()

  const load = (): void => {
    fetch('/api/nexus/state', { headers: { 'sec-fetch-site': 'same-origin' } })
      .then((r) => (r.ok ? (r.json() as Promise<NexusState>) : Promise.resolve(null)))
      .then((s) => { setState(s); setFailed(s === null) })
      .catch(() => { setState(null); setFailed(true) })
    fetch('/api/nexus/vault', { headers: { 'sec-fetch-site': 'same-origin' } })
      .then((r) => (r.ok ? (r.json() as Promise<VaultInfo>) : Promise.resolve(null)))
      .then((v) => { if (v) setVault(v) })
      .catch(() => undefined)
  }

  useEffect(() => {
    load()
    const timer = setInterval(load, 30000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applyVault = (): void => {
    // 二次确认（切换后仅显示新库数据；旧数据保留可回切——观测记录不可逆，不删除）
    if (!window.confirm('切换后仅显示新 vault 数据；旧数据保留，可回切查看。确认切换？')) return
    setBusy(true)
    fetch('/api/nexus/vault', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: newRoot }),
    }).then((r) => (r.ok ? r.json() : Promise.resolve(null)))
      .then((v) => { if (v) { setEditMode(false); setNewRoot(''); load() } })
      .catch(() => undefined)
      .finally(() => setBusy(false))
  }

  if (failed && state === null) return createElement('div', { className: 'xg-empty' }, 'Vault 观测数据不可用（/api/nexus/state）')
  if (state === null) return createElement('div', { className: 'xg-empty' }, 'Vault 观测加载中...')

  const summary = range === 'today' ? state.today : state.week
  const recent = state.recent.filter((e) => kindFilter === 'all' || e.kind === kindFilter)
  // OQ-M4-1：总览卡标题 = 指向短名（displayName ?? 路径末段）+ 工作区（root 路径）
  const shortName = state.activeRoot === '' ? '未指向'
    : (vault?.known.find((k) => k.root === state.activeRoot)?.displayName ?? baseName(state.activeRoot))
  return createElement('div', { className: 'xg-cards' },
    Card({
      title: '指向确认（Vault 观测）',
      extra: !editMode && state.activeRoot !== ''
        ? createElement('button', { className: 'xg-btn', onClick: () => { setNewRoot(state.activeRoot); setEditMode(true) } }, '修改指向')
        : null,
      children: vault === null
        ? createElement('div', { className: 'xg-empty' }, '指向加载中...')
        : createElement('div', null,
            createElement('div', { className: 'xg-row' },
              createElement('div', { className: 'xg-list' },
                createElement('span', { className: 'xg-label' }, '当前指向'),
                createElement('span', { className: 'xg-path' }, vault.active === '' ? '（未指向）' : vault.active),
              ),
              vault.active === ''
                ? createElement('span', { className: 'xg-warn' }, '请先确认 vault 指向——观测数据将从指向后开始')
                : createElement('div', { className: 'xg-list' },
                    createElement('span', { className: 'xg-label' },
                      `${vault.exists ? '目录在' : '目录缺失'} · ${vault.readable ? '可读' : '不可读'}`,
                    ),
                    vault.known.find((k) => k.root === vault.active)?.confirmedAt
                      ? createElement('span', { className: 'xg-label' },
                          `确认于 ${fmtTime(vault.known.find((k) => k.root === vault.active)!.confirmedAt ?? 0)}`,
                        )
                      : null,
                  ),
            ),
            createElement('div', { className: 'xg-note' },
              '数据口径：本页统计（文件/字数/编辑事件）仅来自指向 vault；L 场读数有独立指向（历史读数归属指向语境，基线见 L 场读数页）。',
            ),
            editMode
              ? createElement('div', { style: { marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 } },
                  createElement('input', {
                    className: 'xg-input', value: newRoot, placeholder: '绝对路径（如 L:\\...\\L-theory）',
                    onChange: (e: { target: { value: string } }) => setNewRoot(e.target.value),
                  }),
                  createElement('select', {
                    className: 'xg-select', value: '',
                    onChange: (e: { target: { value: string } }) => { if (e.target.value !== '') { setNewRoot(e.target.value) } },
                  },
                    createElement('option', { value: '' }, '最近指向…'),
                    vault.known.filter((k) => k.root !== vault.active).map((k) =>
                      createElement('option', { key: k.root, value: k.root }, k.displayName ?? baseName(k.root))),
                  ),
                  createElement('button', {
                    className: 'xg-btn', disabled: busy || newRoot.trim() === '', onClick: () => applyVault(),
                  }, busy ? '切换中…' : '确认并重扫'),
                  createElement('button', { className: 'xg-btn', onClick: () => { setEditMode(false); setNewRoot('') } }, '取消'),
                )
              : null,
          ),
    }),
    Card({ title: `Vault 总览 · ${shortName}${state.activeRoot !== '' ? `（${state.activeRoot}）` : ''}`, children: createElement('div', { className: 'xg-row' },
      Kv({ label: '文件总数', value: String(state.totals.totalFiles) }),
      Kv({ label: '总字数', value: fmtK(state.totals.totalChars) }),
    ) }),
    Card({
      title: '编辑统计',
      extra: createElement('div', null,
        createElement('button', { className: `xg-btn${range === 'today' ? ' xg-btn-active' : ''}`, onClick: () => setRange('today'), style: { marginRight: 6 } }, '今日'),
        createElement('button', { className: `xg-btn${range === 'week' ? ' xg-btn-active' : ''}`, onClick: () => setRange('week') }, '本周'),
      ),
      children: createElement('div', { className: 'xg-row' },
        Kv({ label: '编辑次数', value: String(summary.edits) }),
        Kv({ label: '修改文件', value: String(summary.modifiedFiles) }),
        Kv({ label: '新增文件', value: `+${summary.createdFiles}` }),
      ),
    }),
    Card({
      title: '活跃文件 Top 5',
      children: summary.topActive.length === 0
        ? createElement('div', { className: 'xg-empty' }, '暂无')
        : createElement('div', { className: 'xg-list' },
            summary.topActive.map((t) => createElement('div', { key: t.path },
              createElement('span', { className: 'xg-label' }, `${t.edits} 次 · `),
              createElement('span', { className: 'xg-path' }, t.path),
            )),
          ),
    }),
    Card({
      title: '最近编辑流',
      extra: createElement('select', {
        className: 'xg-select',
        value: kindFilter,
        onChange: (e: { target: { value: string } }) => setKindFilter(e.target.value as 'all' | 'created' | 'modified' | 'deleted'),
      },
        createElement('option', { value: 'all' }, '全部'),
        createElement('option', { value: 'created' }, '新建'),
        createElement('option', { value: 'modified' }, '修改'),
        createElement('option', { value: 'deleted' }, '删除'),
      ),
      children: recent.length === 0
        ? createElement('div', { className: 'xg-empty' }, '暂无')
        : createElement('div', { className: 'xg-list' },
            recent.slice(0, 12).map((e) => createElement('div', { key: `${e.ts}-${e.path}` },
              createElement('span', { className: 'xg-label' }, `[${fmtTime(e.ts)}] `),
              createElement(Badge, { kind: e.kind }),
              createElement('span', { style: { marginLeft: 6 } }),
              createElement('span', { className: 'xg-path' }, e.path),
            )),
          ),
    }),
  )
}

// ── Tab② L 场读数 ────────────────────────────────────────────────────────────

function NexusLFieldView(): ReactNode {
  const [state, setState] = useState<M2State | null>(null)
  const [lfield, setLfield] = useState<LfieldInfo | null>(null)
  const [viewMode, setViewMode] = useState<'vault' | 'all'>('vault')
  const [ann, setAnn] = useState<AnnotationsState | null>(null)
  const [failed, setFailed] = useState(false)
  const [axis, setAxis] = useState<'date' | 'turn'>('date')
  const [metric, setMetric] = useState<'miss' | 'tps' | 'cum'>('miss')
  const [chartMode, setChartMode] = useState<'compact' | 'expanded'>('compact')
  const { ref: chartRef, w: chartW } = useChartWidth(560)
  const [windowDays, setWindowDays] = useState<number>(7)
  const [sessionSel, setSessionSel] = useState<string>('')
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [analysis, setAnalysis] = useState<AnalysisResult[] | null>(null)
  const [textDetail, setTextDetail] = useState<TurnTextResp | null>(null)
  injectStyle()
  useHideComposer()

  // M4.11：视图两态——?root=all 全局（全部工作区）| 默认 = 当前 vault 指向
  const viewQ = viewMode === 'all' ? '?root=all' : ''
  const load = (): void => {
    fetch(`/api/nexus/m2/state${viewQ}`, { headers: { 'sec-fetch-site': 'same-origin' } })
      .then((r) => (r.ok ? (r.json() as Promise<M2State>) : Promise.resolve(null)))
      .then((s) => { setState(s); setFailed(s === null) })
      .catch(() => { setState(null); setFailed(true) })
    fetch('/api/nexus/lfield', { headers: { 'sec-fetch-site': 'same-origin' } })
      .then((r) => (r.ok ? (r.json() as Promise<LfieldInfo>) : Promise.resolve(null)))
      .then((l) => { if (l) setLfield(l) })
      .catch(() => undefined)
    fetch('/api/nexus/m2/annotations', { headers: { 'sec-fetch-site': 'same-origin' } })
      .then((r) => (r.ok ? (r.json() as Promise<AnnotationsState>) : Promise.resolve(null)))
      .then((a) => { if (a) { setAnn(a); const m: Record<string, string> = {}; for (const x of a.annotations) if (x.note) m[x.prophecy] = x.note; setNotes(m) } })
      .catch(() => undefined)
    fetch(`/api/nexus/m2/analysis${viewQ}`, { headers: { 'sec-fetch-site': 'same-origin' } })
      .then((r) => (r.ok ? (r.json() as Promise<{ results: AnalysisResult[] }>) : Promise.resolve(null)))
      .then((a) => { if (a) setAnalysis(a.results) })
      .catch(() => undefined)
  }

  const openTurnText = (meta: { session: string; turn: number }): void => {
    fetch(`/api/nexus/m2/turn-text?session=${encodeURIComponent(meta.session)}&turn=${meta.turn}`, { headers: { 'sec-fetch-site': 'same-origin' } })
      .then((r) => (r.ok ? (r.json() as Promise<TurnTextResp>) : Promise.resolve(null)))
      .then((t) => { if (t) setTextDetail(t) })
      .catch(() => setTextDetail(null))
  }

  // M4.2：放大打开期间暂停轮询（防底层数据变化致 hover 错位）；关闭恢复并刷新一次
  useEffect(() => {
    if (chartMode === 'expanded') return undefined
    load()
    const timer = setInterval(load, 120000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartMode, viewMode])
  // Esc 关闭放大
  useEffect(() => {
    if (chartMode !== 'expanded') return undefined
    const h = (e: { key: string }): void => { if (e.key === 'Escape') setChartMode('compact') }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [chartMode])

  if (failed && state === null) return createElement('div', { className: 'xg-empty' }, 'L 场读数不可用（/api/nexus/m2/state）')
  if (state === null) return createElement('div', { className: 'xg-empty' }, 'L 场读数加载中...')

  // 口径：usage.inputTokens = 未命中；总输入 = input + cache
  const totalIn = (p: M2Point): number => p.tokenIn + p.cacheRead
  const missRate = (p: M2Point): number => (totalIn(p) > 0 ? p.tokenIn / totalIn(p) : 0)
  const hitRateOf = (p: M2Point): number | null => (totalIn(p) > 0 ? p.cacheRead / totalIn(p) : null)

  // M4-L：序列号只在展开面板显示——紧凑视图（选择器/图例/悬停）用「日期 · 轮数」友好标签
  const serialShown = chartMode === 'expanded'
  const pad2 = (n: number): string => String(n).padStart(2, '0')
  const friendlyOf = (sid: string): string => {
    const m = state.sessionMeta[sid]
    if (m === undefined) return shortSession(sid)
    const d = new Date(m.startTs)
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())} · ${m.turns}轮`
  }

  const fromTs = Date.now() - windowDays * 86400000
  const windowed = state.curve.filter((p) => p.ts >= fromTs)
  const sessions = [...new Set(windowed.map((p) => p.session))]
  const sel = sessionSel !== '' && sessions.includes(sessionSel) ? sessionSel : null
  // M4.4（镜启发）：两视图统一「全部会话 + 单会话」聚焦（长窗多会话曲线过乱）
  const showSessions = sel !== null ? [sel] : sessions

  // M4-B.2：简略看板——仅此轮简要数据（问句经点击查看完整问答，不进看板）
  const detailOf = (p: M2Point): string => [
    `${axis === 'date' ? fmtTime(p.ts) : 'turn ' + p.turn}${serialShown ? ' · ' + shortSession(p.session) : ''}`,
    `输入 ${fmtK(totalIn(p))}（命中 ${fmtK(p.cacheRead)} / 未命中 ${fmtK(p.tokenIn)}） out ${fmtK(p.tokenOut)}`,
    `命中率 ${pct(hitRateOf(p))} · A 投影 ${pct(missRate(p))} · TPS ${p.tps === null ? '—' : p.tps.toFixed(1)}`,
  ].join('\n')

  const series: Series[] = showSessions.map((sid) => {
    const pts = windowed.filter((p) => p.session === sid)
    let acc = 0
    return {
      id: sid,
      color: colorOf(sid),
      label: serialShown ? shortSession(sid) : friendlyOf(sid),
      points: pts.map((p, i) => {
        // M4.4（镜启发·弱代理）：累计输入 = Σ(命中+未命中) 按轮序；中段加速平台 = S 形候选
        if (metric === 'cum') acc += totalIn(p)
        const value = metric === 'miss' ? missRate(p) : metric === 'tps' ? (p.tps ?? 0) : acc
        return {
          x: (i + (1 / 2)) / Math.max(pts.length, 1),
          value,
          detail: metric === 'cum'
            ? `${axis === 'date' ? fmtTime(p.ts) : 'turn ' + p.turn}${serialShown ? ' · ' + shortSession(p.session) : ''} · 累计输入 ${fmtK(acc)}`
            : detailOf(p),
          meta: { session: p.session, turn: p.turn },
        }
      }),
    }
  })

  // M4-B：自评覆盖（当前视图口径；选中会话时带缺口轮号）
  const sc = state.selfcheck
  const scPct = sc.total > 0 ? sc.checked / sc.total : null
  const scSel = sel !== null ? sc.bySession[sel] : undefined

  const t = state.totals
  const latest = state.latest
  const miss = 1 - (t.hitRate ?? 0)
  const annMap = new Map<string, Annotation>((ann?.annotations ?? []).map((a) => [a.prophecy, a]))
  const DEF_LABEL: Record<string, string> = { none: '无', light: '轻', heavy: '重' }

  const saveAnn = (prophecy: string, status: string, note: string): void => {
    fetch('/api/nexus/m2/annotations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prophecy, status, note: note.trim() === '' ? null : note }),
    }).then((r) => (r.ok ? load() : undefined)).catch(() => undefined)
  }

  // M4.11：独立指向——切换仅改变「新会话」的归属；既有会话归属不变
  const lfieldLabel = lfield === null ? '…'
    : (lfield.known.find((k) => k.root === lfield.active)?.displayName ?? baseName(lfield.active))
  const vaultSessions = lfield === null || lfield.active === '' ? 0 : (lfield.counts[lfield.active] ?? 0)
  const switchLfield = (root: string): void => {
    if (!window.confirm('切换后新会话读数归入新指向；既有会话归属不变。确认切换 L 场指向？')) return
    fetch('/api/nexus/lfield', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root }),
    }).then((r) => { if (r.ok) { setViewMode('vault'); load() } }).catch(() => undefined)
  }

  return createElement('div', { className: 'xg-cards xg-grid' },
    createElement('div', { className: 'xg-lf-bar' },
      createElement('span', null, 'L 场指向：'),
      createElement('b', null, lfieldLabel),
      lfield !== null && lfield.known.filter((k) => k.root !== lfield.active).length > 0
        ? createElement('select', {
            className: 'xg-select', value: '',
            onChange: (e: { target: { value: string } }) => { if (e.target.value !== '') switchLfield(e.target.value) },
          },
            createElement('option', { value: '' }, '切换指向…'),
            lfield.known.filter((k) => k.root !== lfield.active).map((k) =>
              createElement('option', { key: k.root, value: k.root }, k.displayName ?? baseName(k.root))),
          )
        : null,
      createElement('span', { style: { marginLeft: 8 } }, '视图'),
      createElement('select', {
        className: 'xg-select', value: viewMode,
        onChange: (e: { target: { value: string } }) => setViewMode(e.target.value as 'vault' | 'all'),
      },
        createElement('option', { value: 'vault' }, `${lfieldLabel}（${vaultSessions} 会话）`),
        createElement('option', { value: 'all' }, '全局'),
      ),
      viewMode === 'all'
        ? createElement('span', { className: 'xg-label' }, '全局视图——全部工作区会话（含 vault 会话）。')
        : createElement('span', { className: 'xg-label' }, `vault 视图——在 ${lfieldLabel} 工作区发起的会话。`),
    ),
    createElement('div', { className: 'xg-span3' },
    Card({
      title: '最新读数',
      children: latest === null
        ? createElement('div', { className: 'xg-empty' }, '（等待知识库会话——在指向工作区发起的对话将归入此处）')
        : createElement('div', null,
            createElement('div', { className: 'xg-row' },
              Kv({ label: `turn ${latest.turn} · ${shortSession(latest.session)}`, value: fmtK(totalIn(latest)) }),
              Kv({ label: '未命中 / 命中', value: `${fmtK(latest.tokenIn)} / ${fmtK(latest.cacheRead)}` }),
              Kv({ label: '输出', value: fmtK(latest.tokenOut) }),
              Kv({ label: '命中率', value: pct(hitRateOf(latest)) }),
              Kv({ label: 'A 投影（未命中率）', value: pct(missRate(latest)), accent: true }),
              Kv({ label: 'TPS', value: latest.tps === null ? '—' : latest.tps.toFixed(1) }),
            ),
            latest.clarity !== null && latest.clarity !== undefined
              ? createElement('div', { className: 'xg-list', style: { marginTop: 8 } },
                  createElement('span', { className: 'xg-path' },
                    `自评（M3-F.1）：clarity ${latest.clarity.toFixed(2)} · defense ${DEF_LABEL[latest.defense ?? 'none'] ?? latest.defense} · declaration ${latest.declaration === 1 ? '有' : '无'}`,
                  ),
                )
              : null,
          ),
    }),
    ),
    createElement('div', { className: 'xg-span3' },
    Card({
      title: `总量 · ${viewMode === 'all' ? '全局' : lfieldLabel}`,
      children: createElement('div', { className: 'xg-row' },
        Kv({ label: '轮次', value: String(t.turns) }),
        Kv({ label: '输入（命中/未命中）', value: `${fmtK(t.cacheRead)} / ${fmtK(t.missToken)}` }),
        Kv({ label: '输出', value: fmtK(t.tokenOut) }),
        Kv({ label: '总命中率', value: pct(t.hitRate) }),
        Kv({ label: 'A 投影（未命中率）', value: pct(miss), accent: true }),
      ),
    }),
    ),
    createElement('div', { className: 'xg-span4' },
    Card({
      title: `探索率曲线 · ${METRIC_LABEL[metric]}`,
      extra: createElement('div', null,
        createElement('button', { className: `xg-btn${axis === 'date' ? ' xg-btn-active' : ''}`, onClick: () => setAxis('date'), style: { marginRight: 6 } }, '日期'),
        createElement('button', { className: `xg-btn${axis === 'turn' ? ' xg-btn-active' : ''}`, onClick: () => setAxis('turn'), style: { marginRight: 6 } }, '轮次'),
        createElement('button', { className: `xg-btn${metric === 'miss' ? ' xg-btn-active' : ''}`, onClick: () => setMetric(metric === 'miss' ? 'tps' : metric === 'tps' ? 'cum' : 'miss'), style: { marginRight: 6 } }, METRIC_LABEL[metric]),
        createElement('select', { className: 'xg-select', value: String(windowDays), onChange: (e: { target: { value: string } }) => setWindowDays(Number(e.target.value)) },
          createElement('option', { value: '1' }, '今天'),
          createElement('option', { value: '3' }, '3 天'),
          createElement('option', { value: '7' }, '7 天'),
          createElement('option', { value: '30' }, '30 天'),
        ),
        createElement('button', { className: 'xg-btn', style: { marginLeft: 6 }, onClick: () => setChartMode(chartMode === 'expanded' ? 'compact' : 'expanded') }, chartMode === 'expanded' ? '还原' : '放大'),
      ),
      children: createElement('div', null,
        createElement('select', {
          className: 'xg-select', value: sel ?? '', style: { marginBottom: 6 },
          onChange: (e: { target: { value: string } }) => setSessionSel(e.target.value),
        },
          createElement('option', { value: '' }, '全部会话'),
          sessions.map((s) => createElement('option', { key: s, value: s }, friendlyOf(s))),
        ),
        createElement('div', { className: 'xg-list', style: { margin: '2px 0 6px' } },
          sc.total > 0
            ? createElement('span', { className: scPct < 0.8 ? 'xg-warn' : 'xg-label' },
                `自评覆盖 ${pct(scPct)}（${sc.checked}/${sc.total} 轮）`
                + (scSel !== undefined
                    ? ` · 本会话 ${scSel.checked}/${scSel.total} 轮${scSel.missing.length > 0 ? ` · 缺 ${scSel.missing.map((n) => 't' + n).join(' ')}` : ' · 无缺口'}`
                    : ''),
              )
            : createElement('span', { className: 'xg-label' }, '自评覆盖：本视图暂无轮次'),
        ),
        createElement('div', { ref: chartRef },
          createElement(LineChart, { series, w: chartW, h: 200, onOpenDetail: openTurnText }),
        ),
        analysis !== null && analysis.length > 0
          ? createElement('details', { key: 'xg-analysis', className: 'xg-details' },
              createElement('summary', null, `分析（M3-F.3 白盒）· ${analysis.length} 会话`),
              createElement('div', { className: 'xg-list', style: { marginTop: 6 } },
                analysis.map((a) => {
                  const shapeLabel = { unknown: '—', rising: '上升', falling: '下降', sigmoid: 'S 形', 'inverse-sigmoid': '反 S 形' }[a.shape]
                  const burst = a.burst ? `爆发段 turn ${a.burst.fromTurn}→${a.burst.toTurn}（${a.burst.direction === 'down' ? '降' : '升'}）` : '无爆发段'
                  return createElement('span', { key: a.session },
                    createElement('span', { className: 'xg-label' },
                      `${serialShown ? shortSession(a.session) : friendlyOf(a.session)}：形态=${shapeLabel} · ${burst} · τ_e=${a.tauE === null ? '—' : a.tauE + ' turn'} · `,
                    ),
                  )
                }),
              ),
            )
          : null,
        createElement('div', { className: 'xg-note' },
          metric === 'cum'
            ? '累计输入（弱代理）= Σ(命中+未命中) 按轮序；中段加速平台 = S 形候选（P1），正式判据仍以未命中率曲线为准。'
            : metric === 'miss'
              ? '未命中率 = inputTokens/(inputTokens+cacheRead) = A（对齐密度）在 token 空间的投影（正式腿）；长上下文/新话题会混杂抬高，与自评腿交叉受限。'
              : 'TPS = outputTokens / 解码耗时；与探索率曲线共同构成 P4 时间结构素材。',
        ),
        textDetail !== null
          ? createElement('div', { className: 'xg-card', style: { marginTop: 8 } },
              createElement('div', { className: 'xg-card-head' },
                createElement('span', undefined, `完整问答 · turn ${textDetail.turn} · ${textDetail.session ? shortSession(textDetail.session) : ''}`),
                createElement('button', { className: 'xg-btn', onClick: () => setTextDetail(null) }, '关闭'),
              ),
              createElement('div', { className: 'xg-card-body', style: { maxHeight: 240, overflow: 'auto' } },
                createElement('div', { className: 'xg-list' },
                  textDetail.found === false
                    ? createElement('span', { className: 'xg-label' }, '该轮原文未采集（B 方案自 M3-F.2 部署起前向积累；此轮早于部署）')
                    : null,
                  textDetail.userText
                    ? createElement('span', null,
                        createElement('span', { className: 'xg-label' }, '问：'),
                        createElement('span', { className: 'xg-path' }, textDetail.userText),
                      )
                    : null,
                  textDetail.assistantText
                    ? createElement('span', null,
                        createElement('span', { className: 'xg-label' }, '答：'),
                        createElement('span', { className: 'xg-path' }, textDetail.assistantText.slice(0, 4000)),
                      )
                    : null,
                ),
              ),
            )
          : null,
      ),
    }),
    ),
    createElement('div', { className: 'xg-span2' },
    Card({
      title: '预言检验表（框架先行 · 人工标注）',
      children: createElement('table', { className: 'xg-table' },
        createElement('tbody', null,
          Object.entries(PROPHECIES).map(([key, desc]) => {
            const a = annMap.get(key)
            const status = a?.status ?? 'pending'
            const note = notes[key] ?? a?.note ?? ''
            return createElement('tr', { key },
              createElement('td', { style: { width: '42%' } }, `${key} ${desc}`),
              createElement('td', null,
                createElement('select', {
                  className: 'xg-select', value: status,
                  onChange: (e: { target: { value: string } }) => saveAnn(key, e.target.value, note),
                },
                  Object.entries(STATUS_LABEL).map(([v, l]) => createElement('option', { key: v, value: v }, l)),
                ),
              ),
              createElement('td', null,
                createElement('input', {
                  className: 'xg-input', value: note, placeholder: '备注…',
                  onChange: (e: { target: { value: string } }) => setNotes({ ...notes, [key]: e.target.value }),
                }),
                createElement('button', {
                  className: 'xg-btn', style: { marginLeft: 6 },
                  onClick: () => saveAnn(key, status, note),
                }, '保存'),
              ),
            )
          }),
        ),
      ),
    }),
    ),
    chartMode === 'expanded'
      ? createElement('div', { className: 'xg-overlay', onClick: () => setChartMode('compact') },
          createElement('div', { className: 'xg-overlay-inner', onClick: (e: { stopPropagation(): void }) => e.stopPropagation() },
            createElement('div', { className: 'xg-overlay-head' },
              createElement('span', undefined, `${METRIC_LABEL[metric]}（放大）· ${axis === 'date' ? '日期视图' : '轮次视图'}`),
              createElement('button', { className: 'xg-btn', onClick: () => setChartMode('compact') }, '还原（Esc）'),
            ),
            createElement(LineChart, { series, w: 980, h: 460, onOpenDetail: openTurnText }),
          ),
        )
      : null,
  )
}

// ── tab 注册 ─────────────────────────────────────────────────────────────────

export const inject = ['slots']

export function apply(ctx: { slots: { inject(key: string, callback: () => unknown): unknown } }): void {
  injectStyle()
  ctx.effect(
    () => ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: '@dsh-external/dsh-nexus-panel',
        order: 30,
        label: () => 'Vault 观测',
      }, NexusView),
    ),
    '@dsh-external/dsh-nexus: panel',
  )
  ctx.effect(
    () => ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: '@dsh-external/dsh-nexus-lfield-panel',
        order: 35,
        label: () => 'L 场读数',
      }, NexusLFieldView),
    ),
    '@dsh-external/dsh-nexus: lfield panel',
  )
}
