// 配额预演的纯计算引擎：只依赖输入参数，不碰界面与存储，同样的输入永远得到同样的逐秒结果。
//
// 模型约定（由「令牌桶容量 + 冷却秒数」两个参数完全决定）：
// - 令牌桶初始满额，窗口内不做匀速回填；
// - 请求到达时桶空 → 该请求转入等待，并触发冷却；
// - 冷却秒数内禁止提前恢复：只有冷却结束那一秒才补满令牌，之后到达的请求才能继续放行。

export type SecondQuotaRow = {
  second: number // 相对窗口起点的秒数，从 0 开始
  arrivals: number // 这一秒到达的请求数
  startTokens: number // 这一秒开始时（含本秒恢复）的可用令牌
  granted: number // 这一秒放行的请求数
  waiting: number // 这一秒转入等待的请求数
  inCooldown: boolean // 这一秒是否处于冷却中
  endTokens: number // 这一秒结束时的剩余令牌
}

export type QuotaSegment = {
  index: number // 分段序号，从 1 开始
  fromSecond: number // 含
  toSecond: number // 不含
  arrivals: number
  granted: number
  waiting: number
  endTokens: number // 段末剩余令牌
}

export type CooldownInterval = {
  index: number // 冷却区间序号，从 1 开始
  fromSecond: number // 含：触发冷却的那一秒
  toSecond: number // 不含：恢复的那一秒
}

export type RehearsalResult = {
  capacity: number
  cooldownSeconds: number
  durationSeconds: number
  seconds: SecondQuotaRow[]
  segments: QuotaSegment[]
  cooldowns: CooldownInterval[]
  totalArrivals: number
  totalGranted: number
  totalWaiting: number
}

// 把 totalVisits 次访问均匀铺进 durationSeconds 秒：第 k 次落在 floor(k * 时长 / 总数)。
export function buildEvenArrivals(totalVisits: number, durationSeconds: number): number[] {
  if (totalVisits <= 0 || durationSeconds <= 0) {
    return []
  }
  const arrivals: number[] = []
  for (let k = 0; k < totalVisits; k += 1) {
    arrivals.push(Math.floor((k * durationSeconds) / totalVisits))
  }
  return arrivals
}

// 按每分钟请求数铺开：第 m 分钟的第 k 次落在 m*60 + floor(k*60/该分钟总数)。
export function buildMinuteArrivals(perMinute: number[]): number[] {
  const arrivals: number[] = []
  perMinute.forEach((count, minute) => {
    if (count <= 0) {
      return
    }
    for (let k = 0; k < count; k += 1) {
      arrivals.push(minute * 60 + Math.floor((k * 60) / count))
    }
  })
  return arrivals
}

export function simulateQuota(input: {
  capacity: number
  cooldownSeconds: number
  arrivals: number[]
  durationSeconds: number
  segmentSeconds?: number
}): RehearsalResult {
  const { capacity, cooldownSeconds, arrivals, durationSeconds } = input
  const segmentSeconds = input.segmentSeconds ?? 60

  const bySecond = new Map<number, number>()
  for (const t of arrivals) {
    if (t >= 0 && t < durationSeconds) {
      bySecond.set(t, (bySecond.get(t) ?? 0) + 1)
    }
  }

  let tokens = capacity
  let cooldownUntil = -1 // -1 表示不在冷却中
  const seconds: SecondQuotaRow[] = []
  const cooldowns: CooldownInterval[] = []

  for (let s = 0; s < durationSeconds; s += 1) {
    // 冷却结束的这一秒才补满；冷却期间（s < cooldownUntil）一律不恢复
    if (cooldownUntil >= 0 && s >= cooldownUntil) {
      tokens = capacity
      cooldownUntil = -1
    }
    const startTokens = tokens
    const arrivalsNow = bySecond.get(s) ?? 0
    let granted = 0
    let waiting = 0
    for (let i = 0; i < arrivalsNow; i += 1) {
      if (cooldownUntil >= 0) {
        waiting += 1
        continue
      }
      if (tokens > 0) {
        tokens -= 1
        granted += 1
        continue
      }
      // 桶空：请求转入等待，同时触发冷却，冷却秒数内禁止提前恢复
      waiting += 1
      cooldownUntil = s + cooldownSeconds
      cooldowns.push({ index: cooldowns.length + 1, fromSecond: s, toSecond: cooldownUntil })
    }
    seconds.push({
      second: s,
      arrivals: arrivalsNow,
      startTokens,
      granted,
      waiting,
      inCooldown: cooldownUntil >= 0,
      endTokens: tokens,
    })
  }

  const segments: QuotaSegment[] = []
  for (let from = 0; from < durationSeconds; from += segmentSeconds) {
    const to = Math.min(from + segmentSeconds, durationSeconds)
    const rows = seconds.slice(from, to)
    segments.push({
      index: segments.length + 1,
      fromSecond: from,
      toSecond: to,
      arrivals: rows.reduce((sum, row) => sum + row.arrivals, 0),
      granted: rows.reduce((sum, row) => sum + row.granted, 0),
      waiting: rows.reduce((sum, row) => sum + row.waiting, 0),
      endTokens: rows.length > 0 ? rows[rows.length - 1].endTokens : capacity,
    })
  }

  return {
    capacity,
    cooldownSeconds,
    durationSeconds,
    seconds,
    segments,
    cooldowns,
    totalArrivals: seconds.reduce((sum, row) => sum + row.arrivals, 0),
    totalGranted: seconds.reduce((sum, row) => sum + row.granted, 0),
    totalWaiting: seconds.reduce((sum, row) => sum + row.waiting, 0),
  }
}

// 把相对秒数格式化为 mm:ss 或 hh:mm:ss，便于逐秒核对。
export function formatHms(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const pad = (n: number) => String(n).padStart(2, '0')
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return hh > 0 ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`
}

// 解析「HH:mm」或「HH:mm:ss」为当天秒数，非法输入返回 null。
export function parseClock(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim())
  if (!match) {
    return null
  }
  const hour = Number(match[1])
  const minute = Number(match[2])
  const second = match[3] ? Number(match[3]) : 0
  if (hour > 23 || minute > 59 || second > 59) {
    return null
  }
  return hour * 3600 + minute * 60 + second
}
