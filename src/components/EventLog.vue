<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { EventRecord, EventType } from '../ecs/events'
import type { GameSnapshot } from '../game/game'

const props = defineProps<{ snapshot: GameSnapshot }>()

type Tab = 'events' | 'systems' | 'inspector'
const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'events', label: 'Event stream' },
  { id: 'systems', label: 'Systems' },
  { id: 'inspector', label: 'Inspector' },
]
const tab = ref<Tab>('events')
const autoscroll = ref(true)
const listRef = ref<HTMLDivElement | null>(null)

const hidden = ref<Set<EventType>>(new Set<EventType>(['phase']))

const categories: Array<{ label: string; types: EventType[] }> = [
  { label: 'Spawn', types: ['spawn', 'deploy'] },
  { label: 'AI', types: ['target', 'ai', 'path', 'move'] },
  { label: 'Combat', types: ['shot', 'hit', 'miss'] },
  { label: 'Damage', types: ['damage', 'kill', 'explosion'] },
  { label: 'System', types: ['info', 'warn', 'map', 'boot', 'cleanup'] },
  { label: 'Phases', types: ['phase'] },
]

function toggleCategory(types: EventType[]): void {
  const next = new Set(hidden.value)
  const allHidden = types.every((t) => next.has(t))
  for (const t of types) {
    if (allHidden) next.delete(t)
    else next.add(t)
  }
  hidden.value = next
}

function categoryActive(types: EventType[]): boolean {
  return types.some((t) => !hidden.value.has(t))
}

const visible = computed<EventRecord[]>(() =>
  props.snapshot.events.filter((e) => !hidden.value.has(e.type)).slice(-400),
)

const maxTiming = computed(() => {
  let max = 0.0001
  for (const t of props.snapshot.timings) max = Math.max(max, t.ema)
  return max
})

watch(
  () => visible.value.length,
  async () => {
    if (!autoscroll.value || tab.value !== 'events') return
    await nextTick()
    if (listRef.value) listRef.value.scrollTop = listRef.value.scrollHeight
  },
)

function rowClass(event: EventRecord): string {
  return `log-row type-${event.type}${event.team ? ' team-' + event.team : ''}`
}
</script>

<template>
  <section class="eventlog">
    <header class="log-head">
      <div class="tabs">
        <button
          v-for="t in tabs"
          :key="t.id"
          class="tab"
          :class="{ active: tab === t.id }"
          @click="tab = t.id"
        >
          {{ t.label }}
        </button>
      </div>
      <div class="log-filters" v-if="tab === 'events'">
        <button
          v-for="c in categories"
          :key="c.label"
          class="chip"
          :class="{ active: categoryActive(c.types) }"
          @click="toggleCategory(c.types)"
        >
          {{ c.label }}
        </button>
        <label class="toggle"><input type="checkbox" v-model="autoscroll" /> follow</label>
      </div>
    </header>

    <div v-if="tab === 'events'" ref="listRef" class="log-list">
      <div v-for="event in visible" :key="event.seq" :class="rowClass(event)">
        <span class="log-tick">t{{ event.tick }}</span>
        <span class="log-type">{{ event.type }}</span>
        <span class="log-msg">{{ event.msg }}</span>
      </div>
      <div v-if="visible.length === 0" class="log-empty">no events match the current filters</div>
    </div>

    <div v-else-if="tab === 'systems'" class="systems">
      <div v-for="t in snapshot.timings" :key="t.name" class="system-row">
        <span class="system-name">{{ t.name }}</span>
        <span class="system-bar">
          <span class="system-fill" :style="{ width: (t.ema / maxTiming) * 100 + '%' }"></span>
        </span>
        <span class="system-ms">{{ t.ema.toFixed(3) }} ms</span>
      </div>
    </div>

    <div v-else class="inspector">
      <div v-if="snapshot.selected.length === 0" class="log-empty">
        click a piece on the board to inspect it · shift-click to add to the selection
      </div>
      <div v-for="sel in snapshot.selectedLines" :key="sel.entity" class="inspector-entity">
        <div class="inspector-title">#{{ sel.entity }} · {{ sel.kind }}</div>
        <div v-for="line in sel.lines" :key="line.name" class="inspector-row">
          <span class="inspector-key">{{ line.name }}</span>
          <span class="inspector-value">{{ line.value }}</span>
        </div>
      </div>
    </div>
  </section>
</template>
