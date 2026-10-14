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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "dsh-goal-guard";
/** 无必需依赖：缺失的服务在事件回调里惰性解析，插件在任何 profile 都能加载。 */
export declare const inject: string[];
export interface Config {
    /** 总开关；关闭即退回 harness 原生行为（等待窗口仍会注入 goal 轮次）。 */
    enabled: boolean;
    /** 是否注册 `/dsh-goal-guard/api/status` 观测路由（需要 webServer 服务）。 */
    statusRoute: boolean;
    /** 是否注册 `goal_guard` 工具（让模型能自查/手动恢复）。 */
    tool: boolean;
    /** 看门狗周期（ms）：兜住漏掉的结算事件导致的「静默卡在 disarmed」。0 = 关闭。 */
    watchdogIntervalMs: number;
    /** 窗口持续超过该时长（ms）即计一次 stuck 告警（子代理可能真在长跑）。 */
    maxWindowMs: number;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    statusRoute: z<boolean, boolean, "defined">;
    tool: z<boolean, boolean, "defined">;
    watchdogIntervalMs: z<number, number, "defined">;
    maxWindowMs: z<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    statusRoute: z<boolean, boolean, "defined">;
    tool: z<boolean, boolean, "defined">;
    watchdogIntervalMs: z<number, number, "defined">;
    maxWindowMs: z<number, number, "defined">;
}>>, "plain">;
export declare function apply(ctx: Context, config: Config): void;
