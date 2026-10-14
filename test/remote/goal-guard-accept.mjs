/**
 * goal-guard-accept —— dsh-goal-guard 的远端验收夹具（一次性工件，非产品代码）。
 *
 * 判据（不依赖 LLM 成功；远端凭证余额不足，回合以 QUOTA 失败，但生命周期事件齐全）：
 *
 *   阶段 adopt     ：先派 continuable 子代理 → 再 arm goal
 *                    → 守卫应在 driver 排队 <goal_round> 之前 disarm（adopt 路径）
 *   阶段 proactive ：先 arm goal → 立刻派子代理
 *                    → 守卫应在子代理 agent/created 时抢先 disarm（零竞态路径）
 *
 * 两个阶段都要满足：**窗口内（子代理 running 期间）零 <goal_round> 注入**，
 * 且窗口关闭后 goal 自动回到 armed（resume 生效）。
 *
 * 用法（远端，DSH_HOME 指向测试 home）：
 *   GG_ACCEPT_MODE=adopt      dsh web --patch <patch.yml> --port 3099 --no-open
 *   GG_ACCEPT_MODE=proactive  dsh web --patch <patch.yml> --port 3099 --no-open
 * 报告写到 $GG_ACCEPT_OUT/report.json 与 events.ndjson。
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export const name = 'goal-guard-accept'

const OUT = process.env.GG_ACCEPT_OUT || '/root/test-env/goal-guard-accept-out'
const MODE = process.env.GG_ACCEPT_MODE === 'proactive' ? 'proactive' : 'adopt'
const DSH_NM = '/root/.dsh-remote/dsh/node_modules/@deepseek-ai'

let installModelSelection = null
try {
  const m = await import(`file://${DSH_NM}/dsh-agent/lib/index.js`)
  installModelSelection = typeof m.installModelSelection === 'function' ? m.installModelSelection : null
} catch { /* ignore */ }

const report = {
  fixture: 'goal-guard-accept',
  mode: MODE,
  startedAt: new Date().toISOString(),
  pid: process.pid,
  installModelSelection: installModelSelection !== null,
  samples: [],
  events: [],
  phase: {},
  verdict: {},
  errors: [],
}

function flush() {
  try {
    mkdirSync(OUT, { recursive: true })
    writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  } catch { /* ignore */ }
}
function record(channel, detail) {
  const row = { t: Date.now(), channel, detail }
  report.events.push(row)
  try {
    mkdirSync(OUT, { recursive: true })
    appendFileSync(`${OUT}/events.ndjson`, `${JSON.stringify(row)}\n`)
  } catch { /* ignore */ }
  flush()
}

let ctxRef = null
let agentRef = null
let goalRef = null
let spawnAt = 0

function goalView() {
  try {
    const v = ctxRef.get('goals')?.get(agentRef)
    return v ? { id: v.id, phase: v.phase, activation: v.activation, revision: v.revision, roundsStarted: v.roundsStarted } : null
  } catch (e) { return { err: String(e) } }
}
async function runningCount() {
  try {
    const rows = await ctxRef.get('subagents')?.listDescendants(agentRef.id)
    return (rows ?? []).filter((r) => r?.kind === 'child' && r?.activity === 'running').length
  } catch (e) { return `ERR:${String(e).slice(0, 60)}` }
}

export function apply(ctx) {
  ctxRef = ctx

  ctx.on('session/event', (_session, event) => {
    try {
      const ev = event ?? {}
      if (ev.type === 'user/message' && ev.data?.source?.kind === 'goal') {
        record('GOAL_ROUND', { round: ev.data?.source?.round ?? null, sinceSpawnMs: spawnAt ? Date.now() - spawnAt : null })
      }
    } catch { /* ignore */ }
  })
  ctx.on('goal/activation-changed', (payload) => {
    try { record('activation', { activation: String(payload?.goal?.activation ?? ''), sinceSpawnMs: spawnAt ? Date.now() - spawnAt : null }) }
    catch { /* ignore */ }
  })
  ctx.on('agent/created', (payload) => {
    try {
      const h = payload?.agent?.session?.header ?? {}
      if (h.origin === 'subagent' || (h.delegationDepth ?? 0) > 0) {
        record('child-created', { childId: String(payload?.agent?.id ?? ''), parentSession: String(h.parentSession ?? ''), sinceSpawnMs: spawnAt ? Date.now() - spawnAt : null })
      }
    } catch { /* ignore */ }
  })

  void (async () => {
    try { await ctx.get('loader')?.await() } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 3000))
    await run()
  })()
}

async function run() {
  const agents = ctxRef.get('agents')
  const goals = ctxRef.get('goals')
  const subs = ctxRef.get('subagents')
  const selection = ctxRef.get('agentDefaultModel')?.currentSelection?.() ?? { provider: 'deepseek-official', model: 'deepseek-flash' }
  const setup = (agentCtx) => { if (installModelSelection) installModelSelection(agentCtx, { current: selection, assembled: undefined }) }
  const sessionId = `session-accept-${randomUUID()}`
  const created = await agents.create({ sessionId, meta: { cwd: '/root/test-env' }, agentOptions: { provider: selection.provider, model: selection.model }, setup })
  agentRef = created?.agent
  report.phase.agent = String(agentRef?.id ?? '')
  flush()

  const spawnChild = async (label) => {
    const r = await subs.startContinuable({
      provider: 'spawn',
      label,
      request: {
        prompt: [{ type: 'text', text: 'accept: reply with the single word OK' }],
        parent: agentRef,
        agentOptions: { provider: selection.provider, model: selection.model },
      },
      signal: new AbortController().signal,
    })
    spawnAt = Date.now()
    report.phase[label] = { childId: String(r?.childId ?? ''), spawnAt }
    record('spawn', { label, childId: String(r?.childId ?? '') })
    return r
  }
  const armGoal = (maxRounds = 3) => {
    const gv = goals.create(agentRef, { objective: `goal-guard accept (${MODE})`, maxGoalRounds: maxRounds })
    goalRef = { id: gv.id, revision: gv.revision }
    report.phase.goalCreate = { id: gv.id, revision: gv.revision, activation: gv.activation, at: Date.now() }
    record('arm', { id: gv.id, revision: gv.revision })
    return gv
  }

  if (MODE === 'adopt') {
    // 先派子代理 → 再 arm goal（复现探针里 driver 照注入的那条路径）
    await spawnChild('child-adopt')
    armGoal(3)
  } else {
    // 先 arm goal → 立刻派子代理（测 agent/created 抢先路径）
    armGoal(3)
    await spawnChild('child-proactive')
  }

  // 采样 200ms × 60（12s）：覆盖「窗口内」与「结算后」
  for (let i = 0; i < 60; i += 1) {
    const row = { t: Date.now(), goal: goalView(), running: await runningCount() }
    report.samples.push(row)
    flush()
    await new Promise((r) => setTimeout(r, 200))
  }
  await verdict()
}

async function verdict() {
  const v = report.verdict
  const samples = report.samples
  const rounds = report.events.filter((e) => e.channel === 'GOAL_ROUND')
  v.roundsTotal = rounds.length
  v.roundsAfterSpawn = rounds.filter((e) => e.detail.sinceSpawnMs !== null && e.detail.sinceSpawnMs >= 0).length

  // 窗口 = spawn 之后、第一次 running===0 之前的区间
  const firstRunningIdx = samples.findIndex((s) => s.running === 1)
  let windowEndIdx = -1
  if (firstRunningIdx >= 0) {
    for (let i = firstRunningIdx + 1; i < samples.length; i += 1) {
      if (samples[i].running === 0) { windowEndIdx = i; break }
    }
  }
  v.firstRunningAt = firstRunningIdx >= 0 ? samples[firstRunningIdx].t : null
  v.windowEndAt = windowEndIdx >= 0 ? samples[windowEndIdx].t : null

  const disarmEvent = report.events.find((e) => e.channel === 'activation' && e.detail.activation === 'disarmed')
  v.disarmAt = disarmEvent?.t ?? null
  v.disarmSinceSpawnMs = disarmEvent?.detail.sinceSpawnMs ?? null
  const firstRound = rounds[0]
  v.firstRoundSinceSpawnMs = firstRound?.detail.sinceSpawnMs ?? null
  if (disarmEvent && firstRound) v.disarmLeadMs = firstRound.t - disarmEvent.t

  // 窗口内注入数：以 running===1 的采样覆盖区间为准
  const winStart = samples[firstRunningIdx]?.t ?? null
  const winEnd = windowEndIdx >= 0 ? samples[windowEndIdx].t : (samples.at(-1)?.t ?? null)
  v.roundsInWindow = winStart === null ? null : rounds.filter((e) => e.t >= winStart && (winEnd === null || e.t <= winEnd)).length

  // resume：窗口关闭后 activation 是否回到 armed
  const afterWindow = windowEndIdx >= 0 ? samples.slice(windowEndIdx) : []
  v.armedAfterWindow = afterWindow.some((s) => s.goal && s.goal.activation === 'armed')
  const resumeEvent = report.events.find((e) => e.channel === 'activation' && e.detail.activation === 'armed' && (windowEndIdx < 0 || e.t >= winEnd))
  v.resumeAt = resumeEvent?.t ?? null

  v.pass = v.roundsInWindow === 0 && v.disarmAt !== null && v.armedAfterWindow === true
  flush()
}
