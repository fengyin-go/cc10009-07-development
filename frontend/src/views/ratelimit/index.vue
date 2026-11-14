<template>
  <section class="page" data-module="ratelimit">
    <header class="page-head">
      <div>
        <h2>限速控制管理</h2>
        <p class="page-desc">维护限速配置的输入、执行约束与结果记录，为限速控制提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记限速配置</button>
        <button class="btn" type="button" @click="exportRows">导出限速控制清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in configStats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>
    <div class="stat-row">
      <article v-for="item in quotaStats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="openEdit(row)">调整参数</button>
            <button class="link" type="button" @click="generateForRow(row)">生成配额</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无限速控制数据，可先登记限速配置</td>
        </tr>
      </tbody>
    </table>

    <div v-if="editingId !== null" class="edit-panel">
      <h3 class="panel-title">调整限速参数（配置编号：{{ editingCode }}）</h3>
      <div class="edit-grid">
        <label>每秒请求上限<input type="number" min="1" v-model.number="editForm.ratePerSecond" /></label>
        <label>并发窗口<input type="number" min="1" v-model.number="editForm.window" /></label>
        <label>令牌桶容量<input type="number" min="1" v-model.number="editForm.capacity" /></label>
        <label>惩罚系数<input type="number" min="0.1" step="0.1" v-model.number="editForm.penalty" /></label>
        <label>冷却秒数<input type="number" min="1" v-model.number="editForm.cooldownSeconds" /></label>
        <label>优先级权重<input type="number" min="0" v-model.number="editForm.weight" /></label>
      </div>
      <div class="edit-actions">
        <button class="btn primary" type="button" @click="saveParams">保存参数</button>
        <button class="btn ghost" type="button" @click="cancelEdit">取消</button>
        <span class="hint">参数更新只影响后续生成的配额批次，已生成批次保留原快照值。</span>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条限速控制记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h3 class="panel-title">请求配额（按目标站点生成）</h3>
          <p class="hint">
            可用次数 = min(令牌桶容量, 并发窗口)；同一令牌并发领取只允许成功一次，令牌耗尽的站点进入冷却，
            冷却秒数内禁止提前恢复，冷却结束令牌补满并按等待顺序补发。
          </p>
        </div>
        <div class="page-actions">
          <button class="btn primary" type="button" @click="generateAll">按已启用站点生成配额</button>
          <button class="btn" type="button" @click="exportQuota">导出配额CSV</button>
        </div>
      </div>

      <div class="filter-bar">
        <label class="filter-item">
          <span>目标站点</span>
          <input v-model="siteFilter" placeholder="按站点过滤，如 W-31" />
        </label>
        <label class="filter-item">
          <span>排序</span>
          <select v-model="sortMode">
            <option value="time">生成时间（新→旧）</option>
            <option value="weightDesc">权重（高→低）</option>
            <option value="weightAsc">权重（低→高）</option>
          </select>
        </label>
        <label class="filter-item">
          <span>并发领取任务数</span>
          <input class="num-input" type="number" min="2" v-model.number="raceCount" />
        </label>
      </div>

      <table class="data-table">
        <thead>
          <tr>
            <th>配额编号</th>
            <th>目标站点</th>
            <th>可用次数</th>
            <th>已领取</th>
            <th>剩余</th>
            <th>等待中</th>
            <th>状态</th>
            <th>桶容量</th>
            <th>并发窗口</th>
            <th>冷却秒数</th>
            <th>权重</th>
            <th>生成时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in pagedBatches" :key="batch.id">
            <td>{{ batch.batchNo }}</td>
            <td>{{ batch.site }}</td>
            <td>{{ batch.quotaTotal }}</td>
            <td>{{ claimedCount(batch) }}</td>
            <td>{{ remainCount(batch) }}</td>
            <td :class="{ 'warn-text': batch.waiting.length > 0 }">{{ batch.waiting.length }}</td>
            <td><span class="badge" :class="badgeClass(batch)">{{ statusLabel(batch) }}</span></td>
            <td>{{ batch.params.capacity }}</td>
            <td>{{ batch.params.window }}</td>
            <td>{{ batch.params.cooldownSeconds }}</td>
            <td>{{ batch.params.weight }}</td>
            <td class="mono">{{ timeLabel(batch.generatedAt) }}</td>
            <td class="row-actions">
              <template v-if="batch.live">
                <button class="link" type="button" @click="claimOnce(batch)">领取令牌</button>
                <button class="link" type="button" @click="claimRace(batch)">并发领取</button>
              </template>
              <span v-else class="hint">已冻结</span>
            </td>
          </tr>
          <tr v-if="!pagedBatches.length">
            <td colspan="13" class="empty-state">暂无请求配额，点击「按已启用站点生成配额」生成</td>
          </tr>
        </tbody>
      </table>

      <div class="pagination">
        <button class="btn" type="button" :disabled="quotaPage <= 1" @click="quotaPage -= 1">上一页</button>
        <button
          v-for="page in quotaPageCount"
          :key="page"
          class="btn"
          :class="{ active: page === quotaPage }"
          type="button"
          @click="quotaPage = page"
        >
          {{ page }}
        </button>
        <button class="btn" type="button" :disabled="quotaPage >= quotaPageCount" @click="quotaPage += 1">下一页</button>
        <span class="hint">共 {{ filteredBatches.length }} 批，每页 {{ quotaPageSize }} 批</span>
      </div>
      <p v-if="quotaNotice" class="hint">{{ quotaNotice }}</p>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h3 class="panel-title">冷却记录</h3>
        <button class="btn" type="button" @click="exportCooldowns">导出冷却记录CSV</button>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>记录编号</th>
            <th>目标站点</th>
            <th>触发时间</th>
            <th>预计恢复</th>
            <th>实际恢复</th>
            <th>触发原因</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in cooldownRows" :key="record.id">
            <td>CD-{{ String(record.id).padStart(4, '0') }}</td>
            <td>{{ record.site }}</td>
            <td class="mono">{{ timeLabel(record.triggeredAt) }}</td>
            <td class="mono">{{ timeLabel(record.plannedRecoverAt) }}</td>
            <td class="mono">{{ record.recoveredAt === null ? '—' : timeLabel(record.recoveredAt) }}</td>
            <td>{{ record.reason }}</td>
            <td>
              <span class="badge" :class="record.status === '冷却中' ? 'cool' : 'ok'">{{ record.status }}</span>
            </td>
          </tr>
          <tr v-if="!cooldownRows.length">
            <td colspan="7" class="empty-state">暂无冷却记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h3 class="panel-title">采集预演（请求配额逐秒核对）</h3>
          <p class="hint">
            令牌桶耗尽即触发冷却，冷却秒数内禁止提前恢复；冷却结束当秒令牌补满。预演结果只读，不影响线上配额。
          </p>
        </div>
      </div>

      <div class="tabs">
        <button class="btn" :class="{ active: rehearsalMode === 'even' }" type="button" @click="rehearsalMode = 'even'">
          均匀分布预演
        </button>
        <button class="btn" :class="{ active: rehearsalMode === 'minute' }" type="button" @click="rehearsalMode = 'minute'">
          按分钟分布预演
        </button>
      </div>

      <form v-if="rehearsalMode === 'even'" class="filter-bar" @submit.prevent="runEvenRehearsal">
        <label class="filter-item"><span>目标站点</span><input v-model="evenForm.site" /></label>
        <label class="filter-item"><span>总访问量</span><input type="number" min="1" v-model.number="evenForm.totalVisits" /></label>
        <label class="filter-item"><span>时长（分钟）</span><input type="number" min="1" v-model.number="evenForm.minutes" /></label>
        <label class="filter-item"><span>令牌桶容量</span><input type="number" min="1" v-model.number="evenForm.capacity" /></label>
        <label class="filter-item"><span>冷却秒数</span><input type="number" min="1" v-model.number="evenForm.cooldownSeconds" /></label>
        <button class="btn primary" type="submit">开始预演</button>
        <button class="btn ghost" type="button" @click="loadEvenPreset">载入W-31预演</button>
      </form>

      <form v-else class="filter-bar" @submit.prevent="runMinuteRehearsal">
        <label class="filter-item"><span>目标站点</span><input v-model="minuteForm.site" /></label>
        <label class="filter-item"><span>窗口开始</span><input v-model="minuteForm.startClock" placeholder="10:00" /></label>
        <label class="filter-item">
          <span>每分钟请求数（逗号分隔）</span>
          <input v-model="minuteForm.perMinuteText" class="wide-input" placeholder="8,20,40,12,3" />
        </label>
        <label class="filter-item"><span>令牌桶容量</span><input type="number" min="1" v-model.number="minuteForm.capacity" /></label>
        <label class="filter-item"><span>冷却秒数</span><input type="number" min="1" v-model.number="minuteForm.cooldownSeconds" /></label>
        <button class="btn primary" type="submit">开始预演</button>
        <button class="btn ghost" type="button" @click="loadMinutePreset">载入窗口预演</button>
      </form>
      <p v-if="rehearsalError" class="error-text">{{ rehearsalError }}</p>

      <template v-if="rehearsal">
        <div class="stat-row">
          <article class="stat-card">
            <span class="stat-label">总到达</span>
            <strong class="stat-value">{{ rehearsal.totalArrivals }}</strong>
          </article>
          <article class="stat-card">
            <span class="stat-label">放行</span>
            <strong class="stat-value">{{ rehearsal.totalGranted }}</strong>
          </article>
          <article class="stat-card">
            <span class="stat-label">等待</span>
            <strong class="stat-value">{{ rehearsal.totalWaiting }}</strong>
          </article>
          <article class="stat-card">
            <span class="stat-label">冷却区间</span>
            <strong class="stat-value">{{ rehearsal.cooldowns.length }}</strong>
          </article>
        </div>

        <h4 class="block-title">分段配额（共 {{ rehearsal.segments.length }} 段）</h4>
        <table class="data-table">
          <thead>
            <tr>
              <th>分段</th>
              <th>区间</th>
              <th>到达</th>
              <th>放行</th>
              <th>等待</th>
              <th>段末令牌</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="segment in rehearsal.segments" :key="segment.index">
              <td>第{{ segment.index }}段</td>
              <td class="mono">{{ secondLabel(segment.fromSecond) }}–{{ secondLabel(segment.toSecond) }}</td>
              <td>{{ segment.arrivals }}</td>
              <td>{{ segment.granted }}</td>
              <td :class="{ 'warn-text': segment.waiting > 0 }">{{ segment.waiting }}</td>
              <td>{{ segment.endTokens }}</td>
            </tr>
          </tbody>
        </table>

        <h4 class="block-title">冷却区间（共 {{ rehearsal.cooldowns.length }} 个）</h4>
        <table class="data-table">
          <thead>
            <tr>
              <th>序号</th>
              <th>冷却区间</th>
              <th>时长</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="cooldown in rehearsal.cooldowns" :key="cooldown.index">
              <td>第{{ cooldown.index }}个</td>
              <td class="mono">{{ secondLabel(cooldown.fromSecond) }} – {{ secondLabel(cooldown.toSecond) }}</td>
              <td>{{ cooldown.toSecond - cooldown.fromSecond }}秒</td>
            </tr>
            <tr v-if="!rehearsal.cooldowns.length">
              <td colspan="3" class="empty-state">本次预演没有触发冷却</td>
            </tr>
          </tbody>
        </table>

        <h4 class="block-title">逐秒配额表（共 {{ rehearsal.seconds.length }} 秒）</h4>
        <table class="data-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>到达</th>
              <th>秒初令牌</th>
              <th>放行</th>
              <th>等待</th>
              <th>冷却中</th>
              <th>秒末令牌</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in pagedSeconds" :key="row.second">
              <td class="mono">{{ secondLabel(row.second) }}</td>
              <td>{{ row.arrivals }}</td>
              <td>{{ row.startTokens }}</td>
              <td>{{ row.granted }}</td>
              <td :class="{ 'warn-text': row.waiting > 0 }">{{ row.waiting }}</td>
              <td>{{ row.inCooldown ? '是' : '否' }}</td>
              <td>{{ row.endTokens }}</td>
            </tr>
          </tbody>
        </table>
        <div class="pagination">
          <button class="btn" type="button" :disabled="secPage <= 1" @click="secPage -= 1">上一页</button>
          <button
            v-for="page in secPageCount"
            :key="page"
            class="btn"
            :class="{ active: page === secPage }"
            type="button"
            @click="secPage = page"
          >
            {{ page }}
          </button>
          <button class="btn" type="button" :disabled="secPage >= secPageCount" @click="secPage += 1">下一页</button>
          <span class="hint">每页 {{ secPageSize }} 秒</span>
        </div>
      </template>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  buildEvenArrivals,
  buildMinuteArrivals,
  formatHms,
  parseClock,
  simulateQuota,
  type RehearsalResult,
} from '@/data/quota-engine'
import {
  claimToken,
  claimedCount,
  concurrentClaim,
  exportCooldownCsv,
  exportQuotaCsv,
  generateQuotaForEnabled,
  generateQuotaForSite,
  paramsFromConfigRow,
  quotaState,
  recoverAllDue,
  remainCount,
  updateConfigParams,
  type QuotaBatch,
  type QuotaParams,
} from '@/data/quota-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('ratelimit')
const columns = ["配置编号", "目标站点", "每秒请求上限", "并发窗口", "令牌桶容量", "惩罚系数", "冷却秒数", "优先级权重"]
const actions = ["提交校验", "启用限速", "停用限速"]
const statuses = ["草稿", "待校验", "已启用", "已停用"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const configStats = computed(() => [
  { label: '限速配置总数', value: rows.value.length },
  { label: '已启用配置', value: rows.value.filter((row) => String(row.status) === '已启用').length },
  { label: '待校验配置', value: rows.value.filter((row) => String(row.status) === '待校验').length },
])

const quotaStats = computed(() => {
  const live = quotaState.batches.filter((batch) => batch.live)
  return [
    { label: '当前剩余配额', value: live.reduce((sum, batch) => sum + remainCount(batch), 0) },
    { label: '等待中任务', value: live.reduce((sum, batch) => sum + batch.waiting.length, 0) },
    { label: '冷却中站点', value: live.filter((batch) => batch.cooldownUntil !== null).length },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// —— 参数调整：只影响后续生成的配额批次 ——
const editingId = ref<number | null>(null)
const editingCode = ref('')
const editForm = ref<QuotaParams>({ ratePerSecond: 1, window: 1, capacity: 1, penalty: 1, cooldownSeconds: 10, weight: 0 })

function openEdit(row: EntryRow) {
  editingId.value = Number(row.id)
  editingCode.value = String(row['配置编号'] ?? '')
  editForm.value = paramsFromConfigRow(row)
}

function cancelEdit() {
  editingId.value = null
}

function saveParams() {
  if (editingId.value === null) {
    return
  }
  const result = updateConfigParams(editingId.value, editForm.value)
  quotaNotice.value = result.message
  editingId.value = null
  reload()
}

// —— 请求配额：生成、领取、过滤、排序、翻页 ——
const quotaNotice = ref('')
const siteFilter = ref('')
const sortMode = ref<'time' | 'weightDesc' | 'weightAsc'>('time')
const raceCount = ref(3)
const quotaPage = ref(1)
const quotaPageSize = 5
let manualSeq = 0

const filteredBatches = computed(() => {
  const keyword = siteFilter.value.trim()
  let list = [...quotaState.batches]
  if (keyword) {
    list = list.filter((batch) => batch.site.includes(keyword))
  }
  if (sortMode.value === 'weightDesc') {
    list.sort((a, b) => b.params.weight - a.params.weight)
  } else if (sortMode.value === 'weightAsc') {
    list.sort((a, b) => a.params.weight - b.params.weight)
  } else {
    list.sort((a, b) => b.generatedAt - a.generatedAt || b.id - a.id)
  }
  return list
})

const quotaPageCount = computed(() => Math.max(1, Math.ceil(filteredBatches.value.length / quotaPageSize)))

const pagedBatches = computed(() => {
  const page = Math.min(quotaPage.value, quotaPageCount.value)
  return filteredBatches.value.slice((page - 1) * quotaPageSize, page * quotaPageSize)
})

watch([siteFilter, sortMode], () => {
  quotaPage.value = 1
})

const nowTs = ref(Date.now())

function statusLabel(batch: QuotaBatch): string {
  if (!batch.live) {
    return '已冻结'
  }
  if (batch.cooldownUntil !== null) {
    const left = Math.max(0, Math.ceil((batch.cooldownUntil - nowTs.value) / 1000))
    return `冷却中 ${left}s`
  }
  return remainCount(batch) === 0 ? '已耗尽' : '可领取'
}

function badgeClass(batch: QuotaBatch): string {
  if (!batch.live) {
    return 'frozen'
  }
  return batch.cooldownUntil !== null ? 'cool' : 'ok'
}

function generateAll() {
  const result = generateQuotaForEnabled()
  quotaNotice.value = result.created > 0
    ? `已为 ${result.created} 个已启用站点生成配额：${result.sites.join('、')}；同站点旧批次已冻结保留原值`
    : '没有已启用的限速配置，无法生成配额'
}

function generateForRow(row: EntryRow) {
  if (String(row.status) !== '已启用') {
    errorMessage.value = `配置 ${row['配置编号']} 尚未启用，不能生成配额`
    return
  }
  const site = String(row['目标站点'] ?? '').trim()
  generateQuotaForSite(site, paramsFromConfigRow(row))
  quotaNotice.value = `已为 ${site} 生成新配额批次（快照：容量${row['令牌桶容量']}、窗口${row['并发窗口']}、冷却${row['冷却秒数']}秒），旧批次已冻结`
}

function claimOnce(batch: QuotaBatch) {
  manualSeq += 1
  const result = claimToken(batch.site, `手动任务-${manualSeq}`, '手动领取')
  quotaNotice.value = result.message
}

function claimRace(batch: QuotaBatch) {
  const count = Math.max(2, Math.floor(Number(raceCount.value)) || 2)
  const results = concurrentClaim(batch.site, count, '并发演示')
  const ok = results.filter((item) => item.ok)
  const tokens = ok.length > 0 ? ok.map((item) => `#${item.tokenId}`).join('、') : '无'
  quotaNotice.value = `${count} 个任务并发领取同一令牌：${ok.length} 个成功（令牌${tokens}，互不重复），${results.length - ok.length} 个转入等待`
}

function exportQuota() {
  exportQuotaCsv()
}

// —— 冷却记录 ——
const cooldownRows = computed(() =>
  [...quotaState.cooldowns].sort((a, b) => b.triggeredAt - a.triggeredAt),
)

function exportCooldowns() {
  exportCooldownCsv()
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

// —— 采集预演 ——
type RehearsalMode = 'even' | 'minute'

const rehearsalMode = ref<RehearsalMode>('even')
const evenForm = ref({ site: 'W-31', totalVisits: 120, minutes: 10, capacity: 20, cooldownSeconds: 15 })
const minuteForm = ref({ site: 'W-31', startClock: '10:00', perMinuteText: '8,20,40,12,3', capacity: 20, cooldownSeconds: 15 })
const rehearsal = ref<RehearsalResult | null>(null)
const rehearsalBase = ref(0)
const rehearsalError = ref('')
const secPage = ref(1)
const secPageSize = 60

function loadEvenPreset() {
  evenForm.value = { site: 'W-31', totalVisits: 120, minutes: 10, capacity: 20, cooldownSeconds: 15 }
  runEvenRehearsal()
}

function loadMinutePreset() {
  minuteForm.value = { site: 'W-31', startClock: '10:00', perMinuteText: '8,20,40,12,3', capacity: 20, cooldownSeconds: 15 }
  runMinuteRehearsal()
}

function runEvenRehearsal() {
  rehearsalError.value = ''
  const form = evenForm.value
  if (!form.site.trim()) {
    rehearsalError.value = '请填写目标站点'
    return
  }
  if (form.totalVisits < 1 || form.minutes < 1 || form.capacity < 1 || form.cooldownSeconds < 1) {
    rehearsalError.value = '访问量、时长、桶容量、冷却秒数都必须是正数'
    return
  }
  const durationSeconds = form.minutes * 60
  rehearsal.value = simulateQuota({
    capacity: form.capacity,
    cooldownSeconds: form.cooldownSeconds,
    arrivals: buildEvenArrivals(form.totalVisits, durationSeconds),
    durationSeconds,
  })
  rehearsalBase.value = 0
  secPage.value = 1
}

function runMinuteRehearsal() {
  rehearsalError.value = ''
  const form = minuteForm.value
  if (!form.site.trim()) {
    rehearsalError.value = '请填写目标站点'
    return
  }
  const base = parseClock(form.startClock)
  if (base === null) {
    rehearsalError.value = '窗口开始时间格式应为 HH:mm，例如 10:00'
    return
  }
  const perMinute = form.perMinuteText.split(/[,，\s]+/).filter(Boolean).map(Number)
  if (perMinute.length === 0 || perMinute.some((n) => !Number.isFinite(n) || n < 0)) {
    rehearsalError.value = '每分钟请求数应为非负整数，用逗号分隔'
    return
  }
  if (form.capacity < 1 || form.cooldownSeconds < 1) {
    rehearsalError.value = '桶容量、冷却秒数都必须是正数'
    return
  }
  rehearsal.value = simulateQuota({
    capacity: form.capacity,
    cooldownSeconds: form.cooldownSeconds,
    arrivals: buildMinuteArrivals(perMinute),
    durationSeconds: perMinute.length * 60,
  })
  rehearsalBase.value = base
  secPage.value = 1
}

const secPageCount = computed(() =>
  rehearsal.value ? Math.max(1, Math.ceil(rehearsal.value.seconds.length / secPageSize)) : 1,
)

const pagedSeconds = computed(() => {
  if (!rehearsal.value) {
    return []
  }
  const page = Math.min(secPage.value, secPageCount.value)
  return rehearsal.value.seconds.slice((page - 1) * secPageSize, page * secPageSize)
})

function secondLabel(offset: number): string {
  return formatHms(rehearsalBase.value + offset)
}

// —— 配置表 ——
function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '限速配置登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '限速控制列表读取失败'
  }
}

let timer: number | undefined

onMounted(() => {
  reload()
  runEvenRehearsal()
  // 每秒推进一次冷却恢复，等待任务补发后，采集任务页的等待数量同步下降
  timer = window.setInterval(() => {
    nowTs.value = Date.now()
    recoverAllDue()
  }, 1000)
})

onBeforeUnmount(() => {
  if (timer !== undefined) {
    window.clearInterval(timer)
  }
})
</script>
