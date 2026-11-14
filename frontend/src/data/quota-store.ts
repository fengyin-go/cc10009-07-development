import { reactive } from 'vue'

import { listRows, saveRows } from './local-store'
import type { EntryRow } from './types'

// 站点请求配额的实时状态：生成批次时把限速参数固化成快照，之后改配置只影响下一批，
// 旧批次（含已领取/等待计数）冻结保留原值。状态是模块级 reactive 单例，
// 限速控制页和采集任务页读的是同一份，等待数量天然同步。

export type QuotaParams = {
  ratePerSecond: number // 每秒请求上限（展示用）
  window: number // 并发窗口
  capacity: number // 令牌桶容量
  penalty: number // 惩罚系数
  cooldownSeconds: number // 冷却秒数
  weight: number // 优先级权重
}

export type TokenSlot = {
  id: number
  claimedBy: string | null
}

export type WaitingTask = {
  taskId: string
  jobNo: string
  since: number
  reason: string
}

export type CooldownRecord = {
  id: number
  site: string
  triggeredAt: number
  plannedRecoverAt: number
  recoveredAt: number | null
  reason: string
  status: '冷却中' | '已恢复'
}

export type QuotaBatch = {
  id: number
  batchNo: string
  site: string
  generatedAt: number
  params: QuotaParams // 生成时的参数快照：之后改配置不影响这一批
  quotaTotal: number // 可用次数 = min(令牌桶容量, 并发窗口)
  tokens: TokenSlot[]
  waiting: WaitingTask[]
  cooldownUntil: number | null
  live: boolean // 每个站点只有最新一批可领取，旧批次冻结
  closedAt: number | null
}

export type ClaimResult = {
  ok: boolean
  message: string
  tokenId?: number
  conflict?: boolean // true 表示争抢同一令牌失败
}

type QuotaState = {
  seq: number
  batches: QuotaBatch[]
  cooldowns: CooldownRecord[]
}

const STORAGE_KEY = 'scraper-config-studio:quota'

function loadState(): QuotaState {
  const fallback: QuotaState = { seq: 0, batches: [], cooldowns: [] }
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as QuotaState
    if (!parsed || !Array.isArray(parsed.batches) || !Array.isArray(parsed.cooldowns)) {
      return fallback
    }
    return { seq: Number(parsed.seq) || 0, batches: parsed.batches, cooldowns: parsed.cooldowns }
  } catch {
    return fallback
  }
}

export const quotaState = reactive<QuotaState>(loadState())

function persist(): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ seq: quotaState.seq, batches: quotaState.batches, cooldowns: quotaState.cooldowns }),
  )
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

// 从限速配置行读出配额参数；样例文本等非法值回退到安全默认。
export function paramsFromConfigRow(row: EntryRow): QuotaParams {
  return {
    ratePerSecond: positiveInt(row['每秒请求上限'], 1),
    window: positiveInt(row['并发窗口'], 1),
    capacity: positiveInt(row['令牌桶容量'], 1),
    penalty: Number(row['惩罚系数']) > 0 ? Number(row['惩罚系数']) : 1,
    cooldownSeconds: positiveInt(row['冷却秒数'], 10),
    weight: Number.isFinite(Number(row['优先级权重'])) ? Number(row['优先级权重']) : 0,
  }
}

export function liveBatch(site: string): QuotaBatch | undefined {
  return quotaState.batches.find((batch) => batch.site === site && batch.live)
}

function createBatch(site: string, params: QuotaParams): QuotaBatch {
  const now = Date.now()
  // 冻结同站点的旧批次：旧结果保留原值，不再变动
  for (const batch of quotaState.batches) {
    if (batch.site === site && batch.live) {
      batch.live = false
      batch.closedAt = now
    }
  }
  const quotaTotal = Math.max(1, Math.min(params.capacity, params.window))
  const id = ++quotaState.seq
  const batch: QuotaBatch = {
    id,
    batchNo: `QUOTA-${String(id).padStart(4, '0')}`,
    site,
    generatedAt: now,
    params: { ...params },
    quotaTotal,
    tokens: Array.from({ length: quotaTotal }, (_, i) => ({ id: i + 1, claimedBy: null })),
    waiting: [],
    cooldownUntil: null,
    live: true,
    closedAt: null,
  }
  quotaState.batches.push(batch)
  return batch
}

export function generateQuotaForSite(site: string, params: QuotaParams): QuotaBatch {
  const batch = createBatch(site, params)
  persist()
  return batch
}

// 按目标站点生成请求配额：为每条「已启用」的限速配置生成一个新批次。
export function generateQuotaForEnabled(): { created: number; sites: string[] } {
  const rows = listRows('ratelimit').filter((row) => String(row.status) === '已启用')
  const sites: string[] = []
  for (const row of rows) {
    const site = String(row['目标站点'] ?? '').trim()
    if (!site) {
      continue
    }
    createBatch(site, paramsFromConfigRow(row))
    sites.push(site)
  }
  persist()
  return { created: sites.length, sites }
}

function startCooldown(batch: QuotaBatch, reason: string, now: number): void {
  const until = now + batch.params.cooldownSeconds * 1000
  batch.cooldownUntil = until
  quotaState.cooldowns.push({
    id: ++quotaState.seq,
    site: batch.site,
    triggeredAt: now,
    plannedRecoverAt: until,
    recoveredAt: null,
    reason,
    status: '冷却中',
  })
}

// 冷却结束才允许恢复：补满令牌，等待任务按提交顺序补发；补发后仍有等待则进入下一轮冷却。
// 在冷却秒数耗尽之前调用本函数一律不恢复（禁止提前恢复）。
export function recoverIfDue(site: string, now = Date.now()): boolean {
  const batch = liveBatch(site)
  if (!batch || batch.cooldownUntil === null || now < batch.cooldownUntil) {
    return false
  }
  batch.cooldownUntil = null
  for (const token of batch.tokens) {
    token.claimedBy = null
  }
  const record = quotaState.cooldowns.find((item) => item.site === site && item.status === '冷却中')
  if (record) {
    record.status = '已恢复'
    record.recoveredAt = now
  }
  const queue = [...batch.waiting]
  batch.waiting = []
  for (const task of queue) {
    const slot = batch.tokens.find((token) => token.claimedBy === null)
    if (!slot) {
      batch.waiting.push(task)
      continue
    }
    slot.claimedBy = task.taskId
  }
  if (batch.waiting.length > 0) {
    startCooldown(batch, '令牌耗尽', now)
  }
  persist()
  return true
}

export function recoverAllDue(now = Date.now()): void {
  const sites = new Set(
    quotaState.batches
      .filter((batch) => batch.live && batch.cooldownUntil !== null)
      .map((batch) => batch.site),
  )
  for (const site of sites) {
    recoverIfDue(site, now)
  }
}

// 领取一枚令牌。指定 preferredTokenId 时模拟并发争抢同一令牌：
// 该令牌已被领走则本次失败（同一令牌只允许成功一次），由调用方决定改领还是等待。
export function claimToken(
  site: string,
  taskId: string,
  jobNo: string,
  preferredTokenId?: number,
  now = Date.now(),
): ClaimResult {
  recoverIfDue(site, now)
  const batch = liveBatch(site)
  if (!batch) {
    return { ok: false, message: `站点 ${site} 还没有生成请求配额` }
  }
  if (batch.cooldownUntil !== null) {
    batch.waiting.push({ taskId, jobNo, since: now, reason: '冷却中' })
    persist()
    return { ok: false, message: `${site} 冷却中，任务 ${taskId} 转入等待` }
  }
  let slot: TokenSlot | undefined
  if (preferredTokenId !== undefined) {
    slot = batch.tokens.find((token) => token.id === preferredTokenId)
    if (!slot) {
      return { ok: false, message: `令牌#${preferredTokenId} 不存在` }
    }
    if (slot.claimedBy !== null) {
      return {
        ok: false,
        conflict: true,
        message: `令牌#${preferredTokenId} 已被 ${slot.claimedBy} 领取，同一令牌只允许成功一次`,
      }
    }
  } else {
    slot = batch.tokens.find((token) => token.claimedBy === null)
  }
  if (!slot) {
    batch.waiting.push({ taskId, jobNo, since: now, reason: '令牌耗尽' })
    startCooldown(batch, '令牌耗尽', now)
    persist()
    return {
      ok: false,
      message: `${site} 令牌耗尽，任务 ${taskId} 转入等待，进入冷却 ${batch.params.cooldownSeconds} 秒`,
    }
  }
  slot.claimedBy = taskId
  persist()
  return { ok: true, tokenId: slot.id, message: `任务 ${taskId} 领取令牌#${slot.id} 成功` }
}

// 并发领取演示：taskCount 个任务在同一拍争抢同一枚令牌（当前第一枚空闲令牌），
// 只有第一个能拿到它；争抢失败的任务改领其他空闲令牌，没有则转入等待并触发冷却。
export function concurrentClaim(site: string, taskCount: number, jobNo: string): ClaimResult[] {
  const batch = liveBatch(site)
  if (!batch) {
    return [{ ok: false, message: `站点 ${site} 还没有生成请求配额` }]
  }
  recoverIfDue(site)
  const target = batch.tokens.find((token) => token.claimedBy === null)?.id
  const results: ClaimResult[] = []
  for (let i = 0; i < taskCount; i += 1) {
    const taskId = `${jobNo}-T${i + 1}`
    const first = claimToken(site, taskId, jobNo, target)
    if (first.conflict) {
      results.push(claimToken(site, taskId, jobNo))
    } else {
      results.push(first)
    }
  }
  return results
}

// 参数更新只影响后续生成的配额：已生成批次的快照保持不变。
export function updateConfigParams(configId: number, params: QuotaParams): { ok: boolean; message: string } {
  const rows = listRows('ratelimit')
  const index = rows.findIndex((row) => Number(row.id) === configId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${configId} 的限速配置` }
  }
  const next = [...rows]
  next[index] = {
    ...rows[index],
    每秒请求上限: params.ratePerSecond,
    并发窗口: params.window,
    令牌桶容量: params.capacity,
    惩罚系数: params.penalty,
    冷却秒数: params.cooldownSeconds,
    优先级权重: params.weight,
  }
  saveRows('ratelimit', next)
  return { ok: true, message: '参数已更新，仅影响后续生成的配额，已生成批次保留原快照值' }
}

export function claimedCount(batch: QuotaBatch): number {
  return batch.tokens.filter((token) => token.claimedBy !== null).length
}

export function remainCount(batch: QuotaBatch): number {
  return batch.tokens.filter((token) => token.claimedBy === null).length
}

// 采集任务页用：各站点当前实时批次的等待任务数。
export function waitingCountForSite(site: string): number {
  const batch = liveBatch(site)
  return batch ? batch.waiting.length : 0
}

function downloadCsv(filename: string, header: string[], lines: (string | number)[][]): void {
  const content = `\uFEFF${[header.join(','), ...lines.map((line) => line.join(','))].join('\n')}`
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function timeText(ts: number | null): string {
  return ts === null ? '' : new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

export function exportQuotaCsv(): void {
  const header = ['配额编号', '目标站点', '可用次数', '已领取', '剩余', '等待中', '状态', '令牌桶容量', '并发窗口', '冷却秒数', '优先级权重', '生成时间']
  const lines = quotaState.batches.map((batch) => [
    batch.batchNo,
    batch.site,
    batch.quotaTotal,
    claimedCount(batch),
    remainCount(batch),
    batch.waiting.length,
    batch.live ? (batch.cooldownUntil !== null ? '冷却中' : '可领取') : '已冻结',
    batch.params.capacity,
    batch.params.window,
    batch.params.cooldownSeconds,
    batch.params.weight,
    timeText(batch.generatedAt),
  ])
  downloadCsv('请求配额清单.csv', header, lines)
}

export function exportCooldownCsv(): void {
  const header = ['记录编号', '目标站点', '触发时间', '预计恢复', '实际恢复', '触发原因', '状态']
  const lines = quotaState.cooldowns.map((record) => [
    `CD-${String(record.id).padStart(4, '0')}`,
    record.site,
    timeText(record.triggeredAt),
    timeText(record.plannedRecoverAt),
    timeText(record.recoveredAt),
    record.reason,
    record.status,
  ])
  downloadCsv('冷却记录清单.csv', header, lines)
}
