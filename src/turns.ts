/**
 * @dsh-external/dsh-nexus — M2 官方会话事件采集（L 场读数数据层）。
 * 纯逻辑（零 cordis 依赖，可单测）：订阅 session/event 的
 *   turn/start（轮次指针）→ user/message（问答摘要）→ step/start（计时）
 *   → assistant/message（usage: inputTokens/outputTokens/cacheReadTokens + turn/step）
 * 按 (session, turn) 幂等聚合为 turn_read。与团队底座零耦合（官方事件直采）。
 */
import type { NexusStore } from './store.js'

/** 最小事件形态（官方 SessionEvent 的 duck-type 子集；避免新增 dsh-session 依赖）。 */
export interface TurnEventLike {
  type: string
  time?: number
  seq?: number
  data: Record<string, unknown>
}

interface UsageLike {
  inputTokens?: unknown
  outputTokens?: unknown
  cacheReadTokens?: unknown
}

const QUESTION_LEN = 80

/** 从 message content 块提取文本（text 块拼接，截 len）。 */
function textOf(content: unknown, len: number): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as { type?: unknown; text?: unknown }
      if (b.type === 'text' && typeof b.text === 'string') out += b.text
    }
  }
  return out.slice(0, len)
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export class TurnsCollector {
  /** step 计时：`session:turn:step` → step/start 时刻（assistant/message 时算生成耗时）。 */
  private readonly pendingSteps = new Map<string, number>()
  /** 当前轮问答摘要：session → 80 字（turn/start 时清空，user/message 时写入）。 */
  private readonly latestQuestion = new Map<string, string | null>()
  /** 当前轮指针：session → turn（user/message 无 turn 字段——按事件序归属，同 E-1 精神）。 */
  private readonly latestTurn = new Map<string, number>()
  /** M4-L：已打标会话（进程内去重；DB INSERT OR IGNORE 兜底重载/重启/多实例）。 */
  private readonly stamped = new Set<string>()

  constructor(private readonly store: NexusStore) {}

  handle(sessionId: string, ev: TurnEventLike, cwd?: string): void {
    // M4-L：会话首次落点 → 分类归属（cwd 在指向根下 = vault 会话；否则 '' = 不属于任何指向，只在全局视图出现）
    if (!this.stamped.has(sessionId)) {
      this.stamped.add(sessionId)
      this.store.classifySessionRoot(sessionId, cwd, typeof ev.time === 'number' ? ev.time : Date.now())
    }
    const time = typeof ev.time === 'number' ? ev.time : Date.now()
    switch (ev.type) {
      case 'turn/start': {
        const turn = num((ev.data as { turn?: unknown }).turn)
        if (turn !== undefined) this.latestTurn.set(sessionId, turn)
        // 新轮开始：重置问答摘要（无 user/message 时不残留上一轮）
        this.latestQuestion.set(sessionId, null)
        break
      }

      case 'user/message': {
        const content = (ev.data as { content?: unknown }).content
        const full = textOf(content, Infinity)
        const q = full.slice(0, QUESTION_LEN)
        if (q !== '') this.latestQuestion.set(sessionId, q)
        // M3-F.2（B 方案）：完整问题原文入 turn_text（按 turn 指针归属）
        const turn = this.latestTurn.get(sessionId)
        if (full !== '' && turn !== undefined) this.store.upsertUserText(sessionId, turn, full)
        break
      }

      case 'step/start': {
        const turn = num((ev.data as { turn?: unknown }).turn)
        const step = num((ev.data as { step?: unknown }).step)
        if (turn !== undefined && step !== undefined) {
          this.pendingSteps.set(`${sessionId}:${turn}:${step}`, time)
        }
        break
      }

      case 'assistant/message': {
        const d = ev.data as { turn?: unknown; step?: unknown; usage?: UsageLike; message?: { content?: unknown } }
        const turn = num(d.turn)
        const step = num(d.step)
        const usage = d.usage
        if (turn === undefined || step === undefined || usage === undefined) return
        const stepKey = `${sessionId}:${turn}:${step}`
        const startTs = this.pendingSteps.get(stepKey)
        if (startTs !== undefined) this.pendingSteps.delete(stepKey)
        const durationMs = startTs !== undefined ? Math.max(0, time - startTs) : null

        // 幂等：同一 step 事件只聚合一次（重启/重载/重复 emit 不重复计数）
        if (!this.store.marksStepSeen(sessionId, turn, step)) return

        // M3-F.2（B 方案）：assistant 全文累加（多 step 拼接；幂等由 step_seen 保证）
        const assistantFull = textOf((d.message as { content?: unknown } | undefined)?.content, Infinity)
        if (assistantFull !== '') this.store.appendAssistantText(sessionId, turn, assistantFull)

        this.store.upsertTurnRead({
          session: sessionId,
          turn,
          ts: time,
          question: this.latestQuestion.get(sessionId) ?? null,
          tokenIn: num(usage.inputTokens) ?? 0,
          tokenOut: num(usage.outputTokens) ?? 0,
          cacheRead: num(usage.cacheReadTokens) ?? 0,
          durationMs,
        })
        break
      }

      default:
        break // turn/end、step/end、tool/*、todo/write、request/*：M2 不消费
    }
  }
}
