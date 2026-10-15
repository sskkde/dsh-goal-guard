/**
 * dsh-goal-guard —— 后台子代理运行期间暂停 goal 自动续跑注入。
 *
 * ## 这个插件补的是 DSH 核心的一个缺口
 *
 * `@deepseek-ai/dsh-goal-round-driver` 的 `readyToDrive` 只检查 `agent.status === 'idle'`
 * 与「无竞争排队消息」，**不知道还有未结算的后台子代理**（该包不依赖 `dsh-subagent`），
 * 配置里也没有相关开关。于是「派发后台 continuable 子代理 → 结束回合 → 等结算通知」这种
 * 委托纪律下，等待窗口内每轮 idle 都会注入一个 `<goal_round>`，把 `maxGoalRounds` 烧光。
 * 远端实测（web profile，子代理仍在跑时 driver 照注入）：见仓库 README 的验收记录。
 *
 * ## 装配要点（都是实测结论，别凭直觉改）
 *
 * - **`inject` 留空**：`goals` / `agents` / `subagents` / `tools` / `webServer` 全部可选且
 *   惰性解析。实测 headless profile 在 `apply()` 时这些服务**全部尚未就绪**，到
 *   `agent/created` 才齐；把服务句柄在装配期抓死会直接坏掉。
 * - **挂载位置必须未打标（profile 根 roster）**：`dsh-scope` 的准入规则是
 *   `const tag = scopeOf(ctx); if (tag === void 0) return true` —— 未打标的监听器全局准入，
 *   才能收到根会话的 `agent/status`；被打标的 ctx 只收其作用域链后代的事件。
 * - **一切注册走 `ctx.effect`**：热重载/卸载即净，不留监听器与定时器。
 * - **只动自己 disarm 过的 goal**：`goals.resume` 在服务层没有人类门（人类门在
 *   `dsh-tool-goal`），所以 id/revision 不匹配一律清 mark 交人类，绝不猜。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

import {
  GoalGuard,
  countRunningChildren,
  isSubagentHeader,
  type GoalViewLike,
  type GoalsServiceLike,
  type SubagentRowLike,
} from './guard.js'

export const name = 'dsh-goal-guard'

/** 无必需依赖：缺失的服务在事件回调里惰性解析，插件在任何 profile 都能加载。 */
export const inject: string[] = []

export interface Config {
  /** 总开关；关闭即退回 harness 原生行为（等待窗口仍会注入 goal 轮次）。 */
  enabled: boolean
  /** 是否注册 `/dsh-goal-guard/api/status` 观测路由（需要 webServer 服务）。 */
  statusRoute: boolean
  /** 是否注册 `goal_guard` 工具（让模型能自查/手动恢复）。 */
  tool: boolean
  /** 看门狗周期（ms）：兜住漏掉的结算事件导致的「静默卡在 disarmed」。0 = 关闭。 */
  watchdogIntervalMs: number
  /** 窗口持续超过该时长（ms）即计一次 stuck 告警（子代理可能真在长跑）。 */
  maxWindowMs: number
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  statusRoute: z.boolean().default(true),
  tool: z.boolean().default(true),
  watchdogIntervalMs: z.number().default(30000),
  maxWindowMs: z.number().default(1800000),
})

type AnyObj = Record<string, unknown>

/** 松类型 ctx 面（事件名/服务名运行时解析，避免与宿主类型版本耦合）。 */
interface LooseCtx {
  on(ev: string, fn: (...args: unknown[]) => unknown): (() => void) | undefined
  get(key: string): unknown
  effect(cb: () => (() => void) | void, label?: string): unknown
  logger?: { info?: (m: string) => void; warn?: (m: string) => void }
}

interface AgentsServiceLike {
  get(id: string): unknown
}

interface SubagentsServiceLike {
  listDescendants(parentSessionId: string, signal?: AbortSignal): Promise<SubagentRowLike[]>
}

interface WebServerLike {
  register(route: AnyObj, tag?: string): unknown
}

const PLUGIN = 'dsh-goal-guard'

/** 诊断计数器（status 路由与 goal_guard 工具共用）。 */
interface Diag {
  spawned: number
  adopts: number
  proactiveDisarms: number
  windowDisarms: number
  resumes: number
  resumeFails: number
  poisoned: number
  unknownQueries: number
  listFails: number
  subsMissing: number
  agentsMissing: number
  watchdogTicks: number
  stuckWindows: number
  last: string
}

export function apply(ctx: Context, config: Config): void {
  const loose = ctx as unknown as LooseCtx
  const loggerPresent = (() => { try { return loose.logger !== undefined && loose.logger !== null } catch { return false } })()
  /**
   * 日志。三档：
   * - 常规（mirror=false）：只走宿主 logger（每回合都可能触发的决策噪音）
   * - 状态变化（mirror=true）：**额外落 console** —— 实测某些宿主（如 systemd 下的 `dsh web`）
   *   会把 `ctx.logger` 输出整条丢掉（journald 里只有 `console.*` 的插件日志），而
   *   「暂停 / 恢复 goal 自动续跑」正是用户唯一能看到的插件行为，丢了就等于静默
   * - warn：同上且更必须可见（resume 失败 / 窗口卡住是本功能最坏的失败模式）
   */
  const log = (msg: string, warn = false, mirror = false): void => {
    const line = `[${PLUGIN}] ${msg}`
    try {
      const l = loose.logger
      if (warn) l?.warn?.(line)
      else l?.info?.(line)
    } catch { /* ignore */ }
    if (warn || mirror) {
      try { console.warn(line) } catch { /* ignore */ }
    }
  }

  if (!config.enabled) {
    log('已禁用（enabled=false）—— 等待窗口内 goal 仍会被注入')
    return
  }

  const guard = new GoalGuard()
  const diag: Diag = {
    spawned: 0, adopts: 0, proactiveDisarms: 0, windowDisarms: 0, resumes: 0, resumeFails: 0,
    poisoned: 0, unknownQueries: 0, listFails: 0, subsMissing: 0, agentsMissing: 0,
    watchdogTicks: 0, stuckWindows: 0, last: '',
  }

  // ── 惰性服务解析 ──────────────────────────────────────────────────
  const svc = <T>(key: string): T | undefined => {
    try {
      const s = loose.get(key)
      return s === undefined || s === null ? undefined : (s as T)
    } catch { return undefined }
  }
  const goalsSvc = (): GoalsServiceLike | undefined => {
    const s = svc<GoalsServiceLike>('goals')
    if (s && typeof s.get === 'function' && typeof s.disarm === 'function' && typeof s.resume === 'function') return s
    return undefined
  }
  const agentsSvc = (): AgentsServiceLike | undefined => {
    const s = svc<AgentsServiceLike>('agents')
    return s && typeof s.get === 'function' ? s : undefined
  }
  const subsSvc = (): SubagentsServiceLike | undefined => {
    const s = svc<SubagentsServiceLike>('subagents')
    return s && typeof s.listDescendants === 'function' ? s : undefined
  }

  const agentIdOf = (payload: unknown): string => String((payload as { agent?: { id?: unknown } } | undefined)?.agent?.id ?? '')
  const agentOf = (id: string): unknown => {
    try { return agentsSvc()?.get(id) } catch { return undefined }
  }
  const goalOf = (agent: unknown): GoalViewLike | undefined => {
    try { return goalsSvc()?.get(agent) } catch { return undefined }
  }
  const goalLabel = (goal: GoalViewLike | undefined): string => (goal === undefined ? 'none' : `${goal.phase}/${goal.activation}`)

  /** 数仍在跑的后代子代理；`null` = 未知（查询失败/服务缺失）——未知不构成任何动作的理由。 */
  const runningChildrenOf = async (agentId: string): Promise<number | null> => {
    const subs = subsSvc()
    if (subs === undefined) { diag.subsMissing += 1; return null }
    try {
      const rows = await subs.listDescendants(agentId)
      return countRunningChildren(rows)
    } catch (e) {
      diag.listFails += 1
      diag.last = `listDescendants(${agentId}) failed: ${String(e)}`
      log(`listDescendants 失败（按未知处理，不 disarm/resume）: ${String(e)}`, true)
      return null
    }
  }

  // ── 动作执行器 ────────────────────────────────────────────────────
  const doDisarm = (agent: unknown, agentId: string, mark: { goalId: string; revision: number; at: number }, why: 'spawn' | 'adopt' | 'idle'): void => {
    const goals = goalsSvc()
    if (goals === undefined) return
    try {
      goals.disarm(agent)
      guard.recordDisarm(agentId, mark)
      if (why === 'idle') diag.windowDisarms += 1
      else diag.proactiveDisarms += 1
      diag.last = `disarmed ${mark.goalId}@${mark.revision} (${why})`
      log(`已解除 goal ${mark.goalId}@${mark.revision} 的自动续跑（${why === 'spawn' ? '派发子代理' : why === 'adopt' ? '等待窗口采纳' : '等待窗口重新武装'}）`, false, true)
    } catch (e) {
      diag.last = `disarm failed: ${String(e)}`
      log(`disarm 失败: ${String(e)}`, true)
    }
  }

  const doResume = (agent: unknown, agentId: string, mark: { goalId: string; revision: number; at: number }): void => {
    const goals = goalsSvc()
    if (goals === undefined) return
    try {
      goals.resume(agent, { id: mark.goalId, revision: mark.revision })
      guard.clearMark(agentId)
      diag.resumes += 1
      diag.last = `resumed ${mark.goalId}@${mark.revision}`
      log(`子代理已结算，恢复 goal ${mark.goalId}@${mark.revision} 的自动续跑`, false, true)
    } catch (e) {
      // resume 失败 = 保持 disarmed（fail-safe，交人类）；绝不让自动续跑借尸还魂。
      guard.clearMark(agentId)
      diag.resumeFails += 1
      diag.last = `resume failed: ${String(e)}`
      log(`resume 失败，goal 保持 disarmed，需人类手动恢复: ${String(e)}`, true)
    }
  }

  // ── 决策（串行化 + 合并，避免并发 trigger 重复 resume）──────────────
  const inflight = new Set<string>()
  const pending = new Set<string>()

  const decideNow = async (agentId: string): Promise<void> => {
    if (!guard.has(agentId)) return
    const agent = agentOf(agentId)
    if (agent === undefined) { diag.agentsMissing += 1; return }
    const goal = goalOf(agent)
    const running = await runningChildrenOf(agentId)
    if (running === null) {
      diag.unknownQueries += 1
      // 未知：已有窗口时保守保持 disarmed；无窗口时什么都不做。
      if (guard.markOf(agentId) !== undefined) diag.last = `children unknown → keep disarmed (${agentId})`
      return
    }
    const dec = guard.decideAtIdle(agentId, goal, running)
    diag.last = `decide(${agentId}) running=${running} goal=${goalLabel(goal)} → ${dec.kind}${dec.kind === 'none' ? `:${dec.reason}` : ''}`
    if (dec.kind === 'disarm') doDisarm(agent, agentId, dec.mark, 'idle')
    else if (dec.kind === 'resume') doResume(agent, agentId, dec.mark)
  }

  const decide = async (agentId: string): Promise<void> => {
    if (agentId === '') return
    if (inflight.has(agentId)) { pending.add(agentId); return }
    inflight.add(agentId)
    try {
      do {
        pending.delete(agentId)
        await decideNow(agentId)
      } while (pending.has(agentId))
    } finally {
      inflight.delete(agentId)
    }
  }

  /** 采纳：未在视野内的 agent，若 goal `active+armed` 且确有子代理在跑 → 建窗口并 disarm。 */
  const adopt = async (agentId: string): Promise<void> => {
    if (agentId === '' || guard.has(agentId)) return
    const agent = agentOf(agentId)
    if (agent === undefined) return
    const goal = goalOf(agent)
    // 先看 goal（内存读，便宜）：无 goal 或非 armed 时连 descendants 都不查。
    if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') return
    const running = await runningChildrenOf(agentId)
    if (running === null || running === 0) return
    const mark = guard.disarmIntent(agentId, goal)
    if (mark === undefined) return
    diag.adopts += 1
    doDisarm(agent, agentId, mark, 'adopt')
  }

  /** 派发点抢先 disarm：母会话仍在 running，driver 不会看到 armed 的 idle。 */
  const proactiveDisarm = async (parentId: string): Promise<void> => {
    if (parentId === '') return
    const agent = agentOf(parentId)
    if (agent === undefined) return
    const goal = goalOf(agent)
    const mark = guard.disarmIntent(parentId, goal)
    if (mark === undefined) return
    doDisarm(agent, parentId, mark, 'spawn')
  }

  // ── 事件触发器（全部实测可达；见 README 的通道准入验收）────────────
  const disposers: Array<() => void> = []
  const on = (ev: string, fn: (...args: unknown[]) => unknown): void => {
    try {
      const d = loose.on(ev, fn)
      if (typeof d === 'function') disposers.push(d)
    } catch (e) {
      log(`监听 ${ev} 失败: ${String(e)}`, true)
    }
  }

  ctx.effect(() => {
    // 1) 子代理诞生 → 母会话抢先 disarm（零竞态；覆盖 subagent / subagent_fork / workflow 等所有派发路径）
    on('agent/created', (payload: unknown) => {
      try {
        const agent = (payload as { agent?: { session?: { header?: { origin?: unknown; delegationDepth?: unknown; parentSession?: unknown } } } } | undefined)?.agent
        const header = agent?.session?.header
        if (!isSubagentHeader(header)) return
        const parentId = header?.parentSession === undefined ? '' : String(header.parentSession)
        if (parentId === '') return
        diag.spawned += 1
        void proactiveDisarm(parentId)
      } catch (e) { log(`agent/created 处理失败: ${String(e)}`, true) }
    })

    // 2) 回合结束/idle：已追踪 → 决策；未追踪 → 采纳
    on('agent/status', (payload: unknown) => {
      try {
        if ((payload as { status?: unknown } | undefined)?.status !== 'idle') return
        const id = agentIdOf(payload)
        if (id === '') return
        if (guard.has(id)) void decide(id)
        else void adopt(id)
      } catch (e) { log(`agent/status 处理失败: ${String(e)}`, true) }
    })

    // 3) goal 变更：已追踪 → 决策；未追踪 → 采纳（覆盖「先派子代理、后 arm goal」的顺序）
    on('goal/changed', (payload: unknown) => {
      try {
        const id = agentIdOf(payload)
        if (id === '') return
        if (guard.has(id)) void decide(id)
        else void adopt(id)
      } catch (e) { log(`goal/changed 处理失败: ${String(e)}`, true) }
    })

    // 4) 会话事件：结算通知（耐久 user message）与 turn/end 兜底
    on('session/event', (session: unknown, event: unknown) => {
      try {
        const sid = String((session as { id?: unknown } | undefined)?.id ?? '')
        if (sid === '') return
        const ev = event as { type?: unknown; data?: { reason?: { kind?: unknown }; source?: { kind?: unknown } } } | undefined
        if (ev?.type === 'user/message' && ev.data?.source?.kind === 'subagent-settled') {
          if (guard.has(sid)) void decide(sid)
          return
        }
        if (ev?.type === 'turn/end') {
          const kind = ev.data?.reason?.kind
          if (kind === 'max-tokens' || kind === 'aborted') {
            if (guard.poison(sid, `turn/end:${String(kind)}`)) {
              diag.poisoned += 1
              log(`${sid} 因回合 ${String(kind)} 被毒化 —— 不再自动 resume（交人类）`)
            }
            return
          }
          if (guard.has(sid)) void decide(sid)
        }
      } catch (e) { log(`session/event 处理失败: ${String(e)}`, true) }
    })

    // 5) driver 熔断信号 → 毒化；会话边界 → 作废窗口
    on('agent/error', (payload: unknown) => {
      try {
        const id = agentIdOf(payload)
        if (id !== '' && guard.poison(id, 'agent/error')) {
          diag.poisoned += 1
          log(`${id} 因 agent/error 被毒化 —— 不再自动 resume（交人类）`)
        }
      } catch { /* ignore */ }
    })
    on('agent/disposed', (payload: unknown) => {
      try { guard.reset(agentIdOf(payload)) } catch { /* ignore */ }
    })
    on('agent/session-start', (payload: unknown) => {
      try { guard.reset(agentIdOf(payload)) } catch { /* ignore */ }
    })

    return () => {
      for (const d of disposers) { try { d() } catch { /* ignore */ } }
      disposers.length = 0
    }
  }, `${PLUGIN}: listeners`)

  // ── 看门狗：兜住漏掉的结算事件（静默卡在 disarmed 是本功能最坏的失败模式）──
  if (config.watchdogIntervalMs > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        try {
          diag.watchdogTicks += 1
          const now = Date.now()
          for (const snap of guard.snapshot(now)) {
            if (!snap.marked) continue
            if (snap.sinceMs !== null && snap.sinceMs > config.maxWindowMs) {
              diag.stuckWindows += 1
              log(`窗口已持续 ${Math.round((snap.sinceMs ?? 0) / 1000)}s（agent=${snap.agent}）—— 若子代理已结束请检查 resume`, true)
            }
            void decide(snap.agent)
          }
        } catch (e) { log(`看门狗失败: ${String(e)}`, true) }
      }, config.watchdogIntervalMs)
      try { (timer as unknown as { unref?: () => void }).unref?.() } catch { /* ignore */ }
      return () => { clearInterval(timer) }
    }, `${PLUGIN}: watchdog`)
  }

  // ── 观测：状态路由（webServer 可选）─────────────────────────────────
  const statusPayload = (): AnyObj => {
    const goals = goalsSvc()
    const subs = subsSvc()
    return {
      ok: true,
      plugin: PLUGIN,
      enabled: true,
      loggerPresent,
      services: {
        goals: goals !== undefined,
        agents: agentsSvc() !== undefined,
        subagents: subs !== undefined,
      },
      guarded: guard.guardedCount(),
      tracked: guard.trackedCount(),
      states: guard.snapshot(),
      diag,
    }
  }

  if (config.statusRoute) {
    try {
      const injectOpt = (ctx as unknown as { inject?: (deps: string[], cb: (c: unknown) => unknown) => unknown }).inject
      if (typeof injectOpt === 'function') {
        injectOpt.call(ctx, ['webServer'], (scoped: unknown) => {
          const web = (scoped as { webServer?: WebServerLike }).webServer
          if (web === undefined || typeof web.register !== 'function') return
          try {
            web.register({
              kind: 'exact',
              path: '/dsh-goal-guard/api/status',
              handler: (_req: unknown, res: unknown) => {
                const r = res as { writeHead: (s: number, o: Record<string, string>) => void; end: (b: string) => void }
                r.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
                r.end(JSON.stringify(statusPayload()))
              },
            }, `${PLUGIN}: api/status`)
          } catch (e) {
            // 双挂载时 exact 表重路径会抛 duplicate —— 容忍（先挂者服务）
            if (!/duplicate/i.test(String(e))) log(`注册状态路由失败: ${String(e)}`, true)
          }
        })
      }
    } catch (e) { log(`注册状态路由失败: ${String(e)}`, true) }
  }

  // ── 观测/自救：goal_guard 工具（tools 可选）─────────────────────────
  if (config.tool) {
    const def: ToolDefinition = defineTool({
      name: 'goal_guard',
      description:
        '查询/恢复本会话的 goal 自动续跑守卫。后台子代理在跑时守卫会临时解除 goal 自动续跑（避免烧轮次），结算后自动恢复；本工具用于查看为什么 goal 没有继续，或手动触发一次恢复。',
      parameters: {
        action: { type: 'string', enum: ['status', 'resume'], required: true, description: 'status=看守卫状态；resume=立即重新评估并尝试恢复' },
        session: { type: 'string', description: 'resume 时可指定会话 id；缺省作用于所有有守卫窗口的会话' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
      },
      async execute(args: { action?: string; session?: string }) {
        const action = String(args?.action ?? 'status')
        if (action === 'resume') {
          const targets = args?.session !== undefined && args.session !== ''
            ? [String(args.session)]
            : guard.snapshot().filter((s) => s.marked).map((s) => s.agent)
          for (const id of targets) await decide(id)
          const after = guard.snapshot()
          return {
            action,
            evaluated: targets,
            guarded: guard.guardedCount(),
            states: after,
            diag,
          }
        }
        return statusPayload()
      },
    } as never)

    try {
      const injectOpt = (ctx as unknown as { inject?: (deps: string[], cb: (c: unknown) => unknown) => unknown }).inject
      if (typeof injectOpt === 'function') {
        injectOpt.call(ctx, ['tools'], (scoped: unknown) => {
          const tools = (scoped as { tools?: { register: (d: unknown) => unknown } }).tools
          if (tools === undefined || typeof tools.register !== 'function') return
          tools.register(def)
        })
      }
    } catch (e) { log(`注册 goal_guard 工具失败: ${String(e)}`, true) }
  }

  log('已启用：派发后台子代理期间解除 goal 自动续跑，结算后自动恢复（子代理查询失败按未知处理，绝不误 resume）', false, true)
}
