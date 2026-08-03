<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import type { DirListing } from '@workflows/shared'
import type { AgentStore } from '../composables/useAgent'

/**
 * 添加工作区:目录选择器。
 * 交互即 shell:❯ 提示符面包屑、ls -p 式条目(目录带尾斜杠)、
 * 所有键盘操作汇聚在一个输入框(↑↓ 选择 / Tab 补全 / Enter 进入或确认 / ←·⌫ 上级 / 双击进入)。
 * 目录列表来自服务端(浏览器无法枚举本地目录)。
 */
const props = defineProps<{ agent: AgentStore }>()
const emit = defineEmits<{ close: [] }>()

const listing = ref<DirListing | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const query = ref('')
const selectedName = ref<string | null>(null)
const adding = ref(false)

const inputRef = ref<HTMLInputElement | null>(null)
const listRef = ref<HTMLElement | null>(null)

interface Row {
  name: string
  path: string
  isParent: boolean
  pre: string
  mid: string
  post: string
}

function isWinPath(p: string): boolean {
  return /^[A-Za-z]:/.test(p)
}

function joinPath(base: string, name: string): string {
  if (base.endsWith('\\') || base.endsWith('/')) return base + name
  return base + (isWinPath(base) ? '\\' : '/') + name
}

/** 路径分段(面包屑):每段带完整前缀路径,末段为当前目录 */
const segments = computed<Array<{ label: string; path: string; current: boolean }>>(() => {
  const p = listing.value?.path ?? ''
  if (!p) return []
  const parts = p.split(/[\\/]/).filter(Boolean)
  if (parts.length === 0) return [{ label: '/', path: '/', current: true }]
  const win = isWinPath(p)
  let acc = ''
  return parts.map((part, i) => {
    acc = i === 0 ? (win ? part + '\\' : '/' + part) : acc + (win ? '\\' : '/') + part
    return { label: part, path: acc, current: i === parts.length - 1 }
  })
})

/** 当前目录下匹配查询的子目录(子串匹配,保持自然排序) */
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  const entries = listing.value?.entries ?? []
  if (!q) return entries
  return entries.filter((e) => e.name.toLowerCase().includes(q))
})

/** 列表行:查询为空时顶部有 ../ 行;匹配段高亮(类 fzf) */
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const q = query.value.trim().toLowerCase()
  if (listing.value?.parent && !q) {
    out.push({ name: '..', path: listing.value.parent, isParent: true, pre: '..', mid: '', post: '' })
  }
  for (const e of filtered.value) {
    const name = e.name
    let pre = name
    let mid = ''
    let post = ''
    if (q) {
      const i = name.toLowerCase().indexOf(q)
      if (i !== -1) {
        pre = name.slice(0, i)
        mid = name.slice(i, i + q.length)
        post = name.slice(i + q.length)
      }
    }
    out.push({ name, path: joinPath(listing.value!.path, name), isParent: false, pre, mid, post })
  }
  return out
})

const isCurrentWorkspace = computed(() => {
  const p = listing.value?.path
  return p ? props.agent.workspaces.value.some((w) => w.path === p) : false
})

/* ---------------- 数据加载 ---------------- */

async function fetchListing(dir: string): Promise<DirListing> {
  const qs = dir ? `?path=${encodeURIComponent(dir)}` : ''
  const res = await fetch(`/api/agent/fs/list${qs}`)
  const body = (await res.json().catch(() => ({}))) as { code?: number; message?: string; data?: DirListing }
  if (!res.ok || (body.code !== undefined && body.code !== 0)) {
    throw new Error(body.message ?? `请求失败 (HTTP ${res.status})`)
  }
  return body.data as DirListing
}

async function loadDir(dir: string): Promise<void> {
  loading.value = true
  error.value = null
  query.value = ''
  selectedName.value = null
  try {
    listing.value = await fetchListing(dir)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

/* ---------------- 交互 ---------------- */

function selectRow(name: string | null): void {
  selectedName.value = name
  nextTick(scrollSelectedIntoView)
}

/** 滚动选中行到可视区(jsdom 无 scrollIntoView,需存在性保护) */
function scrollSelectedIntoView(): void {
  const el = listRef.value?.querySelector('[data-selected]')
  if (typeof el?.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
}

/** 输入过滤:有查询时自动选中首个匹配行,无查询时清除选中(Enter 则确认当前目录) */
function onQueryInput(): void {
  if (query.value.trim()) selectRow(rows.value[0]?.name ?? null)
  else selectedName.value = null
}

function move(delta: number): void {
  const r = rows.value
  if (r.length === 0) return
  const idx = r.findIndex((x) => x.name === selectedName.value)
  const next = idx === -1 ? (delta > 0 ? 0 : r.length - 1) : Math.min(r.length - 1, Math.max(0, idx + delta))
  selectRow(r[next].name)
}

/** Tab:把查询补全为首个前缀匹配的目录名;无查询时选中首行 */
function complete(): void {
  if (loading.value) return
  const q = query.value.trim().toLowerCase()
  if (!q) {
    selectRow(rows.value[0]?.name ?? null)
    return
  }
  const match = filtered.value.find((e) => e.name.toLowerCase().startsWith(q))
  if (match) {
    query.value = match.name
    selectedName.value = match.name
    nextTick(scrollSelectedIntoView)
  }
}

function goUp(): void {
  if (listing.value?.parent) void loadDir(listing.value.parent)
}

/** Enter:有选中行则进入该目录;无选中且未在搜索时确认添加当前目录 */
function enterOrConfirm(): void {
  if (loading.value || adding.value) return
  const sel = rows.value.find((r) => r.name === selectedName.value)
  if (sel) {
    void loadDir(sel.path)
  } else if (!query.value.trim()) {
    void confirmAdd()
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      move(1)
      break
    case 'ArrowUp':
      e.preventDefault()
      move(-1)
      break
    case 'Tab':
      e.preventDefault()
      complete()
      break
    case 'Enter':
      e.preventDefault()
      enterOrConfirm()
      break
    case 'Backspace':
    case 'ArrowLeft':
      if (!query.value) {
        e.preventDefault()
        goUp()
      }
      break
    case 'Escape':
      emit('close')
      break
  }
}

async function confirmAdd(): Promise<void> {
  if (!listing.value || adding.value || isCurrentWorkspace.value) return
  adding.value = true
  error.value = null
  try {
    await props.agent.addWorkspace(listing.value.path)
    emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    adding.value = false
  }
}

onMounted(() => {
  inputRef.value?.focus()
  void loadDir('') // 空路径 → 服务端默认用户主目录
})
</script>

<template>
  <div
    class="fixed inset-0 z-50 grid place-items-center bg-ink/80 backdrop-blur-sm"
    @click.self="emit('close')"
  >
    <div class="modal-in w-[620px] max-w-[94vw] border border-edge bg-panel shadow-2xl shadow-black/50">
      <!-- 头部 -->
      <div class="flex items-center justify-between px-4 pb-2 pt-3.5">
        <span class="font-display text-xs font-semibold tracking-[0.2em] text-fg">添加工作区 · SOURCE</span>
        <button
          type="button"
          class="border border-edge px-2 py-0.5 font-mono text-[10px] text-dim transition hover:border-err/50 hover:text-err"
          @click="emit('close')"
        >
          关闭
        </button>
      </div>

      <!-- 面包屑提示符:祖先段可点击跳转,当前段信号色 -->
      <div
        v-if="listing"
        class="flex items-center overflow-x-auto border-b border-edge px-4 py-2 font-mono text-[11px]"
      >
        <span class="mr-2 shrink-0 text-signal">❯</span>
        <template
          v-for="(seg, i) in segments"
          :key="seg.path"
        >
          <button
            v-if="!seg.current"
            type="button"
            class="shrink-0 text-faint transition hover:text-signal"
            @mousedown.prevent
            @click="loadDir(seg.path)"
          >
            {{ seg.label }}
          </button>
          <span
            v-else
            class="shrink-0 text-fg"
          >{{ seg.label }}</span>
          <span
            v-if="i < segments.length - 1"
            class="mx-1 shrink-0 text-faint/50"
          >{{ isWinPath(segments[0].path) ? '\\' : '/' }}</span>
        </template>
      </div>

      <!-- 搜索输入:键盘操作全部汇聚于此 -->
      <div class="px-4 py-3">
        <input
          ref="inputRef"
          v-model="query"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="过滤当前目录 — 输入以搜索"
          class="w-full border border-edge bg-ink px-3 py-2 font-mono text-xs text-fg caret-signal placeholder:text-faint focus:border-signal/60"
          @keydown="onKeydown"
          @input="onQueryInput"
        >
      </div>

      <!-- 条目列表 -->
      <div
        ref="listRef"
        class="h-[264px] overflow-y-auto border-y border-edge bg-ink/40 p-1"
      >
        <p
          v-if="loading"
          class="px-3 py-2.5 font-mono text-[11px] text-faint"
        >
          读取中<span class="animate-[breathe_1.2s_ease-in-out_infinite]">…</span>
        </p>
        <p
          v-else-if="rows.length === 0"
          class="px-3 py-2.5 font-mono text-[11px] text-faint"
        >
          {{ query.trim() ? '无匹配目录' : '空目录 — 可直接确认添加' }}
        </p>
        <button
          v-for="row in rows"
          :key="row.name"
          type="button"
          class="flex w-full items-center gap-1.5 border-l-2 px-3 py-[5px] text-left font-mono text-[11.5px] transition-colors"
          :class="
            row.name === selectedName
              ? 'border-signal bg-signal/[0.07]'
              : 'border-transparent hover:bg-raised'
          "
          :data-selected="row.name === selectedName ? '' : undefined"
          @mousedown.prevent
          @click="selectRow(row.name)"
          @dblclick="loadDir(row.path)"
        >
          <span
            class="truncate"
            :class="
              row.isParent
                ? 'text-faint'
                : row.name.startsWith('.')
                  ? 'text-faint'
                  : row.name === selectedName
                    ? 'text-fg'
                    : 'text-dim'
            "
          >{{ row.pre }}<span
            v-if="row.mid"
            class="text-signal"
          >{{ row.mid }}</span>{{ row.post }}</span>
          <span class="shrink-0 text-wire/70">/</span>
        </button>
      </div>

      <!-- 错误行 -->
      <p
        v-if="error"
        class="border-t border-edge px-4 py-1.5 font-mono text-[10px] text-err"
      >
        ✕ {{ error }}
      </p>

      <!-- 底部:当前路径 + 按键提示 + 确认 -->
      <div class="flex items-end justify-between gap-4 px-4 py-3">
        <div class="min-w-0 flex-1">
          <p
            class="truncate font-mono text-[10px] text-faint"
            :title="listing?.path"
          >
            {{ listing?.path ?? '—' }}
          </p>
          <p class="mt-1 font-mono text-[9px] leading-relaxed text-faint/80">
            {{ query.trim() ? `${filtered.length} 项匹配` : `${listing?.entries.length ?? 0} 项` }}
            · ⏎ 进入选中 · ⇥ 补全 · ↑↓ 选择 · ←/⌫ 上级 · 双击进入
          </p>
        </div>
        <button
          type="button"
          class="shrink-0 border px-4 py-1.5 font-display text-[11px] tracking-widest transition disabled:opacity-40"
          :class="
            isCurrentWorkspace
              ? 'border-ok/50 bg-ok/10 text-ok'
              : 'border-signal/50 bg-signal/10 text-signal hover:bg-signal/20'
          "
          :disabled="adding || !listing || isCurrentWorkspace"
          @click="confirmAdd"
        >
          {{ adding ? '添加中…' : isCurrentWorkspace ? '已在列表中' : '确认添加' }}
        </button>
      </div>
    </div>
  </div>
</template>
