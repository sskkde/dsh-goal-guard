# AGENTS.md — dsh-goal-guard

DSH 插件 `dsh-goal-guard`：后台子代理运行期间暂停 goal 自动续跑注入。
设计动机、行为表、验收记录见 `README.md`（本文件只写**改代码时必须遵守的约束**）。

## 布局

| 路径 | 是什么 |
| --- | --- |
| `src/guard.ts` | **纯状态机**：无 harness 类型依赖、无 IO，可单测。改行为先改这里 |
| `src/index.ts` | 装配：事件触发器、惰性服务解析、决策执行器、看门狗、状态路由、工具 |
| `test/guard.test.mjs` | 状态机单测（import `../lib/guard.js` = **编译产物**） |
| `test/remote/` | 远端验收夹具（探针插件 + patch overlay），一次性工件 |
| `lib/` | 编译产物，**入库**（`files` 含 `lib`），使 git/直装无需构建 |
| `cordis.patch.yml` | bundle patch：插到 profile 根 roster |

## 构建 / 校验 / 测试（命令都在本目录内跑）

| 目的 | 命令 | 实测 |
| --- | --- | --- |
| 编译 | `bash scripts/build.sh`（= `npm run build`） | exit 0 |
| 类型检查 | `npx tsc -p tsconfig.json --noEmit` | exit 0，0 诊断 |
| 单测 | `npm test`（= `node --test`，**别传 `test/`**） | 18 tests，18 pass |

- **不 `npm install`**：`scripts/build.sh` 从 `~/.dsh/profiles/node_modules` 或
  `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules` 探测 DSH 依赖树，软链
  `@deepseek-ai/*` 进本地 `node_modules`，再用系统 `tsc` 编译。`node_modules` 全是软链，删了会重建。
- **先 build 再 test**：单测 import 的是 `lib/`，不 build 就是测旧产物。
- **改行为后必须重跑远端验收**（见下），单测只覆盖状态机、覆盖不到宿主适配层。

## 铁律（每条都有实测出处）

- **`inject` 保持为空**，服务一律在事件回调里惰性 `ctx.get()`。实测 headless profile 在
  `apply()` 时 `goals`/`agents`/`subagents`/`tools` 全部尚未就绪（到 `agent/created` 才齐）。
- **只 import `@deepseek-ai/schemastery`**，不要 `import 'schemastery'`：部署树里没有顶层
  `schemastery` 包。用顶层名会「本地构建通过、真机 `failed to import`」——第一版就这么翻的车。
- **挂载位置必须是 profile 根 roster 且 ctx 未打标**：`dsh-scope` 准入规则
  `const tag = scopeOf(ctx); if (tag === void 0) return true`——只有未打标的监听器能收到
  根会话的 `agent/status`。别把它塞进 agent preset 或任何 createScope 出来的作用域。
- **判活只用 `subagents.listDescendants`**：只有它给每行补 `activity`；`listChildren` 的行没有
  该字段，判活恒为 0。查询失败 → `null`（未知），**未知不构成 disarm/resume 的理由**。
- **只动自己 disarm 过的 goal**：`goals.resume` 服务层没有人类门（人类门在 `dsh-tool-goal`），
  所以必须 `id + revision` 全等且 `active + disarmed` 才 resume；否则清 mark 交人类。
- **一切注册走 `ctx.effect`**（监听器、`setInterval`），返回的 disposer 里逐个 try/catch 清理，
  否则热重载残留定时器与监听器。
- **告警必须落 console**：`ctx.logger` 存在但某些宿主不把插件 logger 输出落到任何可见位置；
  本功能的告警（resume 失败、窗口卡住）是唯一人工可见面，`log(msg, warn=true)` 会额外 `console.warn`。
- **工具返回值不得含显式 `undefined`**：harness lossless-JSON 校验会拒收。手写返回对象要条件挂键。

## 远端验收（改了触发器/决策逻辑就要跑）

```bash
# 1) 部署被测插件（真实形态：按包名从 profile node_modules 解析）
scp -r lib package.json <remote>:<profile>/node_modules/dsh-goal-guard/
# 2) 部署夹具与 overlay
scp test/remote/goal-guard-accept.mjs test/remote/patch.yml <remote>:/root/test-env/
# 3) 两种模式各跑一次，看 verdict.pass
GG_ACCEPT_MODE=adopt     dsh web --patch /root/test-env/patch.yml --port 3099 --no-open
GG_ACCEPT_MODE=proactive dsh web --patch /root/test-env/patch.yml --port 3099 --no-open
```

判据：**窗口内（子代理 running 期间）`<goal_round>` 注入数 = 0**，且窗口关闭后
`goal.activation` 回到 `armed`。报告在 `$GG_ACCEPT_OUT/report.json`（`verdict.pass`）。
夹具不需要 LLM 成功（回合以 QUOTA 失败也照样产生全部生命周期事件）。

清理：验收用的 dsh 进程用 `pkill -f "pat[c]h.yml"`（括号技巧，否则会匹配到自己的命令行）。

## 发布

`lib/` 随包入库，所以发布/直装无需构建。改完记得同步：`package.json` 版本 →
`README.md` 验收记录 → 提交（`lib/` 与 `src/` 一起提交，避免产物与源码漂移）。
