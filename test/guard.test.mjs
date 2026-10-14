/**
 * goal-guard 纯状态机单测。跑的是**编译产物** lib/guard.js —— 先 `npm run build` 再 `npm test`，
 * 否则测的是旧产物。
 *
 *   npm run build && npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GoalGuard, countRunningChildren, isSubagentHeader } from '../lib/guard.js'

const armed = (id = 'g1', revision = 1) => ({ id, revision, phase: 'active', activation: 'armed' })
const disarmed = (id = 'g1', revision = 1) => ({ id, revision, phase: 'active', activation: 'disarmed' })

test('未追踪的 agent 一律不动', () => {
  const g = new GoalGuard()
  assert.equal(g.has('a'), false)
  assert.deepEqual(g.decideAtIdle('a', armed(), 0), { kind: 'none', reason: 'untracked' })
  assert.deepEqual(g.decideAtIdle('a', armed(), 3), { kind: 'none', reason: 'untracked' })
  assert.equal(g.disarmIntent('a', armed())?.goalId, 'g1') // disarmIntent 会纳入视野
  assert.equal(g.has('a'), true)
})

test('disarmIntent 只在 active+armed 时给意图', () => {
  const g = new GoalGuard()
  assert.equal(g.disarmIntent('a', undefined), undefined)
  assert.equal(g.disarmIntent('a', disarmed()), undefined)
  assert.equal(g.disarmIntent('a', { ...armed(), phase: 'paused' }), undefined)
  assert.equal(g.disarmIntent('a', { ...armed(), phase: 'blocked' }), undefined)
  const mark = g.disarmIntent('a', armed('gX', 7))
  assert.deepEqual({ goalId: mark.goalId, revision: mark.revision }, { goalId: 'gX', revision: 7 })
  assert.equal(typeof mark.at, 'number')
})

test('等待窗口：有 running 子代理且 goal armed → disarm（刷新 mark）', () => {
  const g = new GoalGuard()
  g.track('a')
  const dec = g.decideAtIdle('a', armed('g1', 3), 2)
  assert.equal(dec.kind, 'disarm')
  assert.equal(dec.mark.revision, 3)
  assert.equal(g.markOf('a').revision, 3)
  assert.equal(g.guardedCount(), 1)
})

test('等待窗口：有 running 子代理但 goal 已 disarmed → 不接管（可能别人 disarm 的）', () => {
  const g = new GoalGuard()
  g.track('a')
  assert.deepEqual(g.decideAtIdle('a', disarmed(), 1), { kind: 'none', reason: 'children-running' })
  assert.equal(g.markOf('a'), undefined)
  assert.equal(g.guardedCount(), 0)
})

test('结算：无 running + mark 匹配 + active/disarmed → resume', () => {
  const g = new GoalGuard()
  const mark = g.disarmIntent('a', armed('g1', 5))
  g.recordDisarm('a', mark)
  const dec = g.decideAtIdle('a', disarmed('g1', 5), 0)
  assert.equal(dec.kind, 'resume')
  assert.equal(dec.mark.goalId, 'g1')
  assert.equal(dec.mark.revision, 5)
})

test('结算：无 running 但没有 mark → 不 resume（不是我们 disarm 的）', () => {
  const g = new GoalGuard()
  g.track('a')
  assert.deepEqual(g.decideAtIdle('a', disarmed(), 0), { kind: 'none', reason: 'no-mark' })
})

test('结算：毒化后禁止自动 resume', () => {
  const g = new GoalGuard()
  const mark = g.disarmIntent('a', armed())
  g.recordDisarm('a', mark)
  assert.equal(g.poison('a', 'agent/error'), true)
  assert.equal(g.markOf('a'), undefined, '毒化应清掉 mark')
  assert.deepEqual(g.decideAtIdle('a', disarmed(), 0), { kind: 'none', reason: 'poisoned' })
  // 新一次派发（新窗口）清除毒化 = 新授权
  const mark2 = g.disarmIntent('a', armed('g1', 1))
  g.recordDisarm('a', mark2)
  assert.equal(g.decideAtIdle('a', disarmed(), 0).kind, 'resume')
})

test('毒化只在已有 mark 或已毒化时生效', () => {
  const g = new GoalGuard()
  g.track('a')
  assert.equal(g.poison('a', 'agent/error'), false)
  assert.equal(g.poison('nobody', 'agent/error'), false)
})

test('结算：goal 被编辑（revision 变了）→ 清 mark 交人类', () => {
  const g = new GoalGuard()
  const mark = g.disarmIntent('a', armed('g1', 1))
  g.recordDisarm('a', mark)
  const dec = g.decideAtIdle('a', disarmed('g1', 2), 0)
  assert.deepEqual(dec, { kind: 'none', reason: 'goal-changed' })
  assert.equal(g.markOf('a'), undefined)
  assert.equal(g.guardedCount(), 0)
})

test('结算：goal 被清掉 → 清 mark', () => {
  const g = new GoalGuard()
  g.recordDisarm('a', g.disarmIntent('a', armed()))
  assert.deepEqual(g.decideAtIdle('a', undefined, 0), { kind: 'none', reason: 'no-goal' })
  assert.equal(g.markOf('a'), undefined)
})

test('结算：goal 被第三方重新武装 → 结束窗口，不重复 resume', () => {
  const g = new GoalGuard()
  g.recordDisarm('a', g.disarmIntent('a', armed()))
  assert.deepEqual(g.decideAtIdle('a', armed(), 0), { kind: 'none', reason: 'not-disarmed' })
  assert.equal(g.markOf('a'), undefined)
})

test('结算：goal 变成 paused/blocked/complete → 不自动 resume', () => {
  for (const phase of ['paused', 'blocked', 'complete']) {
    const g = new GoalGuard()
    g.recordDisarm('a', g.disarmIntent('a', armed()))
    assert.deepEqual(g.decideAtIdle('a', { id: 'g1', revision: 1, phase, activation: 'disarmed' }, 0), { kind: 'none', reason: 'not-disarmed' })
  }
})

test('clearMark / reset / track 幂等', () => {
  const g = new GoalGuard()
  assert.equal(g.track('a'), true)
  assert.equal(g.track('a'), false)
  g.recordDisarm('a', g.disarmIntent('a', armed()))
  g.clearMark('a')
  assert.equal(g.markOf('a'), undefined)
  assert.equal(g.has('a'), true, 'clearMark 保留追踪状态')
  g.reset('a')
  assert.equal(g.has('a'), false)
})

test('snapshot 报出 mark 与存活时长', () => {
  const g = new GoalGuard()
  g.recordDisarm('a', { goalId: 'g1', revision: 2, at: Date.now() - 5000 })
  g.track('b')
  const snap = g.snapshot()
  const a = snap.find((s) => s.agent === 'a')
  const b = snap.find((s) => s.agent === 'b')
  assert.equal(a.marked, true)
  assert.equal(a.goalId, 'g1')
  assert.equal(a.revision, 2)
  assert.ok(a.sinceMs >= 4900)
  assert.equal(b.marked, false)
  assert.equal(b.sinceMs, null)
  assert.equal(g.guardedCount(), 1)
  assert.equal(g.trackedCount(), 2)
})

test('countRunningChildren 只认 listDescendants 的 child+running 行', () => {
  assert.equal(countRunningChildren(undefined), 0)
  assert.equal(countRunningChildren([]), 0)
  assert.equal(countRunningChildren(null), 0)
  assert.equal(countRunningChildren([{ kind: 'child', activity: 'running', depth: 1 }]), 1)
  assert.equal(countRunningChildren([
    { kind: 'child', activity: 'running', depth: 1 },
    { kind: 'child', activity: 'inactive', depth: 1 },
    { kind: 'child', activity: 'running', depth: 2 },
    { kind: 'diagnostic', activity: 'running', depth: 1 },
    { kind: 'child', depth: 1 },
  ]), 2)
  // listChildren 形状（无 activity）恒为 0 —— 2026-10-03 实测故障
  assert.equal(countRunningChildren([{ kind: 'child' }, { kind: 'child' }]), 0)
})

test('isSubagentHeader 认 origin 与 delegationDepth', () => {
  assert.equal(isSubagentHeader(undefined), false)
  assert.equal(isSubagentHeader({}), false)
  assert.equal(isSubagentHeader({ origin: 'subagent' }), true)
  assert.equal(isSubagentHeader({ delegationDepth: 1 }), true)
  assert.equal(isSubagentHeader({ delegationDepth: 0 }), false)
  assert.equal(isSubagentHeader({ origin: 'user', delegationDepth: 0 }), false)
})

test('端到端时序：派发 disarm → 等待窗口保持 → 结算 resume（一条完整窗口）', () => {
  const g = new GoalGuard()
  // 派发点：母会话 running，goal armed
  const mark = g.disarmIntent('root', armed('g9', 4))
  assert.equal(mark.goalId, 'g9')
  g.recordDisarm('root', mark)
  // 等待窗口内：子代理在跑，goal 保持 disarmed（无动作）
  assert.deepEqual(g.decideAtIdle('root', disarmed('g9', 4), 1), { kind: 'none', reason: 'children-running' })
  // 等待中人类手动 re-arm → 重新 disarm
  const again = g.decideAtIdle('root', armed('g9', 4), 1)
  assert.equal(again.kind, 'disarm')
  g.recordDisarm('root', again.mark)
  // 结算：无 running → resume
  const done = g.decideAtIdle('root', disarmed('g9', 4), 0)
  assert.equal(done.kind, 'resume')
  g.clearMark('root')
  assert.equal(g.guardedCount(), 0)
})
