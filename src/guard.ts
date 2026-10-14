/**
 * goal-guard 纯状态机 —— 无 harness 类型依赖，可独立单测。
 *
 * ## 要解决的问题（已在远端实测复现）
 *
 * DSH `goal-round-driver` 在 agent 回到 `idle` 且 goal 为 `active + armed` 时必然排队下一轮
 * `<goal_round>` 注入；它的 `readyToDrive` 只查 idle，**不知道还有未结算的后台子代理**
 * （`@deepseek-ai/dsh-goal-round-driver` 连 `subagents` 都不注入）。于是「派发后台子代理 →
 * 结束回合 → 等结算通知」这种委托纪律下，等待窗口内每一轮 idle 都会烧掉一个 goal 轮次。
 *
 * 模型工具层的 `update_goal(pause/resume)` 要求直接人类回合，模型自救不了；本守卫在宿主
 * 服务层代为治理：
 *
 *   - **派发点**：子代理诞生（`agent/created` 带 `origin='subagent'` + `parentSession`）→
 *     母会话 goal 若 `active + armed` → `goals.disarm`（进程内，不产生耐久事件、不改
 *     phase/revision），记 mark（goalId/revision/at）。此步在母会话仍 running 时完成，**零竞态**。
 *   - **等待窗口**（有 running 子代理）：goal 被重新武装（等待中才 arm / 人类手动 resume）→
 *     再次 disarm。
 *   - **结算**（idle 且无 running 子代理）：mark 未毒化、goal 仍 `active + disarmed` 且
 *     id/revision 与 mark 一致 → `goals.resume` 重新武装，恢复正常自动续跑。
 *
 * ## 安全不变量（宁可不 resume，绝不误 resume）
 *
 * `goals.resume` 在服务层没有人类门（人类门在工具层），所以本守卫只重新武装**自己刚 disarm
 * 过的、id+revision 完全一致、且仍为 `active + disarmed`** 的 goal。goal 被清 / 被编辑 /
 * complete / blocked / paused / 被第三方重新武装 → 一律清 mark 交人类，绝不猜。
 *
 * ## 判活依据
 *
 * 「还有子代理在跑」用 `subagents.listDescendants(parentSessionId)` 的行：**只有它**给每行补
 * `activity` 字段（`'running'` = 记录仍 live 于 `ctx.sessions`，含 send_message 冷恢复的
 * epoch2；`'inactive'` = 已 dispose）。`listChildren` 的返回类型根本没有 `activity`，拿它
 * 判活恒为 0（OMO 2026-10-03 实测故障）。查询失败返回 `null`（未知）——未知**不构成**
 * disarm 或 resume 的理由。
 */

/** goals 服务的只读视图（宽松形状，够守卫用即可）。 */
export interface GoalViewLike {
  id: string
  revision: number
  phase: string
  activation: string
}

/** `goals` 宿主服务的松类型面（compile-time 不依赖 @deepseek-ai/dsh-goal）。 */
export interface GoalsServiceLike {
  get(agent: unknown): GoalViewLike | undefined
  disarm(agent: unknown): GoalViewLike | undefined
  resume(agent: unknown, ref: { id: string; revision: number }): GoalViewLike | undefined
}

/** `subagents.listDescendants` 行的宽松形状（只取判活需要的字段）。 */
export interface SubagentRowLike {
  kind?: string
  activity?: string
  depth?: number
}

/** 我们主动 disarm 的标记：目标 goal 的精确修订。 */
export interface GuardMark {
  goalId: string
  revision: number
  at: number
}

/** 决策结果；`none` 带原因，便于诊断「为什么没动」。 */
export type GuardDecision =
  | { kind: 'disarm'; mark: GuardMark }
  | { kind: 'resume'; mark: GuardMark }
  | { kind: 'none'; reason: NoneReason }

export type NoneReason =
  /** 该 agent 不在守卫视野内（没派过子代理、也没被采纳）。 */
  | 'untracked'
  /** 还有子代理在跑，但 goal 不是 armed（无需动作，可能别人已 disarm）。 */
  | 'children-running'
  /** 检测到 driver 熔断信号，禁止自动 resume。 */
  | 'poisoned'
  /** 没有 mark：不是我们 disarm 的，不接管。 */
  | 'no-mark'
  /** goal 已不存在。 */
  | 'no-goal'
  /** goal 被清/被编辑：id 或 revision 与 mark 不符。 */
  | 'goal-changed'
  /** goal 已 complete/blocked/paused，或已被（第三方）重新武装。 */
  | 'not-disarmed'

export interface GuardSnapshot {
  agent: string
  tracked: boolean
  marked: boolean
  poisoned: boolean
  goalId: string | null
  revision: number | null
  /** mark 已存在多久（ms）；无 mark 为 null。 */
  sinceMs: number | null
}

interface GuardState {
  /** 我们 disarm 的 goal 标记；无标记则从不自动 resume。 */
  mark?: GuardMark
  /** 毒化：检测到 driver 故障信号，禁止自动 resume。 */
  poisoned: boolean
}

const activeArmed = (goal: GoalViewLike | undefined): goal is GoalViewLike =>
  goal !== undefined && goal.phase === 'active' && goal.activation === 'armed'

export class GoalGuard {
  private states = new Map<string, GuardState>()

  private stateFor(agentId: string): GuardState {
    let st = this.states.get(agentId)
    if (st === undefined) {
      st = { poisoned: false }
      this.states.set(agentId, st)
    }
    return st
  }

  /** 该 agent 是否在守卫视野内。 */
  has(agentId: string): boolean {
    return this.states.has(agentId)
  }

  /** 纳入视野（幂等）；返回是否新建。 */
  track(agentId: string): boolean {
    if (this.states.has(agentId)) return false
    this.states.set(agentId, { poisoned: false })
    return true
  }

  /** 当前 mark（无则 undefined）。 */
  markOf(agentId: string): GuardMark | undefined {
    return this.states.get(agentId)?.mark
  }

  /**
   * 派发点 / 采纳点：goal armed → 返回 disarm 意图（由调用方执行 disarm + recordDisarm）。
   * 新窗口清除上一窗口的毒化（新派发 = 新授权）。
   */
  disarmIntent(agentId: string, goal: GoalViewLike | undefined): GuardMark | undefined {
    const st = this.stateFor(agentId)
    if (!activeArmed(goal)) return undefined
    st.poisoned = false
    return { goalId: goal.id, revision: goal.revision, at: Date.now() }
  }

  /** 调用方完成 disarm 后登记 mark（幂等）。 */
  recordDisarm(agentId: string, mark: GuardMark): void {
    this.stateFor(agentId).mark = mark
  }

  /**
   * driver 故障信号（`agent/error`、回合 `max-tokens`/`aborted`）→ 毒化当前窗口，禁止后续
   * 自动 resume——不覆盖 harness 的熔断决定，留给人类。仅在已有 mark 或已毒化时生效。
   */
  poison(agentId: string, _reason: string): boolean {
    const st = this.states.get(agentId)
    if (st === undefined) return false
    if (st.mark !== undefined || st.poisoned) {
      st.poisoned = true
      st.mark = undefined
      return true
    }
    return false
  }

  /**
   * idle / 结算决策。`runningChildren` 由调用方经 `listDescendants` 汇总（见
   * `countRunningChildren`）；查询失败请**不要**调用本方法，直接按「未知」处理。
   *
   * - `runningChildren > 0`：等待窗口。goal armed → 返回 disarm（刷新 mark）；否则 none。
   *   （此处刷新 mark 但不清毒化——毒化只随新派发/新采纳清除。）
   * - `runningChildren === 0`：mark 有效、未毒化、goal 与 mark 匹配且 `active + disarmed`
   *   → resume；否则清 mark 结束窗口。
   */
  decideAtIdle(agentId: string, goal: GoalViewLike | undefined, runningChildren: number): GuardDecision {
    const st = this.states.get(agentId)
    if (st === undefined) return { kind: 'none', reason: 'untracked' }

    if (runningChildren > 0) {
      if (activeArmed(goal)) {
        const mark: GuardMark = { goalId: goal.id, revision: goal.revision, at: Date.now() }
        st.mark = mark
        return { kind: 'disarm', mark }
      }
      return { kind: 'none', reason: 'children-running' }
    }

    if (st.poisoned) return { kind: 'none', reason: 'poisoned' }
    const mark = st.mark
    if (mark === undefined) return { kind: 'none', reason: 'no-mark' }
    if (goal === undefined) {
      st.mark = undefined
      return { kind: 'none', reason: 'no-goal' }
    }
    if (goal.id !== mark.goalId || goal.revision !== mark.revision) {
      // goal 被清/被编辑：不自动 resume（保守，交人类）。
      st.mark = undefined
      return { kind: 'none', reason: 'goal-changed' }
    }
    if (goal.phase !== 'active' || goal.activation !== 'disarmed') {
      // 已 complete/blocked/paused，或已被重新武装（无守卫职责）：结束窗口。
      st.mark = undefined
      return { kind: 'none', reason: 'not-disarmed' }
    }
    return { kind: 'resume', mark }
  }

  /** resume 成功（或放弃自动 resume）后清 mark。 */
  clearMark(agentId: string): void {
    const st = this.states.get(agentId)
    if (st !== undefined) st.mark = undefined
  }

  /** 会话起点/终结：整段状态作废（新 epoch 不继承窗口）。 */
  reset(agentId: string): void {
    this.states.delete(agentId)
  }

  /** 观察：当前有守卫窗口（有 mark）的 agent 数。 */
  guardedCount(): number {
    let n = 0
    for (const st of this.states.values()) if (st.mark !== undefined) n += 1
    return n
  }

  /** 观察：在视野内的 agent 数（含无 mark 的）。 */
  trackedCount(): number {
    return this.states.size
  }

  /** 观察：全量快照（供状态路由 / 工具 / 测试）。 */
  snapshot(now = Date.now()): GuardSnapshot[] {
    return [...this.states.entries()].map(([agent, st]) => ({
      agent,
      tracked: true,
      marked: st.mark !== undefined,
      poisoned: st.poisoned,
      goalId: st.mark?.goalId ?? null,
      revision: st.mark?.revision ?? null,
      sinceMs: st.mark === undefined ? null : Math.max(0, now - st.mark.at),
    }))
  }
}

/**
 * 数「仍在跑的后代子代理」。**只接受 `listDescendants` 的行**——它按 residency
 * （记录是否 live 于 ctx.sessions）补 `activity`，与原生 `runningDescendants` 同源；
 * `kind === 'child' && activity === 'running'` 即工作未结束（含 send_message 冷恢复的
 * epoch2）。diagnostic 行无 `activity`，自然被排除；所有深度都算（原生亦如此）。
 * 空/非数组按 0。
 *
 * 注意：**不要**拿 `listChildren` 的结果喂这里——它的返回类型没有 `activity` 字段，
 * 恒返回 0（2026-10-03 实测故障）。
 */
export function countRunningChildren(rows: readonly SubagentRowLike[] | undefined): number {
  if (!Array.isArray(rows)) return 0
  let n = 0
  for (const row of rows) {
    if (row?.kind !== 'child') continue
    if (row.activity === 'running') n += 1
  }
  return n
}

/** 宽松判定：该 agent 是否是子代理（用会话 header 的委托元数据）。 */
export function isSubagentHeader(header: { origin?: unknown; delegationDepth?: unknown } | undefined): boolean {
  if (header === undefined || header === null) return false
  if (header.origin === 'subagent') return true
  const depth = header.delegationDepth
  return typeof depth === 'number' && depth > 0
}
