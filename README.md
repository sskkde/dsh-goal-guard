# dsh-goal-guard

**后台子代理还在跑时，别让 goal 自动续跑被烧掉。**

DeepSeek Harness（DSH / Cordis）插件。在「派发后台 continuable 子代理 → 结束回合 → 等结算通知」
这种委托纪律下，`goal-round-driver` 会在母会话每次回到 idle 时注入一轮 `<goal_round>`——
它不知道还有未结算的子代理。本插件在等待窗口内**进程内**解除 goal 的自动续跑
（`goals.disarm`，不产生耐久事件、不改 phase/revision），全部子代理结算后自动恢复
（`goals.resume`）。

## 为什么需要它（这是核心缺口，不是某个插件的私有 workaround）

`@deepseek-ai/dsh-goal-round-driver` 的 `readyToDrive` 只检查

```js
return ctx.fiber.state === 2 && !state.stopping
  && ctx.agents.get(state.agent.id) === state.agent
  && state.agent.status === "idle"
  && !state.competingQueued
```

——**没有子代理维度**：该包不注入 `subagents`，`Config` 也只有 `defaultMaxGoalRounds`，
没有任何原生开关。而模型工具层的 `update_goal(pause/resume)` 要求「直接人类回合」，
模型自救不了。

远端实测（web profile，子代理运行期间）复现：

```
+ 66ms  agent/created   origin=subagent depth=1        ← 子代理诞生
+ 72ms  agent/status    running (子代理)
+209ms  <goal_round> round=1 注入                      ← ★ 子代理仍在跑，driver 照注入
+859ms  agent/error     QUOTA (子代理)
+943ms  user/message    sourceKind=subagent-settled     ← 结算通知
```

装上本插件后同一场景：**窗口内零注入**，且结算后 goal 自动回到 `armed`（见下方验收记录）。

## 行为

| 时机 | 动作 |
| --- | --- |
| 子代理诞生（`agent/created` 带 `origin='subagent'` + `parentSession`） | 母会话 goal 若 `active + armed` → **抢先 disarm**（母会话仍在 running，零竞态；覆盖 `subagent` / `subagent_fork` / `workflow` 等所有派发路径） |
| goal 被 arm 但已有子代理在跑（`goal/changed` 采纳） | 立即 disarm（堵住「先派子代理、后 arm goal」的窗口） |
| idle / 结算通知（`agent/status` idle、`subagent-settled`、`turn/end`） | 有 running 子代理 → 保持 disarm；无 running 子代理 → 自动 resume |
| `agent/error`、回合 `max-tokens` / `aborted` | **毒化**：不再自动 resume（不覆盖 harness 的熔断决定，交人类） |
| `agent/disposed`、`agent/session-start` | 整段窗口状态作废（新 epoch 不继承） |

### 安全不变量

`goals.resume` 在**服务层没有人类门**（人类门在 `dsh-tool-goal`），所以本插件只重新武装
**自己刚 disarm 过的、`id + revision` 完全一致、且仍为 `active + disarmed`** 的 goal。
goal 被清 / 被编辑 / complete / blocked / paused / 被第三方重新武装 → 一律清 mark 交人类，
绝不猜。「还有子代理在跑」用 `subagents.listDescendants(...)` 的 `activity === 'running'`
判定；**查询失败按「未知」处理，未知不构成 disarm 或 resume 的理由**。

## 安装

```bash
# 方式一：DSH 插件管理器（写入 profile 依赖 + bundle 装配）
dsh plugin --profile web add /path/to/dsh-goal-guard

# 方式二：dsh-super-injector（运行时注入，免重启）
dev_inject_plugin /path/to/dsh-goal-guard

# 方式三：作为 profile patch overlay 挂载
dsh web --patch ./cordis.patch.yml
```

`cordis.patch.yml` 把本插件插到 profile **根 roster**。挂载位置很重要：`dsh-scope` 的准入规则是

```js
const tag = scopeOf(ctx);
if (tag === void 0) return true;          // 未打标的监听器 → 全局准入
```

只有**未打标**的监听器才能收到根会话的 `agent/status`；被打标的 ctx 只收其作用域链后代的事件。

## 配置

```yaml
# profile patch / 插件 config
- id: dsh-goal-guard
  config:
    enabled: true              # 总开关；关闭即退回原生行为
    statusRoute: true          # 注册 /dsh-goal-guard/api/status
    tool: true                 # 注册 goal_guard 工具
    watchdogIntervalMs: 30000  # 看门狗周期；0 = 关闭
    maxWindowMs: 1800000       # 窗口超时告警阈值
```

## 观测

- `GET /dsh-goal-guard/api/status` → `{ ok, loggerPresent, guarded, tracked, states, diag }`
- 工具 `goal_guard`：`action=status` 看守卫状态；`action=resume` 立即重新评估并尝试恢复
  （模型自查「为什么 goal 没继续」用）
- 告警走 `ctx.logger.warn` **并额外落 `console.warn`**：某些宿主不把插件 logger 输出落到
  可见位置，而「resume 失败 / 窗口卡住」是本功能唯一的人工可见面，不能丢

## 兼容性

| 项 | 值 |
| --- | --- |
| `dsh.engines.dsh` | `>=0.1.7-rc.1 <0.2` |
| peer | `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery` |
| 必需服务 | 无（`goals` / `agents` / `subagents` / `tools` / `webServer` 全部可选且惰性解析） |

## 验收记录（2026-10-15，远端测试环境）

被测形态 = 真实部署形态：插件放进 `profiles/node_modules/`，按**包名**由 profile 根 roster 挂载；
验收夹具另挂一个探针插件造激励（自建 root agent → 派 continuable 子代理 → arm goal），
不依赖 LLM 成功（远端凭证余额不足，回合以 QUOTA 失败，但生命周期事件齐全）。

| 场景 | 窗口内 `<goal_round>` 注入 | disarm 时点 | 结算后 resume | 判定 |
| --- | --- | --- | --- | --- |
| **基线**（无插件，探针实测） | **1** | — | — | 病根复现 |
| `adopt`（先派子代理 → 再 arm goal） | **0** | arm 后 **+15ms** | ✅ `armed` | **PASS** |
| `proactive`（先 arm goal → 立刻派子代理） | **0** | 子代理 `agent/created` 时（早于 spawn 时间戳） | ✅ `armed` | **PASS** |

对照数字：driver 从 `goal/changed` 到排队轮次约 **178ms**（内部有 `await sessions.flush()` 检查点），
守卫 disarm 在 **15ms** 内完成 → 赢约 160ms。`/api/status` 实测 HTTP 200，
diag `spawned:1 / windowDisarms:1 / resumes:1 / resumeFails:0 / watchdogTicks:2`。

复现（夹具在 `test/remote/`）：

```bash
# 远端：<DSH_HOME> 指向测试 home，dsh 用部署树里的 bin
scp -r lib package.json <remote>:<profile>/node_modules/dsh-goal-guard/
scp test/remote/goal-guard-accept.mjs test/remote/patch.yml <remote>:/root/test-env/
ssh <remote> 'cd /root/test-env && GG_ACCEPT_MODE=adopt dsh web --patch /root/test-env/patch.yml --port 3099 --no-open'
# 报告：/root/test-env/accept-out/report.json（看 verdict.pass）
```

## 开发

```bash
bash scripts/build.sh        # src/ → lib/（从部署树链类型依赖，用全局 tsc）
npx tsc -p tsconfig.json --noEmit
npm test                     # node --test（先 build 再 test，测的是 lib/ 产物）
```

**本仓库不 `npm install`**：`scripts/build.sh` 从 `~/.dsh/profiles/node_modules` 或
`/usr/lib/node_modules/@deepseek-ai/dsh/node_modules` 探测一份 DSH 依赖树，把
`@deepseek-ai/*` 软链进本地 `node_modules` 后用系统 `tsc` 编译。`lib/` 是产物但**入库**
（`files` 含 `lib`），这样 `dsh plugin add` / git 直装不需要构建步骤。

## 两个踩过的坑（都来自真实部署，别重犯）

1. **不要 `import 'schemastery'`**。部署树里没有顶层 `schemastery` 包，只有
   `@deepseek-ai/schemastery`（官方包与已发布第三方插件一律 import 这个 scoped 名）。
   用顶层名会「本地构建通过、真机 `failed to import`」——本插件第一版就是这样在远端被拒的。
   同理：不要靠 build 时生成的 `node_modules/<name>` 软链在运行期解析裸名。
2. **服务句柄必须惰性取**。实测 headless profile 在 `apply()` 时
   `goals`/`agents`/`subagents`/`tools` **全部尚未就绪**（到 `agent/created` 才齐）；
   装配期抓死句柄会直接坏掉。本插件的 `inject` 因此留空。

## License

BSD-3-Clause
